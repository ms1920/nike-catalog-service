import { createHash, randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_TTL_MS,
  MAX_QUANTITY_PER_LINE,
  availableFor,
  newHold,
  type Cart,
  type CartLine,
  type IdempotencyRecord,
  type Order,
  type OrderLine,
  type PricedCart,
} from '../domain/cart.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { formatMoney, type Product, type Variant } from '../domain/product.js';
import type { CartRepository } from '../repositories/cart.repository.js';
import type { ProductRepository } from '../repositories/product.repository.js';

export interface CheckoutOptions {
  /** From the `Idempotency-Key` header, when supplied. */
  idempotencyKey?: string;
}

export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly products: ProductRepository,
  ) {}

  async getCart(userId: string): Promise<PricedCart> {
    await this.carts.purgeExpiredHolds();
    const cart = await this.carts.findByUserId(userId);
    return this.price(cart);
  }

  /**
   * Adds to the cart and reserves the stock.
   *
   * Adding merges into an existing line rather than creating a second one. Two
   * rows for the same variant is a classic cart bug: the item shows twice, and
   * per-line caps become trivially bypassable by adding repeatedly.
   */
  async addItem(
    userId: string,
    productId: string,
    variantSku: string,
    quantity: number,
  ): Promise<PricedCart> {
    await this.carts.purgeExpiredHolds();
    const { variant } = await this.resolveVariant(productId, variantSku);

    const cart = await this.carts.findByUserId(userId);
    const existing = cart.items.find(
      (item) => item.variantSku.toLowerCase() === variantSku.toLowerCase(),
    );
    const desired = (existing?.quantity ?? 0) + quantity;

    await this.assertClaimable(userId, variant, desired);

    const items = existing
      ? cart.items.map((item) =>
          item === existing ? { ...item, quantity: desired } : item,
        )
      : [
          ...cart.items,
          {
            productId,
            variantSku: variant.sku,
            quantity,
            addedAt: new Date().toISOString(),
          },
        ];

    await this.carts.save({ ...cart, items });
    // Reserve after the cart write succeeds, and refresh the TTL — touching a line
    // is a signal of active intent, so the clock restarts.
    await this.carts.upsertHold(newHold(userId, productId, variant.sku, desired));

    return this.getCart(userId);
  }

  /** Sets an absolute quantity. Quantity 0 removes the line and its hold. */
  async setQuantity(
    userId: string,
    variantSku: string,
    quantity: number,
  ): Promise<PricedCart> {
    await this.carts.purgeExpiredHolds();

    const cart = await this.carts.findByUserId(userId);
    const existing = cart.items.find(
      (item) => item.variantSku.toLowerCase() === variantSku.toLowerCase(),
    );
    if (!existing) throw new NotFoundError('Cart item', variantSku);

    if (quantity === 0) return this.removeItem(userId, variantSku);

    const { variant } = await this.resolveVariant(existing.productId, existing.variantSku);
    await this.assertClaimable(userId, variant, quantity);

    const items = cart.items.map((item) =>
      item === existing ? { ...item, quantity } : item,
    );
    await this.carts.save({ ...cart, items });
    await this.carts.upsertHold(
      newHold(userId, existing.productId, existing.variantSku, quantity),
    );

    return this.getCart(userId);
  }

  async removeItem(userId: string, variantSku: string): Promise<PricedCart> {
    const cart = await this.carts.findByUserId(userId);
    const items = cart.items.filter(
      (item) => item.variantSku.toLowerCase() !== variantSku.toLowerCase(),
    );

    if (items.length === cart.items.length)
      throw new NotFoundError('Cart item', variantSku);

    await this.carts.save({ ...cart, items });
    // Release immediately rather than waiting for expiry: stock a shopper has
    // explicitly given up should be back on sale at once.
    await this.carts.releaseHold(userId, variantSku);

    return this.getCart(userId);
  }

  async clear(userId: string): Promise<PricedCart> {
    await this.carts.clear(userId);
    await this.carts.releaseAllHolds(userId);
    return this.getCart(userId);
  }

  async listOrders(userId: string): Promise<Order[]> {
    return this.carts.listOrders(userId);
  }

  /**
   * Checks out: validates stock, decrements inventory, records the order, releases
   * holds and empties the cart.
   *
   * Idempotent when the caller supplies a key. A repeat returns the original order
   * rather than placing a second one — the fix for a double-clicked Pay button or a
   * client retry after a timeout it could not distinguish from a failure.
   *
   * The in-memory store has no transactions, so inventory deltas are applied one at
   * a time and **compensated on failure**: everything already applied is reversed
   * before the error propagates. Without that, a cart whose third line is out of
   * stock would leave the first two silently decremented.
   *
   * This is a compensating action, not a transaction — it is not atomic under
   * concurrent access, because another request can interleave between awaits. On
   * Postgres the whole method becomes one `BEGIN … COMMIT` with
   * `UPDATE … SET inventory = inventory - $1 WHERE inventory >= $1`, and the
   * compensation logic gets deleted.
   */
  async checkout(userId: string, options: CheckoutOptions = {}): Promise<Order> {
    await this.carts.purgeExpiredHolds();

    const cart = await this.carts.findByUserId(userId);
    const fingerprint = fingerprintOf(cart);

    /*
     * The idempotency lookup comes BEFORE the empty-cart guard, and that ordering
     * is the whole point.
     *
     * A successful checkout empties the cart. So the canonical retry — client sent
     * the request, the response was lost, client retries — arrives with an empty
     * cart. Checking "is the cart empty?" first would answer that retry with
     * "cannot check out an empty cart" instead of the order that was actually
     * placed, which is exactly the failure idempotency is supposed to prevent.
     *
     * The fingerprint guard only fires when the cart is non-empty and differs.
     * Comparing against an emptied cart would make every legitimate retry look
     * like key reuse.
     */
    if (options.idempotencyKey) {
      const seen = await this.carts.findIdempotencyRecord(options.idempotencyKey, userId);
      if (seen) {
        if (cart.items.length > 0 && seen.requestFingerprint !== fingerprint) {
          // Same key, genuinely different basket. Replaying the old order would
          // hide a real client bug, so this is refused rather than answered.
          throw new ConflictError(
            'This Idempotency-Key was already used for a different cart',
            { key: options.idempotencyKey },
          );
        }

        const original = await this.carts.findOrder(seen.orderId);
        if (original) return original;
      }
    }

    if (cart.items.length === 0) {
      throw new ValidationError('Cannot check out an empty cart');
    }

    // Pass 1 — resolve and validate everything before mutating any inventory.
    const resolved: Array<{ product: Product; variant: Variant; quantity: number }> = [];
    for (const item of cart.items) {
      const { product, variant } = await this.resolveVariant(
        item.productId,
        item.variantSku,
      );

      if (product.status !== 'active') {
        throw new ConflictError(`'${product.name}' is no longer available`, {
          productId: product.id,
        });
      }

      const claimable = await this.claimable(userId, variant);
      if (claimable < item.quantity) {
        throw new ConflictError(
          `Only ${claimable} left of '${product.name}' in size ${variant.size}`,
          { variantSku: variant.sku, requested: item.quantity, available: claimable },
        );
      }

      resolved.push({ product, variant, quantity: item.quantity });
    }

    // Pass 2 — apply, tracking what to reverse if a later line fails.
    const applied: Array<{ productId: string; variantSku: string; quantity: number }> = [];
    try {
      for (const line of resolved) {
        await this.products.adjustInventory(
          line.product.id,
          line.variant.sku,
          -line.quantity,
        );
        applied.push({
          productId: line.product.id,
          variantSku: line.variant.sku,
          quantity: line.quantity,
        });
      }
    } catch (error) {
      for (const done of applied.reverse()) {
        await this.products
          .adjustInventory(done.productId, done.variantSku, done.quantity)
          .catch((reason: unknown) => {
            // A failure here understates stock, which needs an operator alert
            // rather than a silent swallow.
            console.error(
              JSON.stringify({
                level: 'error',
                msg: 'inventory compensation failed',
                productId: done.productId,
                variantSku: done.variantSku,
                quantity: done.quantity,
                reason: reason instanceof Error ? reason.message : String(reason),
              }),
            );
          });
      }
      throw error;
    }

    const lines: OrderLine[] = resolved.map(({ product, variant, quantity }) => ({
      productId: product.id,
      variantSku: variant.sku,
      name: product.name,
      size: variant.size,
      quantity,
      // Price captured at purchase time — an order must record what the customer
      // agreed to pay, even if the catalog price changes tomorrow.
      unitPrice: product.price,
      lineTotal: {
        amount: product.price.amount * quantity,
        currency: product.price.currency,
      },
    }));

    const currency = lines[0]?.unitPrice.currency ?? 'INR';
    const totalAmount = lines.reduce((sum, line) => sum + line.lineTotal.amount, 0);

    const order: Order = {
      id: randomUUID(),
      userId,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      total: { amount: totalAmount, currency },
      totalFormatted: formatMoney({ amount: totalAmount, currency }),
      placedAt: new Date().toISOString(),
    };

    await this.carts.createOrder(order);
    await this.carts.releaseAllHolds(userId);
    await this.carts.clear(userId);

    if (options.idempotencyKey) {
      const now = new Date();
      const record: IdempotencyRecord = {
        key: options.idempotencyKey,
        userId,
        requestFingerprint: fingerprint,
        orderId: order.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      };
      await this.carts.saveIdempotencyRecord(record);
    }

    return order;
  }

  // -------------------------------------------------------------------------

  private async resolveVariant(
    productId: string,
    variantSku: string,
  ): Promise<{ product: Product; variant: Variant }> {
    const product = await this.products.findById(productId);
    if (!product) throw new NotFoundError('Product', productId);

    const variant = product.variants.find(
      (v) => v.sku.toLowerCase() === variantSku.toLowerCase(),
    );
    if (!variant) throw new NotFoundError('Product variant', variantSku);

    return { product, variant };
  }

  /** On-hand stock minus other shoppers' active holds. */
  private async claimable(userId: string, variant: Variant): Promise<number> {
    const holds = await this.carts.activeHoldsFor(variant.sku);
    return availableFor(userId, variant.inventory, holds);
  }

  private async assertClaimable(
    userId: string,
    variant: Variant,
    quantity: number,
  ): Promise<void> {
    if (quantity > MAX_QUANTITY_PER_LINE) {
      throw new ValidationError(
        `Maximum ${MAX_QUANTITY_PER_LINE} per item; requested ${quantity}`,
        { max: MAX_QUANTITY_PER_LINE, requested: quantity },
      );
    }

    const claimable = await this.claimable(userId, variant);
    if (quantity > claimable) {
      throw new ConflictError(
        claimable === variant.inventory
          ? `Only ${claimable} left in size ${variant.size}`
          : `Only ${claimable} left in size ${variant.size} — some are reserved in other carts`,
        { variantSku: variant.sku, requested: quantity, available: claimable },
      );
    }
  }

  /**
   * Joins stored cart items against the catalog to produce a priced view.
   *
   * A line whose product has since been deleted is dropped rather than throwing,
   * so a stale reference can never make the cart permanently unreadable.
   */
  private async price(cart: Cart): Promise<PricedCart> {
    const lines: CartLine[] = [];

    for (const item of cart.items) {
      const product = await this.products.findById(item.productId);
      if (!product) continue;

      const variant = product.variants.find(
        (v) => v.sku.toLowerCase() === item.variantSku.toLowerCase(),
      );
      if (!variant) continue;

      const lineTotal = {
        amount: product.price.amount * item.quantity,
        currency: product.price.currency,
      };
      const claimable = await this.claimable(cart.userId, variant);

      lines.push({
        productId: product.id,
        variantSku: variant.sku,
        quantity: item.quantity,
        size: variant.size,
        name: product.name,
        brand: product.brand,
        category: product.category,
        colorway: product.colorway,
        image: product.images[0] ?? null,
        unitPrice: product.price,
        unitPriceFormatted: formatMoney(product.price),
        lineTotal,
        lineTotalFormatted: formatMoney(lineTotal),
        availableInventory: claimable,
        // Surfaced rather than silently clamped: a cart that quietly reduces
        // itself is worse than one that says "only 2 left".
        exceedsStock: item.quantity > claimable,
      });
    }

    const currency = lines[0]?.unitPrice.currency ?? 'INR';
    const subtotalAmount = lines.reduce((sum, line) => sum + line.lineTotal.amount, 0);
    const subtotal = { amount: subtotalAmount, currency };

    return {
      userId: cart.userId,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      lineCount: lines.length,
      subtotal,
      subtotalFormatted: formatMoney(subtotal),
      currency,
      hasIssues: lines.some((line) => line.exceedsStock),
      updatedAt: cart.updatedAt,
    };
  }
}

/**
 * Identifies the cart a checkout was for, so a reused idempotency key describing
 * different contents can be rejected instead of silently replayed.
 */
function fingerprintOf(cart: Cart): string {
  const canonical = [...cart.items]
    .map((item) => `${item.productId}:${item.variantSku.toLowerCase()}:${item.quantity}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}
