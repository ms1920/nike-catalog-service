import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { patchProduct, productEtag } from './helpers.js';
import { InMemoryProductRepository } from '../src/repositories/in-memory-product.repository.js';
import { seedProducts } from '../src/seed/products.js';
import type { Config } from '../src/config.js';

const testConfig: Config = {
  port: 0,
  nodeEnv: 'test',
  apiKey: undefined,
  defaultPageSize: 20,
  maxPageSize: 100,
  dataFile: 'data/test-should-never-be-written.json',
  dataKey: 'test-key',
};

/**
 * Each test gets a fresh repository seeded from the same fixture, so tests are
 * order-independent and can run in parallel. `createApp` never binds a port,
 * so supertest drives the app in-process.
 */
function makeApp(overrides: Partial<Config> = {}): Express {
  return createApp({
    config: { ...testConfig, ...overrides },
    repository: new InMemoryProductRepository(seedProducts),
  });
}

type SeedProduct = (typeof seedProducts)[number];

/**
 * Expected counts are derived from the seed rather than hard-coded, so growing
 * the catalog does not turn these into false failures. A test that asserts
 * "Running returns 4" is really asserting a fact about the fixture, not about
 * the filtering logic.
 */
const activeProducts = seedProducts.filter((p) => p.status === 'active');
const draftProducts = seedProducts.filter((p) => p.status === 'draft');
const countActive = (predicate: (p: SeedProduct) => boolean): number =>
  activeProducts.filter(predicate).length;

describe('GET /health and /ready', () => {
  it('reports liveness', async () => {
    const res = await request(makeApp()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports readiness with a catalog count', async () => {
    const res = await request(makeApp()).get('/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ready', products: seedProducts.length });
  });
});

describe('GET /api/v1/products', () => {
  let app: Express;
  beforeEach(() => {
    app = makeApp();
  });

  it('returns only active products by default, hiding drafts', async () => {
    const res = await request(app).get('/api/v1/products').expect(200);

    expect(res.body.pagination.total).toBe(activeProducts.length);
    expect(res.body.data.every((p: { status: string }) => p.status === 'active')).toBe(
      true,
    );
    expect(res.body.data.some((p: { sku: string }) => p.sku === 'NIKE-PROTO-012')).toBe(
      false,
    );
  });

  it('exposes drafts only when explicitly requested', async () => {
    const res = await request(app).get('/api/v1/products?status=draft').expect(200);

    expect(draftProducts.length).toBeGreaterThan(0); // guard: fixture must have a draft
    expect(res.body.pagination.total).toBe(draftProducts.length);
    expect(res.body.data.map((p: { sku: string }) => p.sku)).toEqual(
      expect.arrayContaining(draftProducts.map((p) => p.sku)),
    );
  });

  it('enriches each product with derived read-model fields', async () => {
    const res = await request(app).get('/api/v1/products?q=air max 90').expect(200);
    const product = res.body.data[0];

    expect(product.inStock).toBe(true);
    expect(product.totalInventory).toBe(22); // 12 + 7 + 0 + 3
    expect(product.availableSizes).toEqual(['8', '9', '11']); // size 10 is out of stock
    // 1_329_500 paise, rendered with the Indian rupee symbol.
    expect(product.priceFormatted).toBe('₹13,295.00');
  });

  it('paginates and reports accurate metadata', async () => {
    const res = await request(app).get('/api/v1/products?pageSize=4&page=2').expect(200);

    expect(res.body.data).toHaveLength(4);
    expect(res.body.pagination).toMatchObject({
      page: 2,
      pageSize: 4,
      hasPrev: true,
      hasNext: true,
    });
  });

  it('produces disjoint, stable pages', async () => {
    const [first, second] = await Promise.all([
      request(app).get('/api/v1/products?pageSize=5&page=1&sort=price:asc'),
      request(app).get('/api/v1/products?pageSize=5&page=2&sort=price:asc'),
    ]);

    const firstIds = first.body.data.map((p: { id: string }) => p.id);
    const secondIds = second.body.data.map((p: { id: string }) => p.id);

    expect(firstIds).toHaveLength(5);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(10);
  });

  it('clamps pageSize to the configured maximum', async () => {
    const res = await request(makeApp({ maxPageSize: 5 }))
      .get('/api/v1/products?pageSize=500')
      .expect(200);

    expect(res.body.pagination.pageSize).toBe(5);
  });

  it('filters by category', async () => {
    const res = await request(app)
      .get('/api/v1/products?category=Running&pageSize=100')
      .expect(200);

    expect(res.body.pagination.total).toBe(countActive((p) => p.category === 'Running'));
    expect(res.body.data.every((p: { category: string }) => p.category === 'Running')).toBe(
      true,
    );
  });

  it('ORs multiple values of the same filter', async () => {
    const res = await request(app)
      .get('/api/v1/products?category=Running,Basketball&pageSize=100')
      .expect(200);

    const categories: string[] = res.body.data.map((p: { category: string }) => p.category);
    expect(new Set(categories)).toEqual(new Set(['Running', 'Basketball']));
    expect(res.body.pagination.total).toBe(
      countActive((p) => p.category === 'Running' || p.category === 'Basketball'),
    );
  });

  it('ANDs across different filters', async () => {
    const res = await request(app)
      .get('/api/v1/products?category=Running&gender=women&pageSize=100')
      .expect(200);

    const expected = activeProducts.filter(
      (p) => p.category === 'Running' && p.gender === 'women',
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(res.body.pagination.total).toBe(expected.length);
    expect(res.body.data.map((p: { sku: string }) => p.sku).sort()).toEqual(
      expected.map((p) => p.sku).sort(),
    );
  });

  it('filters by inclusive price range in minor units', async () => {
    // Paise, so this is ₹10,000.00 to ₹15,000.00.
    const min = 1_000_000;
    const max = 1_500_000;
    const res = await request(app)
      .get(`/api/v1/products?minPrice=${min}&maxPrice=${max}&pageSize=100`)
      .expect(200);

    const amounts: number[] = res.body.data.map(
      (p: { price: { amount: number } }) => p.price.amount,
    );
    expect(amounts.length).toBe(
      countActive((p) => p.price.amount >= min && p.price.amount <= max),
    );
    expect(amounts.every((a) => a >= min && a <= max)).toBe(true);
  });

  it('rejects an inverted price range', async () => {
    const res = await request(app)
      .get('/api/v1/products?minPrice=20000&maxPrice=100')
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filters to in-stock products only', async () => {
    const res = await request(app).get('/api/v1/products?inStockOnly=true').expect(200);
    expect(res.body.data.every((p: { inStock: boolean }) => p.inStock)).toBe(true);
  });

  it('combines size filter with in-stock so out-of-stock sizes do not match', async () => {
    // The Dunk Low has a size 6 variant, but with zero inventory.
    const withoutStock = await request(app).get('/api/v1/products?size=6').expect(200);
    expect(
      withoutStock.body.data.some((p: { sku: string }) => p.sku === 'NIKE-DUNKLO-006'),
    ).toBe(true);

    const withStock = await request(app)
      .get('/api/v1/products?size=6&inStockOnly=true')
      .expect(200);
    expect(
      withStock.body.data.some((p: { sku: string }) => p.sku === 'NIKE-DUNKLO-006'),
    ).toBe(false);
  });

  it('ANDs tag filters', async () => {
    const res = await request(app).get('/api/v1/products?tags=running,new').expect(200);

    const skus: string[] = res.body.data.map((p: { sku: string }) => p.sku);
    expect(skus).toContain('NIKE-PEG41-002');
    expect(skus).toContain('NIKE-VAPORFLY3-007');
    expect(skus).not.toContain('NIKE-INVIN3-003'); // has `running` but not `new`
  });

  it('sorts by price ascending and descending', async () => {
    const asc = await request(app).get('/api/v1/products?sort=price:asc').expect(200);
    const amounts: number[] = asc.body.data.map(
      (p: { price: { amount: number } }) => p.price.amount,
    );
    expect([...amounts]).toEqual([...amounts].sort((a, b) => a - b));

    const desc = await request(app).get('/api/v1/products?sort=price:desc').expect(200);
    const descAmounts: number[] = desc.body.data.map(
      (p: { price: { amount: number } }) => p.price.amount,
    );
    expect([...descAmounts]).toEqual([...descAmounts].sort((a, b) => b - a));
  });

  it('rejects an unsupported sort field', async () => {
    const res = await request(app).get('/api/v1/products?sort=discount:asc').expect(400);
    expect(res.body.error.details[0].message).toMatch(/Unsupported sort field/);
  });

  it('rejects unknown query parameters instead of ignoring them', async () => {
    // A typo'd filter that silently returns everything is worse than an error.
    const res = await request(app).get('/api/v1/products?categoryy=Running').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ranks search results by relevance, name matches first', async () => {
    const res = await request(app).get('/api/v1/products?q=pegasus').expect(200);
    expect(res.body.data[0].sku).toBe('NIKE-PEG41-002');
  });

  it('requires every search term to match', async () => {
    const res = await request(app).get('/api/v1/products?q=jordan pegasus').expect(200);
    expect(res.body.pagination.total).toBe(0);
  });

  it('searches case-insensitively across brand and tags', async () => {
    const res = await request(app).get('/api/v1/products?q=JORDAN').expect(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
  });

  it('echoes the resolved query so clients can see applied defaults', async () => {
    const res = await request(app).get('/api/v1/products?q=nike').expect(200);
    expect(res.body.query.sort).toEqual({ field: 'relevance', direction: 'desc' });
    expect(res.body.query.filters.status).toEqual(['active']);
  });
});

describe('GET /api/v1/products/facets', () => {
  it('returns counts over the filtered set', async () => {
    const res = await request(makeApp()).get('/api/v1/products/facets').expect(200);

    const running = res.body.data.categories.find(
      (b: { value: string }) => b.value === 'Running',
    );
    expect(running.count).toBe(countActive((p) => p.category === 'Running'));
    expect(res.body.data.priceRange).toMatchObject({ currency: 'INR' });
  });

  it('reports the price range in paise across the active catalog', async () => {
    const res = await request(makeApp()).get('/api/v1/products/facets').expect(200);

    const amounts = activeProducts.map((p) => p.price.amount);
    expect(res.body.data.priceRange.min).toBe(Math.min(...amounts));
    expect(res.body.data.priceRange.max).toBe(Math.max(...amounts));
  });

  it('narrows facet counts when a filter is applied', async () => {
    const runningCount = countActive((p) => p.category === 'Running');
    const res = await request(makeApp())
      .get('/api/v1/products/facets?category=Running')
      .expect(200);

    expect(res.body.data.categories).toHaveLength(1);
    expect(
      res.body.data.brands.every((b: { count: number }) => b.count <= runningCount),
    ).toBe(true);
  });
});

describe('GET /api/v1/products/:id and /sku/:sku', () => {
  it('fetches by id', async () => {
    const app = makeApp();
    const id = seedProducts[0]!.id;
    const res = await request(app).get(`/api/v1/products/${id}`).expect(200);
    expect(res.body.data.id).toBe(id);
  });

  it('fetches by sku, case-insensitively', async () => {
    const res = await request(makeApp())
      .get('/api/v1/products/sku/nike-am90-001')
      .expect(200);
    expect(res.body.data.sku).toBe('NIKE-AM90-001');
  });

  it('returns a structured 404 with a request id', async () => {
    const res = await request(makeApp()).get('/api/v1/products/does-not-exist').expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });
});

describe('POST /api/v1/products', () => {
  const validBody = {
    sku: 'NIKE-TEST-999',
    name: 'Nike Test Runner',
    brand: 'Nike',
    category: 'Running',
    gender: 'unisex',
    description: 'A product created by the test suite.',
    price: { amount: 1_299_500, currency: 'inr' },
    colorway: 'Test Grey',
    images: ['https://example.com/img/test.jpg'],
    variants: [{ sku: 'NIKE-TEST-999-9', size: '9', inventory: 5 }],
    tags: ['test'],
    status: 'active',
  };

  it('creates a product and returns 201 with a Location header', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send(validBody)
      .expect(201);

    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.price.currency).toBe('INR'); // normalized to uppercase
    expect(res.body.data.priceFormatted).toBe('₹12,995.00');
    expect(res.headers.location).toBe(`/api/v1/products/${res.body.data.id}`);
  });

  it('makes the new product immediately retrievable', async () => {
    const app = makeApp();
    const created = await request(app).post('/api/v1/products').send(validBody).expect(201);

    await request(app).get(`/api/v1/products/${created.body.data.id}`).expect(200);
  });

  it('rejects a duplicate SKU with 409', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send({ ...validBody, sku: 'NIKE-AM90-001' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a non-integer price', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send({ ...validBody, price: { amount: 12995.5, currency: 'INR' } })
      .expect(400);

    expect(res.body.error.details[0].path).toBe('price.amount');
  });

  it('rejects a product with no variants', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send({ ...validBody, variants: [] })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects duplicate variant SKUs', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send({
        ...validBody,
        variants: [
          { sku: 'DUP-1', size: '9', inventory: 1 },
          { sku: 'dup-1', size: '10', inventory: 1 },
        ],
      })
      .expect(400);

    expect(res.body.error.message).toMatch(/Duplicate variant SKU/);
  });

  it('reports every validation failure at once, not just the first', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .send({ ...validBody, name: '', brand: '', gender: 'martian' })
      .expect(400);

    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(makeApp())
      .post('/api/v1/products')
      .set('content-type', 'application/json')
      .send('{"sku": ')
      .expect(400);

    expect(res.body.error.message).toMatch(/not valid JSON/);
  });
});

describe('PATCH /api/v1/products/:id', () => {
  it('applies a partial update and bumps updatedAt', async () => {
    const app = makeApp();
    const target = seedProducts[0]!;

    const res = await patchProduct(app, target.id, {
      price: { amount: 9999, currency: 'INR' },
    });
    expect(res.status).toBe(200);

    expect(res.body.data.price.amount).toBe(9999);
    expect(res.body.data.name).toBe(target.name); // untouched
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(target.updatedAt).getTime(),
    );
  });

  it('rejects an empty patch body', async () => {
    const app = makeApp();
    const res = await patchProduct(app, seedProducts[0]!.id, {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores an attempt to change the immutable SKU', async () => {
    const app = makeApp();
    const target = seedProducts[0]!;

    const res = await patchProduct(app, target.id, { sku: 'HIJACKED', name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.sku).toBe(target.sku);
    expect(res.body.data.name).toBe('Renamed');
  });

  it('404s on an unknown id', async () => {
    await request(makeApp())
      .patch('/api/v1/products/11111111-1111-4111-8111-000000000000')
      .set('if-match', '*')
      .send({ name: 'Nope' })
      .expect(404);
  });
});

describe('optimistic concurrency on update', () => {
  it('returns a strong ETag on GET', async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/v1/products/${seedProducts[0]!.id}`)
      .expect(200);

    expect(res.headers.etag).toMatch(/^"[a-f0-9]{24}"$/);
  });

  it('serves 304 for an unchanged product', async () => {
    const app = makeApp();
    const id = seedProducts[0]!.id;
    const etag = await productEtag(app, id);

    await request(app).get(`/api/v1/products/${id}`).set('if-none-match', etag).expect(304);
  });

  it('rejects a PATCH with no If-Match', async () => {
    // The header is required, not optional. Optional means the unsafe path is the
    // default and every client that forgets silently gets last-write-wins.
    const res = await request(makeApp())
      .patch(`/api/v1/products/${seedProducts[0]!.id}`)
      .send({ name: 'No precondition' })
      .expect(428);

    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('rejects a PATCH whose If-Match is stale', async () => {
    const app = makeApp();
    const id = seedProducts[0]!.id;
    const stale = await productEtag(app, id);

    // Someone else lands a change first.
    await patchProduct(app, id, { name: 'First writer wins' });

    const res = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', stale)
      .send({ name: 'Second writer clobbers' })
      .expect(412);

    expect(res.body.error.code).toBe('PRECONDITION_FAILED');

    // The first writer's change survived — this is the lost update being prevented.
    const after = await request(app).get(`/api/v1/products/${id}`).expect(200);
    expect(after.body.data.name).toBe('First writer wins');
  });

  it('accepts If-Match: * as an explicit blind overwrite', async () => {
    const app = makeApp();
    await request(app)
      .patch(`/api/v1/products/${seedProducts[0]!.id}`)
      .set('if-match', '*')
      .send({ name: 'Deliberate overwrite' })
      .expect(200);
  });

  it('changes the ETag after a successful update', async () => {
    const app = makeApp();
    const id = seedProducts[0]!.id;
    const before = await productEtag(app, id);

    const res = await patchProduct(app, id, { name: 'Renamed for etag' });
    expect(res.status).toBe(200);

    expect(res.headers.etag).toBeTruthy();
    expect(res.headers.etag).not.toBe(before);
  });

  it('tolerates a weak validator prefix and missing quotes', async () => {
    const app = makeApp();
    const id = seedProducts[0]!.id;
    const etag = (await productEtag(app, id)).replace(/"/g, '');

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', `W/"${etag}"`)
      .send({ name: 'Weak validator accepted' })
      .expect(200);
  });
});

describe('DELETE /api/v1/products/:id', () => {
  it('soft-deletes by archiving and removes it from default listings', async () => {
    const app = makeApp();
    const target = seedProducts[0]!;

    const res = await request(app).delete(`/api/v1/products/${target.id}`).expect(200);
    expect(res.body.data.status).toBe('archived');

    const listing = await request(app).get('/api/v1/products').expect(200);
    expect(listing.body.data.some((p: { id: string }) => p.id === target.id)).toBe(false);

    // Still addressable directly — history is preserved, not destroyed.
    await request(app).get(`/api/v1/products/${target.id}`).expect(200);
  });
});

describe('POST /api/v1/products/:id/variants/:sku/inventory', () => {
  const productId = '11111111-1111-4111-8111-111111111101';
  const variantSku = 'NIKE-AM90-001-9'; // inventory: 7

  it('decrements inventory on reservation', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/products/${productId}/variants/${variantSku}/inventory`)
      .send({ delta: -2 })
      .expect(200);

    const variant = res.body.data.variants.find(
      (v: { sku: string }) => v.sku === variantSku,
    );
    expect(variant.inventory).toBe(5);
  });

  it('increments inventory on restock', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/products/${productId}/variants/${variantSku}/inventory`)
      .send({ delta: 10 })
      .expect(200);

    const variant = res.body.data.variants.find(
      (v: { sku: string }) => v.sku === variantSku,
    );
    expect(variant.inventory).toBe(17);
  });

  it('refuses to oversell and reports what was available', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/products/${productId}/variants/${variantSku}/inventory`)
      .send({ delta: -99 })
      .expect(409);

    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toMatchObject({ requested: 99, available: 7 });
  });

  it('applies sequential deltas without losing updates', async () => {
    const app = makeApp();
    const url = `/api/v1/products/${productId}/variants/${variantSku}/inventory`;

    for (let i = 0; i < 5; i += 1) {
      await request(app).post(url).send({ delta: -1 }).expect(200);
    }

    const res = await request(app).get(`/api/v1/products/${productId}`).expect(200);
    const variant = res.body.data.variants.find(
      (v: { sku: string }) => v.sku === variantSku,
    );
    expect(variant.inventory).toBe(2); // 7 - 5
  });

  it('rejects a zero delta', async () => {
    await request(makeApp())
      .post(`/api/v1/products/${productId}/variants/${variantSku}/inventory`)
      .send({ delta: 0 })
      .expect(400);
  });

  it('404s on an unknown variant', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/products/${productId}/variants/NOPE-1/inventory`)
      .send({ delta: -1 })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('API key enforcement', () => {
  const secured = () => makeApp({ apiKey: 'test-secret' });

  it('allows reads without a key', async () => {
    await request(secured()).get('/api/v1/products').expect(200);
  });

  it('rejects writes without a key', async () => {
    const res = await request(secured())
      .delete(`/api/v1/products/${seedProducts[0]!.id}`)
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects writes with a wrong key', async () => {
    await request(secured())
      .delete(`/api/v1/products/${seedProducts[0]!.id}`)
      .set('x-api-key', 'wrong')
      .expect(401);
  });

  it('allows writes with the correct key', async () => {
    await request(secured())
      .delete(`/api/v1/products/${seedProducts[0]!.id}`)
      .set('x-api-key', 'test-secret')
      .expect(200);
  });
});

describe('unmatched routes', () => {
  it('returns a structured 404', async () => {
    const res = await request(makeApp()).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
