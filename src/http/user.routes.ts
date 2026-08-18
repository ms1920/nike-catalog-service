import { Router } from 'express';
import { UnauthorizedError } from '../domain/errors.js';
import type { AuthService } from '../services/auth.service.js';
import { asyncHandler, requireAuth, type RateLimiter } from './middleware.js';
import {
  changePasswordSchema,
  createSessionSchema,
  createUserSchema,
} from './user.schemas.js';

/**
 * The user resource, with sessions as a sub-resource.
 *
 * Authentication is modelled as operations on users rather than as a separate
 * `/auth` area, because that is what it is: registering is creating a user,
 * signing in is creating a session for one, signing out is deleting that session.
 *
 *   POST   /users                     register
 *   POST   /users/sessions            sign in  — creates a session
 *   DELETE /users/sessions/current    sign out — deletes this session
 *   GET    /users/me                  the signed-in user
 *   PATCH  /users/me/password         rotate password, revoking all sessions
 *
 * The alternative — `/auth/signup`, `/auth/login` — invents a resource that does
 * not exist in the domain and leaves the User model with no endpoints of its own.
 *
 * The token is returned in the JSON body rather than set as a cookie. That is the
 * right shape for a token consumed by `fetch`, and it sidesteps CSRF entirely: a
 * cross-site request cannot read a body to obtain the token, whereas a cookie
 * would be sent automatically and would need SameSite plus a CSRF token to be
 * safe. The cost is that the client stores it, and `localStorage` is readable by
 * any XSS on the page.
 */
export function userRoutes(
  auth: AuthService,
  limiters: {
    register: RateLimiter;
    signIn: RateLimiter;
  },
): Router {
  const router = Router();

  router.post(
    '/',
    limiters.register,
    asyncHandler(async (req, res) => {
      const input = createUserSchema.parse(req.body);
      const result = await auth.signup(input);
      res.status(201).location(`/api/v1/users/${result.user.id}`).json({ data: result });
    }),
  );

  router.post(
    '/sessions',
    limiters.signIn,
    asyncHandler(async (req, res) => {
      const { email, password } = createSessionSchema.parse(req.body);
      const result = await auth.login(email, password);
      // 201: a session is a resource, and this created one.
      res.status(201).json({ data: result });
    }),
  );

  /**
   * Idempotent by design: deleting an already-invalid session still returns 204.
   * A client clearing local state should never be blocked by the server
   * disagreeing about whether the session existed.
   */
  router.delete(
    '/sessions/current',
    asyncHandler(async (req, res) => {
      if (req.bearerToken) await auth.logout(req.bearerToken);
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ data: req.user });
    }),
  );

  router.patch(
    '/me/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
      if (!req.user) throw new UnauthorizedError();

      await auth.changePassword(req.user.id, currentPassword, newPassword);
      // 204 with no new token: every session was just revoked, so the client must
      // sign in again. Silently issuing a fresh token would defeat the revocation.
      res.status(204).end();
    }),
  );

  return router;
}
