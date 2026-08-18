import { z } from 'zod';
import { MAX_QUANTITY_PER_LINE } from '../domain/cart.js';

/** Request schemas for the cart resource. Validates into `src/domain/cart.ts`. */

export const addCartItemSchema = z
  .object({
    productId: z.string().min(1, 'is required'),
    variantSku: z.string().min(1, 'is required').max(64),
    // The per-line cap is enforced in the service, which can see the existing
    // quantity; this bound only stops an absurd single request.
    quantity: z
      .number()
      .int('must be a whole number')
      .min(1, 'must be at least 1')
      .max(MAX_QUANTITY_PER_LINE, `must be at most ${MAX_QUANTITY_PER_LINE}`)
      .default(1),
  })
  .strict();

export const setCartQuantitySchema = z
  .object({
    // Zero is allowed and means "remove this line", which keeps a quantity
    // stepper from needing a separate DELETE call when it reaches zero.
    quantity: z
      .number()
      .int('must be a whole number')
      .min(0, 'cannot be negative')
      .max(MAX_QUANTITY_PER_LINE, `must be at most ${MAX_QUANTITY_PER_LINE}`),
  })
  .strict();

export type AddCartItemBody = z.infer<typeof addCartItemSchema>;
export type SetCartQuantityBody = z.infer<typeof setCartQuantitySchema>;
