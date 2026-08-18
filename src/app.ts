import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { InMemoryProductRepository } from './repositories/in-memory-product.repository.js';
import type { ProductRepository } from './repositories/product.repository.js';
import {
  InMemoryUserRepository,
  type UserRepository,
} from './repositories/user.repository.js';
import {
  InMemoryCartRepository,
  type CartRepository,
} from './repositories/cart.repository.js';
import { ProductService } from './services/product.service.js';
import { AuthService } from './services/auth.service.js';
import { CartService } from './services/cart.service.js';
import { seedProducts } from './seed/products.js';
import { productRoutes } from './http/product.routes.js';
import { userRoutes } from './http/user.routes.js';
import { cartRoutes } from './http/cart.routes.js';
import { createLimiters, type Limiters } from './http/rate-limit.js';
import {
  authenticate,
  errorHandler,
  notFoundHandler,
  requestId,
  requestLogger,
} from './http/middleware.js';

export interface AppOptions {
  config?: Config;
  repository?: ProductRepository;
  userRepository?: UserRepository;
  cartRepository?: CartRepository;
  /** Injectable so tests can use fresh counters, or disable limits entirely. */
  limiters?: Limiters;
}

/**
 * Builds the Express app without binding a port.
 *
 * This is the composition root — the only place that knows which concrete
 * repositories are in play. Tests inject their own config and freshly-seeded
 * repositories, which is why they can run in parallel without sharing state or
 * opening sockets.
 */
export function createApp(options: AppOptions = {}): Express {
  const config = options.config ?? loadConfig();

  const productRepository =
    options.repository ?? new InMemoryProductRepository(seedProducts);
  const userRepository = options.userRepository ?? new InMemoryUserRepository();
  const cartRepository = options.cartRepository ?? new InMemoryCartRepository();

  const products = new ProductService(productRepository);
  const auth = new AuthService(userRepository);
  const carts = new CartService(cartRepository, productRepository);

  const limiters = options.limiters ?? createLimiters();

  const app = express();

  app.disable('x-powered-by');
  // Required for `req.ip` to reflect the real client behind a proxy, which the
  // rate limiter keys on.
  app.set('trust proxy', true);
  // Cap body size: without a limit, a single large POST can exhaust memory.
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use(requestLogger(config));

  // Resolves a bearer token to `req.user` when present. Mounted before the routes
  // so both public and protected handlers can see the current user; it never
  // rejects on its own.
  app.use(authenticate(auth));

  // Liveness: is the process up? Readiness: can it actually serve traffic?
  // Separating them is what lets an orchestrator restart vs. depool correctly.
  // Neither is rate limited — throttling health checks is how a busy service gets
  // itself depooled.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/ready', (_req, res, next) => {
    Promise.all([productRepository.count(), userRepository.countUsers()])
      .then(([productCount, userCount]) =>
        res.json({ status: 'ready', products: productCount, users: userCount }),
      )
      .catch(next);
  });

  // A generous ceiling across the API surface, with tighter per-route limits
  // applied inside the routers below.
  app.use('/api', limiters.api);

  // Versioned prefix from day one: /v2 can be introduced later without breaking
  // existing clients.
  app.use(
    '/api/v1/users',
    userRoutes(auth, { register: limiters.register, signIn: limiters.signIn }),
  );
  app.use('/api/v1/cart', cartRoutes(carts, limiters.checkout));
  app.use('/api/v1/products', productRoutes(products, config));

  app.use(notFoundHandler);
  app.use(errorHandler(config));

  return app;
}
