import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type {
  Facets,
  NewProduct,
  Paginated,
  Product,
  ProductPatch,
  ProductQuery,
} from '../domain/product.js';
import type { ProductRepository } from '../repositories/product.repository.js';

/**
 * Business rules live here — the rules that must hold no matter which client
 * or transport is calling. Shape validation (is `price.amount` an integer?) is
 * handled at the HTTP boundary by Zod; invariants that need to consult stored
 * state (is this SKU already taken?) belong here, because only this layer can
 * see the repository.
 */
export class ProductService {
  constructor(private readonly repo: ProductRepository) {}

  async search(query: ProductQuery): Promise<Paginated<Product>> {
    return this.repo.search(query);
  }

  async facets(query: ProductQuery): Promise<Facets> {
    return this.repo.facets(query);
  }

  async getById(id: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product) throw new NotFoundError('Product', id);
    return product;
  }

  async getBySku(sku: string): Promise<Product> {
    const product = await this.repo.findBySku(sku);
    if (!product) throw new NotFoundError('Product', sku);
    return product;
  }

  async create(input: NewProduct): Promise<Product> {
    if (await this.repo.findBySku(input.sku)) {
      throw new ConflictError(`A product with SKU '${input.sku}' already exists`, {
        sku: input.sku,
      });
    }

    this.assertUniqueVariantSkus(input.variants);

    const now = new Date().toISOString();
    return this.repo.create({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
  }

  async update(id: string, patch: ProductPatch): Promise<Product> {
    if (patch.variants) this.assertUniqueVariantSkus(patch.variants);

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundError('Product', id);
    return updated;
  }

  /**
   * Soft delete. Catalog rows are referenced by orders, analytics, and search
   * indexes, so hard-deleting them would orphan that history. Archiving hides
   * the product from default queries (which filter to `status=active`) while
   * keeping it addressable by id.
   */
  async archive(id: string): Promise<Product> {
    const archived = await this.repo.setStatus(id, 'archived');
    if (!archived) throw new NotFoundError('Product', id);
    return archived;
  }

  /**
   * Applies a signed delta (negative to reserve, positive to restock).
   *
   * Expressing this as a delta rather than "set inventory to N" is what makes
   * it safe under concurrency: two simultaneous -1 reservations correctly leave
   * stock at N-2, whereas two clients that each read N and write N-1 would lose
   * one of the decrements. The repository enforces the non-negative floor.
   */
  async adjustInventory(id: string, variantSku: string, delta: number): Promise<Product> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationError('`delta` must be a non-zero integer', { delta });
    }

    const updated = await this.repo.adjustInventory(id, variantSku, delta);
    if (!updated) {
      throw new NotFoundError('Product variant', `${id}/${variantSku}`);
    }
    return updated;
  }

  private assertUniqueVariantSkus(variants: Product['variants']): void {
    const seen = new Set<string>();
    for (const variant of variants) {
      const key = variant.sku.toLowerCase();
      if (seen.has(key)) {
        throw new ValidationError(`Duplicate variant SKU '${variant.sku}'`, {
          sku: variant.sku,
        });
      }
      seen.add(key);
    }
  }
}
