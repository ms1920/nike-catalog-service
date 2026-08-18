import { describe, expect, it } from 'vitest';
import { ProductService } from '../src/services/product.service.js';
import { InMemoryProductRepository } from '../src/repositories/in-memory-product.repository.js';
import { seedProducts } from '../src/seed/products.js';
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
} from '../src/domain/errors.js';
import {
  availableSizes,
  buildPageMeta,
  formatMoney,
  isInStock,
  totalInventory,
  type NewProduct,
} from '../src/domain/product.js';

/**
 * Service-level tests go through the repository interface, not HTTP. They prove
 * the business rules hold independently of transport — the same guarantees
 * would apply if this service were driven by a queue consumer.
 */
function makeService(): ProductService {
  return new ProductService(new InMemoryProductRepository(seedProducts));
}

const draft: NewProduct = {
  sku: 'NIKE-UNIT-100',
  name: 'Nike Unit Test Trainer',
  brand: 'Nike',
  category: 'Training',
  gender: 'unisex',
  description: 'Fixture.',
  price: { amount: 1_000_000, currency: 'INR' },
  colorway: 'Grey',
  images: [],
  variants: [{ sku: 'NIKE-UNIT-100-9', size: '9', inventory: 3 }],
  tags: ['unit'],
  status: 'active',
};

describe('domain helpers', () => {
  const product = seedProducts[0]!; // Air Max 90: 12 + 7 + 0 + 3

  it('sums inventory across variants', () => {
    expect(totalInventory(product)).toBe(22);
  });

  it('treats a product with any stocked variant as in stock', () => {
    expect(isInStock(product)).toBe(true);
    expect(
      isInStock({
        ...product,
        variants: product.variants.map((v) => ({ ...v, inventory: 0 })),
      }),
    ).toBe(false);
  });

  it('lists only sizes that are actually available', () => {
    expect(availableSizes(product)).toEqual(['8', '9', '11']);
  });

  it('formats paise as rupees', () => {
    expect(formatMoney({ amount: 1_329_500, currency: 'INR' })).toBe('₹13,295.00');
    expect(formatMoney({ amount: 5, currency: 'INR' })).toBe('₹0.05');
  });

  it('groups rupees by lakh, not by thousand', () => {
    // The whole reason formatMoney defaults to en-IN: en-US would render this
    // as ₹150,000.00, which is wrong for an Indian storefront.
    expect(formatMoney({ amount: 15_000_000, currency: 'INR' })).toBe('₹1,50,000.00');
    expect(formatMoney({ amount: 15_000_000, currency: 'INR' }, 'en-US')).toBe(
      '₹150,000.00',
    );
  });

  it('computes page metadata, including the empty case', () => {
    expect(buildPageMeta(10, 1, 4)).toMatchObject({
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });
    expect(buildPageMeta(10, 3, 4)).toMatchObject({
      totalPages: 3,
      hasNext: false,
      hasPrev: true,
    });
    expect(buildPageMeta(0, 1, 20)).toMatchObject({
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
  });
});

describe('ProductService.create', () => {
  it('assigns an id and timestamps', async () => {
    const created = await makeService().create(draft);

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('rejects a duplicate SKU', async () => {
    const service = makeService();
    await expect(service.create({ ...draft, sku: 'NIKE-AM90-001' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('rejects duplicate variant SKUs regardless of case', async () => {
    const service = makeService();
    await expect(
      service.create({
        ...draft,
        variants: [
          { sku: 'A-1', size: '9', inventory: 1 },
          { sku: 'a-1', size: '10', inventory: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ProductService.getById', () => {
  it('throws NotFoundError for an unknown id', async () => {
    await expect(makeService().getById('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not hand out a reference to stored state', async () => {
    const service = makeService();
    const id = seedProducts[0]!.id;

    const first = await service.getById(id);
    first.name = 'MUTATED';
    first.variants[0]!.inventory = 999;

    const second = await service.getById(id);
    expect(second.name).not.toBe('MUTATED');
    expect(second.variants[0]!.inventory).not.toBe(999);
  });
});

describe('ProductService.archive', () => {
  it('sets status to archived rather than deleting', async () => {
    const service = makeService();
    const id = seedProducts[0]!.id;

    const archived = await service.archive(id);
    expect(archived.status).toBe('archived');
    await expect(service.getById(id)).resolves.toBeTruthy();
  });
});

describe('ProductService.adjustInventory', () => {
  const productId = '11111111-1111-4111-8111-111111111101';
  const variantSku = 'NIKE-AM90-001-9'; // 7 in stock

  it('applies a negative delta', async () => {
    const updated = await makeService().adjustInventory(productId, variantSku, -3);
    const variant = updated.variants.find((v) => v.sku === variantSku)!;
    expect(variant.inventory).toBe(4);
  });

  it('throws InsufficientStockError rather than going negative', async () => {
    await expect(
      makeService().adjustInventory(productId, variantSku, -8),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('allows draining stock to exactly zero', async () => {
    const updated = await makeService().adjustInventory(productId, variantSku, -7);
    const variant = updated.variants.find((v) => v.sku === variantSku)!;
    expect(variant.inventory).toBe(0);
  });

  it('rejects a zero or fractional delta', async () => {
    const service = makeService();
    await expect(service.adjustInventory(productId, variantSku, 0)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.adjustInventory(productId, variantSku, 1.5),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not lose updates across concurrent deltas', async () => {
    // The delta contract is what makes this safe: ten parallel -1 operations
    // must land at 7 - 10... which would go negative, so use a stocked variant.
    const service = makeService();
    const bigVariant = 'NIKE-AM90-001-8'; // 12 in stock

    await Promise.all(
      Array.from({ length: 10 }, () => service.adjustInventory(productId, bigVariant, -1)),
    );

    const product = await service.getById(productId);
    const variant = product.variants.find((v) => v.sku === bigVariant)!;
    expect(variant.inventory).toBe(2);
  });

  it('throws NotFoundError for an unknown variant', async () => {
    await expect(
      makeService().adjustInventory(productId, 'NOPE', -1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
