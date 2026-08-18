import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { InMemoryProductRepository } from '../src/repositories/in-memory-product.repository.js';
import { InMemoryUserRepository } from '../src/repositories/user.repository.js';
import { InMemoryCartRepository } from '../src/repositories/cart.repository.js';
import { seedProducts } from '../src/seed/products.js';

export const testConfig: Config = {
  port: 0,
  nodeEnv: 'test',
  apiKey: undefined,
  defaultPageSize: 20,
  maxPageSize: 100,
  // Tests never open the encrypted store — they inject ephemeral repositories —
  // so these are present only to satisfy the Config shape. A test that wrote to
  // a real data file would leak state between runs.
  dataFile: 'data/test-should-never-be-written.json',
  dataKey: 'test-key',
};

/**
 * Builds an app with its own repositories.
 *
 * Every test gets a fresh, independently seeded set, so tests never share state
 * and can run in parallel. `createApp` binds no port, so supertest drives the app
 * in-process.
 */
export function makeApp(overrides: Partial<Config> = {}): Express {
  return createApp({
    config: { ...testConfig, ...overrides },
    repository: new InMemoryProductRepository(seedProducts),
    userRepository: new InMemoryUserRepository(),
    cartRepository: new InMemoryCartRepository(),
  });
}

export interface TestUser {
  token: string;
  id: string;
  email: string;
  auth: [string, string];
}

/**
 * Registers a user and returns its bearer token.
 *
 * The password is long enough to satisfy the 12-character policy — using a short
 * one here would make every test fail on validation rather than on what it means
 * to assert.
 */
export async function signUp(
  app: Express,
  email = 'shopper@example.com',
  password = 'a sufficiently long password',
): Promise<TestUser> {
  const res = await request(app)
    .post('/api/v1/users')
    .send({ email, name: 'Test Shopper', password })
    .expect(201);

  const token: string = res.body.data.token;
  return {
    token,
    id: res.body.data.user.id,
    email: res.body.data.user.email,
    auth: ['authorization', `Bearer ${token}`],
  };
}

/**
 * Cart fixtures.
 *
 * These objects contain *only* wire fields, so `{ ...AIR_MAX_90, quantity: 2 }`
 * produces a valid request body. Expected stock and price live in separate
 * constants rather than on the object: the cart schema is `.strict()`, so any
 * extra property here would be rejected as an unknown field — which is exactly
 * what happened the first time these were written as one combined object.
 */

/** Air Max 90, size 9. */
export const AIR_MAX_90 = {
  productId: '11111111-1111-4111-8111-111111111101',
  variantSku: 'NIKE-AM90-001-9',
} as const;
export const AIR_MAX_90_INVENTORY = 7;
export const AIR_MAX_90_PRICE_PAISE = 1_329_500;

/** Air Jordan 1, size 8. */
export const JORDAN_1 = {
  productId: '11111111-1111-4111-8111-111111111104',
  variantSku: 'JORDAN-AJ1-004-8',
} as const;
export const JORDAN_1_INVENTORY = 2;
export const JORDAN_1_PRICE_PAISE = 1_699_500;

export async function variantInventory(
  app: Express,
  productId: string,
  variantSku: string,
): Promise<number> {
  const res = await request(app).get(`/api/v1/products/${productId}`).expect(200);
  const variant = res.body.data.variants.find((v: { sku: string }) => v.sku === variantSku);
  return variant.inventory;
}

/** Reads a product's current ETag, for conditional updates. */
export async function productEtag(app: Express, id: string): Promise<string> {
  const res = await request(app).get(`/api/v1/products/${id}`).expect(200);
  const etag = res.headers.etag;
  if (!etag) throw new Error(`No ETag returned for product ${id}`);
  return etag;
}

/**
 * PATCHes a product the way a real client must: read it, then send back the ETag
 * in `If-Match`. Wrapped in a helper because every update now needs the round
 * trip, and repeating it inline in a dozen tests would bury what each is asserting.
 */
export async function patchProduct(
  app: Express,
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<request.Response> {
  const etag = await productEtag(app, id);
  return request(app)
    .patch(`/api/v1/products/${id}`)
    .set('if-match', etag)
    .set(headers)
    .send(body);
}
