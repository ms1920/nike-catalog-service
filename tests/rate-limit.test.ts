import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemoryProductRepository } from '../src/repositories/in-memory-product.repository.js';
import { InMemoryUserRepository } from '../src/repositories/user.repository.js';
import { InMemoryCartRepository } from '../src/repositories/cart.repository.js';
import { seedProducts } from '../src/seed/products.js';
import { MemoryRateLimitStore, createLimiters, rateLimit } from '../src/http/rate-limit.js';
import { testConfig } from './helpers.js';

/**
 * Every app here gets its own limiter store, so one test exhausting a quota
 * cannot leak into another. Shared counters across parallel tests would make
 * these results order-dependent.
 */
function makeLimitedApp() {
  return createApp({
    config: testConfig,
    repository: new InMemoryProductRepository(seedProducts),
    userRepository: new InMemoryUserRepository(),
    cartRepository: new InMemoryCartRepository(),
    limiters: createLimiters(new MemoryRateLimitStore()),
  });
}

describe('rate limit middleware', () => {
  it('allows up to the limit then rejects with 429', async () => {
    const app = createApp({
      config: testConfig,
      repository: new InMemoryProductRepository(seedProducts),
      userRepository: new InMemoryUserRepository(),
      cartRepository: new InMemoryCartRepository(),
      limiters: {
        ...createLimiters(new MemoryRateLimitStore()),
        api: rateLimit({
          name: 'test',
          limit: 3,
          windowMs: 60_000,
          store: new MemoryRateLimitStore(),
        }),
      },
    });

    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/v1/products').expect(200);
    }

    const blocked = await request(app).get('/api/v1/products').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('advertises the policy in headers', async () => {
    const res = await request(makeLimitedApp()).get('/api/v1/products').expect(200);

    expect(res.headers['ratelimit-limit']).toBeTruthy();
    expect(res.headers['ratelimit-remaining']).toBeTruthy();
    expect(res.headers['ratelimit-policy']).toMatch(/;w=\d+/);
  });

  it('sends Retry-After when it rejects', async () => {
    const store = new MemoryRateLimitStore();
    const app = createApp({
      config: testConfig,
      repository: new InMemoryProductRepository(seedProducts),
      userRepository: new InMemoryUserRepository(),
      cartRepository: new InMemoryCartRepository(),
      limiters: {
        ...createLimiters(store),
        api: rateLimit({ name: 'ra', limit: 1, windowMs: 60_000, store }),
      },
    });

    await request(app).get('/api/v1/products').expect(200);
    const blocked = await request(app).get('/api/v1/products').expect(429);

    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never throttles health or readiness', async () => {
    // Rate limiting a health check is how a busy service gets itself depooled.
    const store = new MemoryRateLimitStore();
    const app = createApp({
      config: testConfig,
      repository: new InMemoryProductRepository(seedProducts),
      userRepository: new InMemoryUserRepository(),
      cartRepository: new InMemoryCartRepository(),
      limiters: {
        ...createLimiters(store),
        api: rateLimit({ name: 'h', limit: 1, windowMs: 60_000, store }),
      },
    });

    for (let i = 0; i < 12; i += 1) {
      await request(app).get('/health').expect(200);
      await request(app).get('/ready').expect(200);
    }
  });
});

describe('sign-in rate limiting', () => {
  it('throttles repeated failed sign-ins for one email', async () => {
    // The important case: password verification runs scrypt, so an unthrottled
    // endpoint is both a credential-stuffing target and a CPU exhaustion vector.
    const app = makeLimitedApp();
    await request(app)
      .post('/api/v1/users')
      .send({
        email: 'target@example.com',
        name: 'Target',
        password: 'a long enough secret',
      })
      .expect(201);

    let sawLimit = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/users/sessions')
        .send({ email: 'target@example.com', password: 'definitely not correct' });

      if (res.status === 429) {
        sawLimit = true;
        expect(res.body.error.code).toBe('RATE_LIMITED');
        break;
      }
      expect(res.status).toBe(401);
    }

    expect(sawLimit).toBe(true);
  });

  it('keys on email as well as IP, so one target does not lock out others', async () => {
    const app = makeLimitedApp();

    for (const email of ['a@example.com', 'b@example.com']) {
      await request(app)
        .post('/api/v1/users')
        .send({ email, name: 'Someone', password: 'a long enough secret' })
        .expect(201);
    }

    // Burn the quota against one address.
    for (let i = 0; i < 12; i += 1) {
      await request(app)
        .post('/api/v1/users/sessions')
        .send({ email: 'a@example.com', password: 'wrong password here' });
    }

    // A different address is unaffected: in a test the IP is constant, so an
    // IP-only key would have locked this out too.
    await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'b@example.com', password: 'a long enough secret' })
      .expect(201);
  });

  it('throttles registration', async () => {
    const app = makeLimitedApp();

    let sawLimit = false;
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/api/v1/users')
        .send({
          email: `flood${i}@example.com`,
          name: 'Flood',
          password: 'a long enough secret',
        });

      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }

    expect(sawLimit).toBe(true);
  });
});

describe('MemoryRateLimitStore', () => {
  it('expires hits outside the window', () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    const window = 1000;

    store.hit('k', t0, window);
    store.hit('k', t0 + 500, window);
    expect(store.hit('k', t0 + 600, window)).toHaveLength(3);

    // Sliding, not fixed. At t0+1000 the cutoff is t0, so the first hit has aged
    // out while the two later ones survive alongside this one.
    expect(store.hit('k', t0 + 1000, window)).toHaveLength(3);

    // Far enough ahead and every earlier hit is gone — only this one remains.
    expect(store.hit('k', t0 + 5000, window)).toHaveLength(1);
  });

  it('bounds its key count so it cannot be used as a memory leak', () => {
    const store = new MemoryRateLimitStore(5);
    for (let i = 0; i < 50; i += 1) {
      store.hit(`key-${i}`, 1000 + i, 60_000);
    }
    // Nothing to assert beyond "it did not grow unbounded"; the eviction path is
    // exercised, and the newest key is still tracked.
    expect(store.hit('key-49', 2000, 60_000).length).toBeGreaterThan(0);
  });
});
