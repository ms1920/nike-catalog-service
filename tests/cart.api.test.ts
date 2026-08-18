import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  AIR_MAX_90,
  AIR_MAX_90_INVENTORY,
  AIR_MAX_90_PRICE_PAISE,
  JORDAN_1,
  JORDAN_1_INVENTORY,
  JORDAN_1_PRICE_PAISE,
  makeApp,
  patchProduct,
  signUp,
  variantInventory,
} from './helpers.js';

describe('cart authentication', () => {
  it('requires a token on every cart route', async () => {
    // One persistent agent rather than seven `request(app)` calls. Each bare
    // call binds its own ephemeral server, and seven of those in a single test —
    // while other files are hashing passwords in parallel — was enough to make
    // this flake with a spurious 426 roughly once in fifty runs. The agent keeps
    // a single server for all seven requests.
    const agent = request.agent(makeApp());

    await agent.get('/api/v1/cart').expect(401);
    await agent.post('/api/v1/cart/items').send({}).expect(401);
    await agent.patch('/api/v1/cart/items/x').send({ quantity: 1 }).expect(401);
    await agent.delete('/api/v1/cart/items/x').expect(401);
    await agent.delete('/api/v1/cart').expect(401);
    await agent.post('/api/v1/cart/checkout').expect(401);
    await agent.get('/api/v1/cart/orders').expect(401);
  });
});

describe('GET /api/v1/cart', () => {
  it('starts empty for a new user', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .get('/api/v1/cart')
      .set(...user.auth)
      .expect(200);
    expect(res.body.data).toMatchObject({
      lines: [],
      itemCount: 0,
      lineCount: 0,
      hasIssues: false,
    });
    expect(res.body.data.subtotal.amount).toBe(0);
  });
});

describe('POST /api/v1/cart/items', () => {
  it('adds a line and prices it from the catalog', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    expect(res.body.data.lineCount).toBe(1);
    expect(res.body.data.itemCount).toBe(2);
    expect(res.body.data.subtotal.amount).toBe(AIR_MAX_90_PRICE_PAISE * 2);
    expect(res.body.data.subtotalFormatted).toBe('₹26,590.00');

    const line = res.body.data.lines[0];
    expect(line).toMatchObject({ size: '9', name: 'Nike Air Max 90', quantity: 2 });
    expect(line.availableInventory).toBe(AIR_MAX_90_INVENTORY);
    expect(line.exceedsStock).toBe(false);
  });

  it('merges a repeat add into the existing line rather than duplicating it', async () => {
    // Two rows for one variant is a classic cart bug: the item shows twice and
    // per-line caps become trivially bypassable.
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);
    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 3 })
      .expect(201);

    expect(res.body.data.lineCount).toBe(1);
    expect(res.body.data.itemCount).toBe(5);
  });

  it('keeps different variants as separate lines', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    expect(res.body.data.lineCount).toBe(2);
    expect(res.body.data.subtotal.amount).toBe(
      AIR_MAX_90_PRICE_PAISE + JORDAN_1_PRICE_PAISE,
    );
  });

  it('defaults quantity to 1', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ productId: AIR_MAX_90.productId, variantSku: AIR_MAX_90.variantSku })
      .expect(201);

    expect(res.body.data.itemCount).toBe(1);
  });

  it('refuses to add more than is in stock', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: JORDAN_1_INVENTORY + 1 })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toMatchObject({ available: JORDAN_1_INVENTORY });
  });

  it('counts the existing quantity when checking stock on a repeat add', async () => {
    // 2 then 1 must fail against 2 in stock, even though each request alone fits.
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 2 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(409);
  });

  it('rejects a quantity above the per-line cap at the schema', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 50 })
      .expect(400);

    expect(res.body.error.details[0].message).toMatch(/at most 10/);
  });

  it('rejects a zero or fractional quantity', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 0 })
      .expect(400);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1.5 })
      .expect(400);
  });

  it('404s on an unknown product or variant', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ productId: 'nope', variantSku: AIR_MAX_90.variantSku, quantity: 1 })
      .expect(404);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ productId: AIR_MAX_90.productId, variantSku: 'NOPE-1', quantity: 1 })
      .expect(404);
  });

  it('rejects unknown body fields', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1, unitPrice: 1 })
      .expect(400);
  });

  it('does not reserve inventory when adding to the cart', async () => {
    // Deliberate policy: stock moves at checkout, not on add. Holding stock in
    // carts needs a TTL to release abandoned ones, which is out of scope.
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 3 })
      .expect(201);

    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY,
    );
  });
});

describe('PATCH /api/v1/cart/items/:variantSku', () => {
  it('sets an absolute quantity', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...user.auth)
      .send({ quantity: 5 })
      .expect(200);

    expect(res.body.data.itemCount).toBe(5);
  });

  it('removes the line when set to zero', async () => {
    // Lets a quantity stepper reach zero without a separate DELETE call.
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...user.auth)
      .send({ quantity: 0 })
      .expect(200);

    expect(res.body.data.lineCount).toBe(0);
  });

  it('refuses a quantity beyond stock', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    await request(app)
      .patch(`/api/v1/cart/items/${JORDAN_1.variantSku}`)
      .set(...user.auth)
      .send({ quantity: JORDAN_1_INVENTORY + 1 })
      .expect(409);
  });

  it('404s on a variant that is not in the cart', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .patch(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...user.auth)
      .send({ quantity: 1 })
      .expect(404);
  });
});

describe('DELETE cart routes', () => {
  it('removes a single line', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    const res = await request(app)
      .delete(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...user.auth)
      .expect(200);

    expect(res.body.data.lineCount).toBe(1);
    expect(res.body.data.lines[0].variantSku).toBe(JORDAN_1.variantSku);
  });

  it('404s removing a line that is not there', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .delete('/api/v1/cart/items/NOT-IN-CART')
      .set(...user.auth)
      .expect(404);
  });

  it('clears the whole cart', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    const res = await request(app)
      .delete('/api/v1/cart')
      .set(...user.auth)
      .expect(200);
    expect(res.body.data.lineCount).toBe(0);
  });
});

describe('POST /api/v1/cart/checkout', () => {
  it('decrements inventory, records the order and empties the cart', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 3 })
      .expect(201);

    const res = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(201);

    expect(res.body.data.itemCount).toBe(3);
    expect(res.body.data.total.amount).toBe(AIR_MAX_90_PRICE_PAISE * 3);
    expect(res.body.data.totalFormatted).toBe('₹39,885.00');

    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY - 3,
    );

    const cart = await request(app)
      .get('/api/v1/cart')
      .set(...user.auth)
      .expect(200);
    expect(cart.body.data.lineCount).toBe(0);
  });

  it('captures the unit price at purchase time', async () => {
    // An order records what the customer agreed to pay, so a later catalog price
    // change must not rewrite history.
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    const order = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(201);
    expect(order.body.data.lines[0].unitPrice.amount).toBe(AIR_MAX_90_PRICE_PAISE);

    const repriced = await patchProduct(app, AIR_MAX_90.productId, {
      price: { amount: 100, currency: 'INR' },
    });
    expect(repriced.status).toBe(200);

    const orders = await request(app)
      .get('/api/v1/cart/orders')
      .set(...user.auth)
      .expect(200);
    expect(orders.body.data[0].lines[0].unitPrice.amount).toBe(AIR_MAX_90_PRICE_PAISE);
  });

  it('decrements every line of a multi-line cart', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(201);

    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY - 2,
    );
    expect(await variantInventory(app, JORDAN_1.productId, JORDAN_1.variantSku)).toBe(
      JORDAN_1_INVENTORY - 1,
    );
  });

  it('refuses an empty cart', async () => {
    const app = makeApp();
    const user = await signUp(app);

    const res = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(400);
    expect(res.body.error.message).toMatch(/empty cart/i);
  });

  it('refuses checkout when stock dropped after the item was added, leaving inventory untouched', async () => {
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 2 })
      .expect(201);

    // Someone else buys the stock out from under them.
    await request(app)
      .post(
        `/api/v1/products/${JORDAN_1.productId}/variants/${JORDAN_1.variantSku}/inventory`,
      )
      .send({ delta: -2 })
      .expect(200);

    const res = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // Validation happens before any mutation, so nothing was decremented.
    expect(await variantInventory(app, JORDAN_1.productId, JORDAN_1.variantSku)).toBe(0);

    // And the cart survives, so the shopper can fix it.
    const cart = await request(app)
      .get('/api/v1/cart')
      .set(...user.auth)
      .expect(200);
    expect(cart.body.data.lineCount).toBe(1);
    expect(cart.body.data.hasIssues).toBe(true);
    expect(cart.body.data.lines[0].exceedsStock).toBe(true);
  });

  it('refuses checkout of an archived product', async () => {
    const app = makeApp();
    const user = await signUp(app);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    await request(app).delete(`/api/v1/products/${AIR_MAX_90.productId}`).expect(200);

    const res = await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(409);
    expect(res.body.error.message).toMatch(/no longer available/i);
  });

  it('does not decrement the first line when a later line fails', async () => {
    // The compensating-rollback path. Line 1 is fine, line 2 is not; line 1 must
    // not be left silently decremented.
    const app = makeApp();
    const user = await signUp(app);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/items')
      .set(...user.auth)
      .send({ ...JORDAN_1, quantity: 2 })
      .expect(201);

    await request(app)
      .post(
        `/api/v1/products/${JORDAN_1.productId}/variants/${JORDAN_1.variantSku}/inventory`,
      )
      .send({ delta: -2 })
      .expect(200);

    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...user.auth)
      .expect(409);

    expect(await variantInventory(app, AIR_MAX_90.productId, AIR_MAX_90.variantSku)).toBe(
      AIR_MAX_90_INVENTORY,
    );
  });
});

describe('cart isolation between users', () => {
  it("keeps each user's cart entirely separate", async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 2 })
      .expect(201);

    const bobCart = await request(app)
      .get('/api/v1/cart')
      .set(...bob.auth)
      .expect(200);
    expect(bobCart.body.data.lineCount).toBe(0);

    await request(app)
      .post('/api/v1/cart/items')
      .set(...bob.auth)
      .send({ ...JORDAN_1, quantity: 1 })
      .expect(201);

    const aliceCart = await request(app)
      .get('/api/v1/cart')
      .set(...alice.auth)
      .expect(200);
    expect(aliceCart.body.data.lineCount).toBe(1);
    expect(aliceCart.body.data.lines[0].variantSku).toBe(AIR_MAX_90.variantSku);
  });

  it("cannot remove an item from another user's cart", async () => {
    // There is no addressable /carts/:userId at all — the user id comes only from
    // the token — so this fails as "not in *your* cart".
    const app = makeApp();
    const alice = await signUp(app, 'alice2@example.com');
    const bob = await signUp(app, 'bob2@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);

    await request(app)
      .delete(`/api/v1/cart/items/${AIR_MAX_90.variantSku}`)
      .set(...bob.auth)
      .expect(404);

    const aliceCart = await request(app)
      .get('/api/v1/cart')
      .set(...alice.auth)
      .expect(200);
    expect(aliceCart.body.data.lineCount).toBe(1);
  });

  it('scopes order history to the owner', async () => {
    const app = makeApp();
    const alice = await signUp(app, 'alice3@example.com');
    const bob = await signUp(app, 'bob3@example.com');

    await request(app)
      .post('/api/v1/cart/items')
      .set(...alice.auth)
      .send({ ...AIR_MAX_90, quantity: 1 })
      .expect(201);
    await request(app)
      .post('/api/v1/cart/checkout')
      .set(...alice.auth)
      .expect(201);

    const aliceOrders = await request(app)
      .get('/api/v1/cart/orders')
      .set(...alice.auth)
      .expect(200);
    const bobOrders = await request(app)
      .get('/api/v1/cart/orders')
      .set(...bob.auth)
      .expect(200);

    expect(aliceOrders.body.data).toHaveLength(1);
    expect(bobOrders.body.data).toHaveLength(0);
  });
});
