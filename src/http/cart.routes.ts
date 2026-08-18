import { Router } from 'express';
import { UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { CartService } from '../services/cart.service.js';
import { asyncHandler, requireAuth, type RateLimiter } from './middleware.js';
import { addCartItemSchema, setCartQuantitySchema } from './cart.schemas.js';

/**
 * Cart routes.
 *
 * Every handler derives the user id from `req.user`, never from the request body
 * or a path parameter. That is the whole authorisation story for the cart: there
 * is no addressable `/carts/:userId`, so there is no way to ask for someone
 * else's cart — the insecure-direct-object-reference class of bug is designed out
 * rather than guarded against.
 */
export function cartRoutes(carts: CartService, checkoutLimiter: RateLimiter): Router {
  const router = Router();

  // Applies to every route below, so no handler can forget it.
  router.use(requireAuth);

  /** Narrowing helper — `requireAuth` guarantees this, TypeScript does not. */
  const userId = (req: { user?: { id: string } }): string => {
    if (!req.user) throw new UnauthorizedError();
    return req.user.id;
  };

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ data: await carts.getCart(userId(req)) });
    }),
  );

  router.post(
    '/items',
    asyncHandler(async (req, res) => {
      const { productId, variantSku, quantity } = addCartItemSchema.parse(req.body);
      const cart = await carts.addItem(userId(req), productId, variantSku, quantity);
      res.status(201).json({ data: cart });
    }),
  );

  router.patch(
    '/items/:variantSku',
    asyncHandler(async (req, res) => {
      const { quantity } = setCartQuantitySchema.parse(req.body);
      const sku = req.params.variantSku;
      if (typeof sku !== 'string' || !sku) {
        throw new ValidationError('A variant SKU is required');
      }

      res.json({ data: await carts.setQuantity(userId(req), sku, quantity) });
    }),
  );

  router.delete(
    '/items/:variantSku',
    asyncHandler(async (req, res) => {
      const sku = req.params.variantSku;
      if (typeof sku !== 'string' || !sku) {
        throw new ValidationError('A variant SKU is required');
      }

      res.json({ data: await carts.removeItem(userId(req), sku) });
    }),
  );

  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ data: await carts.clear(userId(req)) });
    }),
  );

  /**
   * Checkout: decrements inventory, records the order, releases holds, empties
   * the cart.
   *
   * Send `Idempotency-Key` to make it safe to retry. A repeat with the same key
   * returns the original order instead of placing a second one — the fix for a
   * double-clicked Pay button, or a client retrying after a timeout it could not
   * distinguish from a failure. The same key describing a *different* cart is a
   * 409, because replaying the old order would hide a real client bug.
   *
   * The header is optional rather than required so that `curl` exploration still
   * works, but any client that can retry should send one.
   */
  router.post(
    '/checkout',
    checkoutLimiter,
    asyncHandler(async (req, res) => {
      const key = req.header('idempotency-key');
      if (key !== undefined && (key.length < 8 || key.length > 200)) {
        throw new ValidationError('Idempotency-Key must be 8–200 characters', {
          header: 'Idempotency-Key',
        });
      }

      const order = await carts.checkout(userId(req), { idempotencyKey: key });
      res.status(201).location(`/api/v1/cart/orders/${order.id}`).json({ data: order });
    }),
  );

  router.get(
    '/orders',
    asyncHandler(async (req, res) => {
      res.json({ data: await carts.listOrders(userId(req)) });
    }),
  );

  return router;
}
