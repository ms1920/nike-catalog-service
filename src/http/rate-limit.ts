import type { RequestHandler } from 'express';
import { AppError } from '../domain/errors.js';

/**
 * In-memory sliding-window rate limiter.
 *
 * No Redis, because the whole system must run from a clean clone with no external
 * services. The consequence is honest and worth stating: counters are per-process,
 * so N replicas allow N times the configured rate, and a restart forgives every
 * caller. A real deployment needs a shared store — the `RateLimitStore` seam below
 * is where that swap happens.
 *
 * A sliding window rather than a fixed one. Fixed windows let a caller fire the
 * full quota at 0.99s and again at 1.01s, passing two windows but delivering
 * double the intended burst. Storing timestamps costs a little memory and removes
 * that edge entirely.
 */

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, limit: number, windowSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds}s.`, 429, 'RATE_LIMITED', {
      limit,
      windowSeconds,
      retryAfterSeconds,
    });
  }
}

export interface RateLimitStore {
  /** Returns the timestamps still inside the window, after recording `now`. */
  hit(key: string, now: number, windowMs: number): number[];
  clear(): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  /** Guards against unbounded growth from a spray of unique keys. */
  private readonly maxKeys: number;

  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys;
  }

  hit(key: string, now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    const existing = this.hits.get(key) ?? [];

    // Drop timestamps that have aged out, then record this one.
    const live = existing.filter((at) => at > cutoff);
    live.push(now);

    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // At capacity: evict the least recently active key. Without a bound, an
      // attacker rotating IPs turns the limiter itself into the memory leak.
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [candidate, timestamps] of this.hits) {
        const last = timestamps[timestamps.length - 1] ?? 0;
        if (last < oldestAt) {
          oldestAt = last;
          oldestKey = candidate;
        }
      }
      if (oldestKey) this.hits.delete(oldestKey);
    }

    this.hits.set(key, live);
    return live;
  }

  clear(): void {
    this.hits.clear();
  }
}

export interface RateLimitOptions {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
  /** Distinguishes limiters that share a store. */
  name: string;
  store?: RateLimitStore;
  /**
   * Defaults to the client IP. Sensitive endpoints override this to also key on
   * a body field, so one attacker cannot lock out an entire NAT.
   */
  keyOf?: (req: Parameters<RequestHandler>[0]) => string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const store = options.store ?? new MemoryRateLimitStore();
  const keyOf = options.keyOf ?? ((req) => req.ip ?? 'unknown');

  return (req, res, next) => {
    const now = Date.now();
    const key = `${options.name}:${keyOf(req)}`;
    const live = store.hit(key, now, options.windowMs);

    const remaining = Math.max(0, options.limit - live.length);
    res.setHeader('RateLimit-Limit', String(options.limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Policy', `${options.limit};w=${options.windowMs / 1000}`);

    if (live.length > options.limit) {
      const oldest = live[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return next(new RateLimitError(retryAfter, options.limit, options.windowMs / 1000));
    }

    next();
  };
}

/**
 * Limits for each protected surface.
 *
 * Sign-in is the tightest for two compounding reasons: it is the credential
 * stuffing target, and password verification runs scrypt at ~57ms of deliberately
 * memory-hard work. An unthrottled sign-in endpoint is therefore also a CPU
 * exhaustion vector — a few hundred concurrent attempts will starve the event loop
 * regardless of whether any credential is ever guessed.
 */
export function createLimiters(store?: RateLimitStore) {
  const shared = store ?? new MemoryRateLimitStore();

  return {
    /** Keyed on IP *and* email, so one attacker cannot lock out a shared NAT. */
    signIn: rateLimit({
      name: 'signin',
      limit: 8,
      windowMs: 60_000,
      store: shared,
      keyOf: (req) => {
        const body = req.body as { email?: unknown } | undefined;
        const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
        return `${req.ip ?? 'unknown'}|${email}`;
      },
    }),

    register: rateLimit({ name: 'register', limit: 5, windowMs: 300_000, store: shared }),

    /** Also scrypt-bound, and only reachable with a valid session. */
    changePassword: rateLimit({
      name: 'changepw',
      limit: 5,
      windowMs: 300_000,
      store: shared,
    }),

    /** Writes stock and creates orders, so it gets a real ceiling. */
    checkout: rateLimit({ name: 'checkout', limit: 15, windowMs: 60_000, store: shared }),

    /** Generous: ordinary browsing should never notice this. */
    api: rateLimit({ name: 'api', limit: 600, windowMs: 60_000, store: shared }),

    store: shared,
  };
}

export type Limiters = ReturnType<typeof createLimiters>;
