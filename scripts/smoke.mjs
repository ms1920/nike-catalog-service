#!/usr/bin/env node
/**
 * Smoke test against a running API.
 *
 * Distinct from the unit and integration suites: those drive the app in-process
 * with injected repositories, which cannot catch anything about the *deployed*
 * artifact. This exercises a real HTTP server over a real socket, so it catches
 * the failures that only appear once the thing is actually running — a build that
 * emitted a broken entry point, a datastore that will not decrypt, an env var
 * that was never wired through.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({
      name,
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave null; some assertions only care about status */
  }
  return { status: response.status, body, headers: response.headers };
}

/**
 * Waits for the server to accept connections before asserting anything.
 *
 * Requires a JSON body, not merely a 200. Behind a single-page-app catch-all, an
 * unrouted path returns index.html with a 200 — so a status-only check reports
 * "ready" while actually receiving HTML, and every later assertion fails for a
 * reason that has nothing to do with the API.
 */
async function waitForReady(attempts = 40) {
  let lastSeen = 'no response';
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${BASE}/ready`);
      if (res.ok) {
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('application/json')) return;
        lastSeen = `200 but content-type was ${type} — is /ready routed to the API?`;
      } else {
        lastSeen = `status ${res.status}`;
      }
    } catch (error) {
      lastSeen = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API at ${BASE} never became ready (${lastSeen})`);
}

console.log(`Smoke testing ${BASE}`);
await waitForReady();

await check('liveness responds', async () => {
  const { status, body } = await json('/health');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body.status === 'ok', 'health did not report ok');
});

await check('readiness reports a hydrated catalog', async () => {
  const { status, body } = await json('/ready');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body.products > 0, `expected a seeded catalog, got ${body.products} products`);
});

await check('catalog lists products with pagination', async () => {
  const { status, body } = await json('/api/v1/products?pageSize=5');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body.data.length === 5, `expected 5 items, got ${body.data.length}`);
  assert(body.pagination.total > 5, 'pagination total looks wrong');
});

await check('prices are INR in paise and formatted', async () => {
  const { body } = await json('/api/v1/products?pageSize=1');
  const product = body.data[0];
  assert(product.price.currency === 'INR', `expected INR, got ${product.price.currency}`);
  assert(Number.isInteger(product.price.amount), 'price is not an integer');
  assert(
    product.priceFormatted.startsWith('₹'),
    `expected ₹, got ${product.priceFormatted}`,
  );
});

await check('facets narrow with filters', async () => {
  const { status, body } = await json('/api/v1/products/facets?category=Running');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body.data.categories.length === 1, 'facets did not narrow to one category');
});

await check('unknown query parameters are rejected', async () => {
  const { status } = await json('/api/v1/products?nonsense=1');
  assert(status === 400, `expected 400, got ${status}`);
});

await check('products expose an ETag', async () => {
  const { body } = await json('/api/v1/products?pageSize=1');
  const { status, headers } = await json(`/api/v1/products/${body.data[0].id}`);
  assert(status === 200, `expected 200, got ${status}`);
  assert(headers.get('etag'), 'no ETag header');
});

await check('update without If-Match is refused', async () => {
  const { body } = await json('/api/v1/products?pageSize=1');
  const { status } = await json(`/api/v1/products/${body.data[0].id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke test rename' }),
  });
  assert(status === 428, `expected 428, got ${status}`);
});

await check('cart requires authentication', async () => {
  const { status } = await json('/api/v1/cart');
  assert(status === 401, `expected 401, got ${status}`);
});

// A unique address per run, so repeated smoke runs against a persistent
// datastore do not collide on the duplicate-email conflict.
const email = `smoke-${Date.now()}@example.com`;
const password = 'a sufficiently long smoke password';
let token = null;

await check('registration issues a session', async () => {
  const { status, body } = await json('/api/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Smoke Test', password }),
  });
  assert(status === 201, `expected 201, got ${status}`);
  assert(body.data.token, 'no token returned');
  assert(
    !JSON.stringify(body).includes('passwordHash'),
    'password hash leaked in response',
  );
  token = body.data.token;
});

await check('sign-in works and rejects a wrong password identically', async () => {
  const good = await json('/api/v1/users/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(good.status === 201, `expected 201, got ${good.status}`);

  const bad = await json('/api/v1/users/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'definitely not the password' }),
  });
  assert(bad.status === 401, `expected 401, got ${bad.status}`);

  const unknown = await json('/api/v1/users/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'definitely not it' }),
  });
  assert(
    unknown.body.error.message === bad.body.error.message,
    'unknown email and wrong password gave different messages',
  );
});

const authed = () => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

await check('the full purchase flow completes', async () => {
  const list = await json('/api/v1/products?inStockOnly=true&pageSize=1');
  const product = list.body.data[0];
  const size = product.variants.find((v) => v.inventory > 0);
  assert(size, 'no in-stock variant to buy');

  const added = await json('/api/v1/cart/items', {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ productId: product.id, variantSku: size.sku, quantity: 1 }),
  });
  assert(added.status === 201, `add to cart expected 201, got ${added.status}`);
  assert(added.body.data.itemCount === 1, 'cart did not report one item');

  const key = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = await json('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { ...authed(), 'idempotency-key': key },
  });
  assert(first.status === 201, `checkout expected 201, got ${first.status}`);

  // Replaying the key must return the same order, not place a second one.
  const replay = await json('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { ...authed(), 'idempotency-key': key },
  });
  assert(replay.status === 201, `replay expected 201, got ${replay.status}`);
  assert(
    replay.body.data.id === first.body.data.id,
    'idempotent replay created a new order',
  );

  const orders = await json('/api/v1/cart/orders', { headers: authed() });
  assert(orders.body.data.length === 1, `expected 1 order, got ${orders.body.data.length}`);
});

await check('signing out revokes the token', async () => {
  const out = await json('/api/v1/users/sessions/current', {
    method: 'DELETE',
    headers: authed(),
  });
  assert(out.status === 204, `expected 204, got ${out.status}`);

  const after = await json('/api/v1/users/me', { headers: authed() });
  assert(after.status === 401, `expected 401 after sign-out, got ${after.status}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
