import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ForbiddenError, UnauthorizedError } from '../domain/errors.js';
import type { PublicUser } from '../domain/user.js';
import type { AuthService } from '../services/auth.service.js';
import type { Config } from '../config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /** Set by `authenticate` when a valid bearer token is present. */
      user?: PublicUser;
      /** The raw bearer token, needed by logout to revoke the session. */
      bearerToken?: string;
    }
  }
}

/**
 * Attaches a correlation id to every request and echoes it back as a response
 * header. Any log line or error body can then be traced to a single request —
 * the first thing you need when debugging a production incident.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/** Minimal structured access log. In production this would be pino/OTel. */
export function requestLogger(config: Config): RequestHandler {
  return (req, res, next) => {
    if (config.nodeEnv === 'test') return next();

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'request',
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          requestId: req.requestId,
        }),
      );
    });
    next();
  };
}

/**
 * Guards mutating routes with a shared secret when API_KEY is configured.
 *
 * This is a stand-in, not a real authn story: a production service would sit
 * behind an OAuth2/OIDC gateway and check scopes per route. It is here to show
 * where that boundary goes, and it stays inert when API_KEY is unset so local
 * development and tests are frictionless.
 */
export function requireApiKey(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (!config.apiKey) return next();

    const provided = req.header('x-api-key');
    if (!provided || !timingSafeEqual(provided, config.apiKey)) {
      return next(new UnauthorizedError());
    }
    next();
  };
}

/** Constant-time comparison so response latency does not leak the key. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Session authentication
// ---------------------------------------------------------------------------

function bearerFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  // Scheme match is case-insensitive per RFC 7235.
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Resolves a bearer token to `req.user` when one is present and valid.
 *
 * Deliberately **optional**: an absent or bad token is not an error here, it just
 * leaves `req.user` undefined. Rejection is `requireAuth`'s job. Splitting the
 * two lets a route be public-but-personalised — the product list could highlight
 * items already in your cart — without duplicating token parsing.
 */
export function authenticate(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const token = bearerFrom(req);
    if (!token) return next();

    auth
      .authenticate(token)
      .then((user) => {
        req.user = user;
        req.bearerToken = token;
        next();
      })
      // An invalid token is treated as "not signed in" rather than a 401, so a
      // stale token in localStorage degrades to anonymous browsing instead of
      // hard-failing every request.
      .catch(() => next());
  };
}

/** Rejects when `authenticate` did not establish a user. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new UnauthorizedError('Authentication required'));
  next();
};

/** Rejects when the authenticated user is not an admin. 403, not 401. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new UnauthorizedError('Authentication required'));
  if (req.user.role !== 'admin') return next(new ForbiddenError('Admin role required'));
  next();
};

/**
 * Authorises catalog mutations: a valid API key **or** an authenticated admin.
 *
 * Two credential types coexist because they serve different callers — the API key
 * is for machine-to-machine use (a nightly import job), while the admin role is
 * for a human in the storefront. Either is sufficient on its own.
 */
export function requireCatalogWrite(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (req.user?.role === 'admin') return next();

    // No API key configured and no admin session: open, matching the previous
    // behaviour for local development.
    if (!config.apiKey) return next();

    const provided = req.header('x-api-key');
    if (provided && timingSafeEqual(provided, config.apiKey)) return next();

    return next(
      req.user
        ? new ForbiddenError('Admin role or a valid API key is required')
        : new UnauthorizedError('Missing or invalid API key'),
    );
  };
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 5 forwards async rejections on its own; this keeps the code explicit
 * and portable back to Express 4.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
};

/**
 * The single place where errors become HTTP responses.
 *
 * Known failures (AppError, ZodError) return a structured, actionable body.
 * Anything else is treated as a bug: logged with its stack server-side, and
 * reported to the client as a bare 500 so internals are never leaked.
 */
export function errorHandler(config: Config) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    // Malformed JSON surfaces as a SyntaxError from body-parser.
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is not valid JSON',
          requestId: req.requestId,
        },
      });
      return;
    }

    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'unhandled error',
        requestId: req.requestId,
        path: req.originalUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message:
          config.nodeEnv === 'production'
            ? 'An unexpected error occurred'
            : err instanceof Error
              ? err.message
              : String(err),
        requestId: req.requestId,
      },
    });
  };
}

/**
 * Alias so route modules can accept a limiter without importing Express types.
 * Keeps `rate-limit.ts` as the only place that knows how limiting is implemented.
 */
export type RateLimiter = RequestHandler;
