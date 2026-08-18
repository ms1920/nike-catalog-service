import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { availableFor, newHold, holdIsActive, HOLD_TTL_MS } from '../src/domain/cart.js';
import {
  AIR_MAX_90,
  AIR_MAX_90_INVENTORY,
  JORDAN_1,
  JORDAN_1_INVENTORY,
  makeApp,
  signUp,
  variantInventory,
} from './helpers.js';

describe('hold arithmetic', () => {
  const base = newHold('alice', 'p1', 'v1', 2, new Date('2026-01-01T00:00:00Z'));

  it('counts other users holds against availability', () => {
    expect(availableFor('bob', 5, [base], new Date('2026-01-01T00:05:00Z'))).toBe(3);
  });

  it('does not count a users own hold against them', () => {
    // Their own hold *is* the line they are looking at; counting it would make a
    // cart appear to compete with itself.
    expect(availableFor('alice', 5, [base], new Date('2026-01-01T00:05:00Z'))).toBe(5);
  });

  it('ignores expired holds', () => {
    const after = new Date(Date.parse('2026-01-01T00:00:00Z') + HOLD_TTL_MS + 1000);
    expect(holdIsActive(base, after)).toBe(false);
    expect(availableFor('bob', 5, [base], after)).toBe(5);
  });

  it('never reports negative availability', () => {
    const holds = [newHold('a', 'p', 'v', 4), newHold('b', 'p', 'v', 4)];
    expect(availableFor('c', 5, holds)).toBe(0);
  });
});

describe('inventory holds across users', () => {
  it('reserves stock as soon as an item enters a cart', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');

    // Alice takes both of the two available.
    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...JORDAN_1, quantity: JORDAN_1_INVENTORY })
      .expect(201);

    // On-hand stock is untouched — holds are a claim, not a decrement.
    expect(await variantInventory(app, JORDAN_1.productId, JORDAN_1.variantSku)).toBe(
      JORDAN_1_INVENTORY,
    );

    // But Bob cannot claim any of it.
    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(409);

    expect(res.body.error.details.available).toBe(0);
    expect(res.body.error.message).toMatch(/reserved in other carts/);
  });

  it('reports availability net of other carts', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice2@example.com');
    const bob = await signUp(app, 'bob2@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 3 })
      .expect(201);

    const bobAdd = await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    // Bob sees 7 on hand minus Alice's 3 = 4.
    expect(bobAdd.body.data.lines[0].availableInventory).toBe(AIR_MAX_90_INVENTORY - 3);

    // Alice sees 7 minus Bob's 1 = 6. Her own 3 are not counted against her —
    // if they were, she would see 3 and appear to compete with her own cart.
    const aliceCart = await request(app)
      .get('/api/v1/cart')
      .set(...alice.auth)
      .expect(200);
    expect(aliceCart.body.data.lines[0].availableInventory).toBe(AIR_MAX_90_INVENTORY - 1);
  });

  it('releases the hold when the line is removed', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice3@example.com');
    const bob = await signUp(app, 'bob3@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...JORDAN_1, quantity: JORDAN_1_INVENTORY })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(409);

    // Stock a shopper explicitly gives up should be back on sale at once, not
    // after the TTL.
    await request(app)
      .delete(`/api/v1/cart/items/${JORDAN_1.variantSku}`)
      .set(...alice.auth)
      .expect(200);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);
  });

  it('releases every hold when the cart is emptied', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice4@example.com');
    const bob = await signUp(app, 'bob4@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...JORDAN_1, quantity: JORDAN_1_INVENTORY })
      .expect(201);
    await request(app)
      .delete('/api/v1/cart')
      .set(...alice.auth)
      .expect(200);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...JORDAN_1, quantity: JORDAN_1_INVENTORY })
      .expect(201);
  });

  it('shrinks a hold when the quantity is reduced', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice5@example.com');
    const bob = await signUp(app, 'bob5@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 7 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(409);

    await request(app)
      .patch(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...alice.auth)
      .send({ quantity: 2 })
      .expect(200);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...AIR_MAX_90, quantity: 5 })
      .expect(201);
  });

  it('frees the hold after checkout and decrements real stock', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice6@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...alice.auth)
      .expect(201);

    // The claim became a real decrement, not both.
    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY - 2,
    );

    const bob = await signUp(app, 'bob6@example.com');
    const bobAdd = await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    expect(bobAdd.body.data.lines[0].availableInventory).toBe(AIR_MAX_90_INVENTORY - 2);
  });
});

describe('checkout idempotency', () => {
  const KEY = 'idem-key-0000000001';

  it('returns the original order when the same key is replayed', async () => {
    const app = makeApp();
    const user = await signUp(app, 'idem@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    const first = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', KEY)
      .expect(201);

    const second = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', KEY)
      .expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);

    // And critically: stock moved once, not twice.
    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY - 2,
    );

    const orders = await request(app)
      .get('/api/v1/cart/orders')
      .set(...user.auth)
      .expect(200);
    expect(orders.body.data).toHaveLength(1);
  });

  it('places a second order for a different key', async () => {
    const app = makeApp();
    const user = await signUp(app, 'idem2@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    const first = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', 'key-aaaaaaaa')
      .expect(201);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    const second = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', 'key-bbbbbbbb')
      .expect(201);

    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('rejects a reused key describing a different cart', async () => {
    // Replaying the old order here would hide a real client bug.
    const app = makeApp();
    const user = await signUp(app, 'idem3@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', KEY)
      .expect(201);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', KEY)
      .expect(409);

    expect(res.body.error.message).toMatch(/already used for a different cart/);
  });

  it('scopes keys per user', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'idemA@example.com');
    const bob = await signUp(app, 'idemB@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    const aliceOrder = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...alice.auth)
      .set('idempotency-key', KEY)
      .expect(201);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    const bobOrder = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...bob.auth)
      .set('idempotency-key', KEY)
      .expect(201);

    // Same key, different users — Bob must not receive Alice's order.
    expect(bobOrder.body.data.id).not.toBe(aliceOrder.body.data.id);
    expect(bobOrder.body.data.userId).not.toBe(aliceOrder.body.data.userId);
  });

  it('rejects an implausibly short key', async () => {
    const app = makeApp();
    const user = await signUp(app, 'idem4@example.com');
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .set('idempotency-key', 'short')
      .expect(400);
  });

  it('still works with no key at all', async () => {
    const app = makeApp();
    const user = await signUp(app, 'idem5@example.com');
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(201);
  });
});
