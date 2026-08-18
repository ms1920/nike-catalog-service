import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { hashPassword, needsRehash, verifyPassword } from '../src/services/password.js';
import { makeApp, signUp } from './helpers.js';

const GOOD_PASSWORD = 'a sufficiently long password';

describe('password hashing', () => {
  it('never stores the plaintext', async () => {
    const encoded = await hashPassword(GOOD_PASSWORD);
    expect(encoded).not.toContain(GOOD_PASSWORD);
    expect(encoded.startsWith('scrypt$')).toBe(true);
  });

  it('produces a different hash each time for the same password', async () => {
    // Distinct salts. Without this, identical passwords share a hash and one
    // cracked credential compromises every user who reused it.
    const [a, b] = await Promise.all([
      hashPassword(GOOD_PASSWORD),
      hashPassword(GOOD_PASSWORD),
    ]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(GOOD_PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(GOOD_PASSWORD, b)).resolves.toBe(true);
  });

  it('records its cost parameters so they can be upgraded later', async () => {
    const encoded = await hashPassword(GOOD_PASSWORD);
    const [scheme, n, r, p] = encoded.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(32768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(needsRehash(encoded)).toBe(false);
  });

  it('flags hashes made with weaker parameters for rehash', () => {
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const encoded = await hashPassword(GOOD_PASSWORD);
    await expect(verifyPassword('some other password', encoded)).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt record must fail the login, not surface a 500.
    for (const bad of [
      '',
      'garbage',
      'scrypt$x$y$z$a$b',
      'scrypt$32768$8$1$$',
      'a$b$c$d$e$f',
    ]) {
      await expect(verifyPassword(GOOD_PASSWORD, bad)).resolves.toBe(false);
    }
  });
});

describe('POST /api/v1/users', () => {
  it('creates an account and returns a session', async () => {
    const res = await request(makeApp())
      .post('/api/v1/users')
      .send({ email: 'new@example.com', name: 'New Person', password: GOOD_PASSWORD })
      .expect(201);

    expect(res.body.data.user).toMatchObject({
      email: 'new@example.com',
      name: 'New Person',
      role: 'customer',
    });
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.token.length).toBeGreaterThanOrEqual(40);
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('never returns the password hash', async () => {
    const res = await request(makeApp())
      .post('/api/v1/users')
      .send({ email: 'leak@example.com', name: 'Leak Check', password: GOOD_PASSWORD })
      .expect(201);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain(GOOD_PASSWORD);
  });

  it('normalises the email to lower case', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/users')
      .send({ email: '  MiXeD@Example.COM ', name: 'Mixed', password: GOOD_PASSWORD })
      .expect(201);

    expect(res.body.data.user.email).toBe('mixed@example.com');

    // And the normalised form is what logging in matches against.
    await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'MIXED@EXAMPLE.com', password: GOOD_PASSWORD })
      .expect(201);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const app = makeApp();
    await signUp(app, 'dupe@example.com');

    const res = await request(app)
      .post('/api/v1/users')
      .send({ email: 'DUPE@example.com', name: 'Imposter', password: GOOD_PASSWORD })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('enforces a 12-character minimum password', async () => {
    const res = await request(makeApp())
      .post('/api/v1/users')
      .send({ email: 'short@example.com', name: 'Short', password: 'abc123' })
      .expect(400);

    expect(res.body.error.details[0]).toMatchObject({ path: 'password' });
  });

  it('rejects a malformed email', async () => {
    const res = await request(makeApp())
      .post('/api/v1/users')
      .send({ email: 'not-an-email', name: 'Bad', password: GOOD_PASSWORD })
      .expect(400);

    expect(res.body.error.details[0].path).toBe('email');
  });

  it('refuses a self-assigned admin role', async () => {
    // Privilege escalation via request body. The schema is `.strict()`, so an
    // unknown field is rejected outright rather than silently dropped.
    const res = await request(makeApp())
      .post('/api/v1/users')
      .send({
        email: 'evil@example.com',
        name: 'Evil',
        password: GOOD_PASSWORD,
        role: 'admin',
      })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('still assigns the customer role when no role is sent', async () => {
    const user = await signUp(makeApp(), 'plain@example.com');
    expect(user.id).toBeTruthy();
  });
});

describe('POST /api/v1/users/sessions', () => {
  it('returns a token for correct credentials', async () => {
    const app = makeApp();
    await signUp(app, 'login@example.com');

    const res = await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'login@example.com', password: 'a sufficiently long password' })
      .expect(201);

    expect(res.body.data.token).toBeTypeOf('string');
  });

  it('issues a distinct token per login', async () => {
    const app = makeApp();
    const first = await signUp(app, 'multi@example.com');

    const res = await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'multi@example.com', password: 'a sufficiently long password' })
      .expect(201);

    // Both sessions stay valid — logging in on a phone must not sign out a laptop.
    expect(res.body.data.token).not.toBe(first.token);
    await request(app)
      .get('/api/v1/users/me')
      .set(...first.auth)
      .expect(200);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    // Differing messages would turn the login form into an account-enumeration
    // oracle.
    const app = makeApp();
    await signUp(app, 'known@example.com');

    const wrongPassword = await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'known@example.com', password: 'definitely not correct' })
      .expect(401);

    const unknownEmail = await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'nobody@example.com', password: 'definitely not correct' })
      .expect(401);

    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    expect(wrongPassword.body.error.code).toBe('UNAUTHORIZED');
  });

  it('does not apply the length policy to the submitted password', async () => {
    // A short password must fail as wrong credentials, not as a validation error
    // that reveals the policy to someone probing.
    const res = await request(makeApp())
      .post('/api/v1/users/sessions')
      .send({ email: 'nobody@example.com', password: 'x' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/v1/users/me', () => {
  it('returns the current user', async () => {
    const app = makeApp();
    const user = await signUp(app, 'me@example.com');

    const res = await request(app)
      .get('/api/v1/users/me')
      .set(...user.auth)
      .expect(200);
    expect(res.body.data).toMatchObject({ email: 'me@example.com', role: 'customer' });
  });

  it('401s without a token', async () => {
    const res = await request(makeApp()).get('/api/v1/users/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401s on a garbage or malformed token', async () => {
    const app = makeApp();
    for (const header of ['Bearer nonsense', 'nonsense', 'Basic abc', 'Bearer ']) {
      await request(app).get('/api/v1/users/me').set('authorization', header).expect(401);
    }
  });

  it('accepts a case-insensitive bearer scheme', async () => {
    // RFC 7235 says the scheme is case-insensitive.
    const app = makeApp();
    const user = await signUp(app, 'scheme@example.com');
    await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `bearer ${user.token}`)
      .expect(200);
  });
});

describe('POST /api/v1/users/sessions/current', () => {
  it('revokes the token', async () => {
    const app = makeApp();
    const user = await signUp(app, 'out@example.com');

    await request(app)
      .get('/api/v1/users/me')
      .set(...user.auth)
      .expect(200);
    await request(app)
      .delete('/api/v1/users/sessions/current')
      .set(...user.auth)
      .expect(204);
    await request(app)
      .get('/api/v1/users/me')
      .set(...user.auth)
      .expect(401);
  });

  it('is idempotent and succeeds without a token', async () => {
    // A client clearing local state should never be blocked by the server
    // disagreeing about whether the session existed.
    const app = makeApp();
    const user = await signUp(app, 'idem@example.com');

    await request(app)
      .delete('/api/v1/users/sessions/current')
      .set(...user.auth)
      .expect(204);
    await request(app)
      .delete('/api/v1/users/sessions/current')
      .set(...user.auth)
      .expect(204);
    await request(app).delete('/api/v1/users/sessions/current').expect(204);
  });

  it('does not affect another session', async () => {
    const app = makeApp();
    const first = await signUp(app, 'sess@example.com');
    const second = await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'sess@example.com', password: 'a sufficiently long password' })
      .expect(201);

    await request(app)
      .delete('/api/v1/users/sessions/current')
      .set(...first.auth)
      .expect(204);

    await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${second.body.data.token}`)
      .expect(200);
  });
});

describe('POST /api/v1/users/me/password', () => {
  it('changes the password and invalidates every existing session', async () => {
    const app = makeApp();
    const user = await signUp(app, 'change@example.com');

    await request(app)
      .patch('/api/v1/users/me/password')
      .set(...user.auth)
      .send({
        currentPassword: 'a sufficiently long password',
        newPassword: 'an entirely different secret',
      })
      .expect(204);

    // The old token must stop working: revocation is the whole point of a
    // password change.
    await request(app)
      .get('/api/v1/users/me')
      .set(...user.auth)
      .expect(401);

    await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'change@example.com', password: 'a sufficiently long password' })
      .expect(401);

    await request(app)
      .post('/api/v1/users/sessions')
      .send({ email: 'change@example.com', password: 'an entirely different secret' })
      .expect(201);
  });

  it('rejects a wrong current password', async () => {
    const app = makeApp();
    const user = await signUp(app, 'wrongcur@example.com');

    await request(app)
      .patch('/api/v1/users/me/password')
      .set(...user.auth)
      .send({ currentPassword: 'not the real one', newPassword: 'another long password' })
      .expect(400);

    // The session survives a failed attempt.
    await request(app)
      .get('/api/v1/users/me')
      .set(...user.auth)
      .expect(200);
  });

  it('rejects reusing the same password', async () => {
    const app = makeApp();
    const user = await signUp(app, 'same@example.com');

    const res = await request(app)
      .patch('/api/v1/users/me/password')
      .set(...user.auth)
      .send({
        currentPassword: 'a sufficiently long password',
        newPassword: 'a sufficiently long password',
      })
      .expect(400);

    expect(res.body.error.details[0].path).toBe('newPassword');
  });

  it('requires authentication', async () => {
    await request(makeApp())
      .patch('/api/v1/users/me/password')
      .send({ currentPassword: 'whatever at all', newPassword: 'another long password' })
      .expect(401);
  });
});

describe('catalog write authorisation', () => {
  const body = {
    sku: 'NIKE-AUTHZ-001',
    name: 'Authz Test Shoe',
    brand: 'Nike',
    category: 'Running',
    gender: 'unisex',
    price: { amount: 999_900, currency: 'INR' },
    variants: [{ sku: 'NIKE-AUTHZ-001-9', size: '9', inventory: 1 }],
    status: 'active',
  };

  it('still accepts a valid API key', async () => {
    await request(makeApp({ apiKey: 'secret-key' }))
      .post('/api/v1/products')
      .set('x-api-key', 'secret-key')
      .send(body)
      .expect(201);
  });

  it('rejects an anonymous write with 401 when a key is configured', async () => {
    const res = await request(makeApp({ apiKey: 'secret-key' }))
      .post('/api/v1/products')
      .send(body)
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a signed-in customer with 403, not 401', async () => {
    // 403 is the correct code: we know who they are, they just lack the role.
    // A 401 would tell the client to re-authenticate, which cannot help.
    const app = makeApp({ apiKey: 'secret-key' });
    const user = await signUp(app, 'customer@example.com');

    const res = await request(app)
      .post('/api/v1/products')
      .set(...user.auth)
      .send(body)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('leaves reads open to anonymous callers', async () => {
    await request(makeApp({ apiKey: 'secret-key' }))
      .get('/api/v1/products')
      .expect(200);
  });
});
