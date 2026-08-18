import type { Money } from './product.js';

/**
 * Cart domain.
 *
 * The stored cart is intentionally thin: ids and quantities only, no prices.
 * Prices, names and images are resolved from the catalog on every read, so a
 * price change or a rename is reflected immediately and a cart can never quote a
 * stale figure. The tradeoff is that reads cost a catalog lookup per line.
 *
 * A real storefront eventually needs the opposite for *orders* — an order must
 * capture the price at the moment of purchase, because that is what the customer
 * agreed to pay. Hence `OrderLine` below stores its own `unitPrice`, while
 * `CartItem` does not.
 */

/** Per-line purchase cap. A policy knob, not a technical limit. */
export const MAX_QUANTITY_PER_LINE = 10;

export interface CartItem {
  productId: string;
  variantSku: string;
  quantity: number;
  addedAt: string;
}

export interface Cart {
  userId: string;
  items: CartItem[];
  updatedAt: string;
}

/** A cart line joined against the catalog and priced. */
export interface CartLine {
  productId: string;
  variantSku: string;
  quantity: number;
  size: string;
  name: string;
  brand: string;
  category: string;
  colorway: string;
  image: string | null;
  unitPrice: Money;
  unitPriceFormatted: string;
  lineTotal: Money;
  lineTotalFormatted: string;
  availableInventory: number;
  /**
   * True when the requested quantity now exceeds stock. Surfaced rather than
   * silently clamped: a cart that quietly reduces itself is worse than one that
   * says "only 2 left".
   */
  exceedsStock: boolean;
}

export interface PricedCart {
  userId: string;
  lines: CartLine[];
  /** Total units across all lines. */
  itemCount: number;
  /** Distinct variants. */
  lineCount: number;
  subtotal: Money;
  subtotalFormatted: string;
  currency: string;
  /** True when any line exceeds available stock — blocks checkout. */
  hasIssues: boolean;
  updatedAt: string;
}

export interface OrderLine {
  productId: string;
  variantSku: string;
  name: string;
  size: string;
  quantity: number;
  /** Captured at purchase time, deliberately denormalised. See note above. */
  unitPrice: Money;
  lineTotal: Money;
}

export interface Order {
  id: string;
  userId: string;
  lines: OrderLine[];
  itemCount: number;
  total: Money;
  totalFormatted: string;
  placedAt: string;
}

export function emptyCart(userId: string): Cart {
  return { userId, items: [], updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Inventory holds
// ---------------------------------------------------------------------------

/** How long a cart reservation survives without being touched. */
export const HOLD_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * A time-boxed reservation of stock backing a cart line.
 *
 * Two shoppers each adding the last pair should not both reach payment. A hold
 * takes the unit out of circulation the moment it enters a cart — but only for a
 * while, because the alternative is worse: a permanent reservation means one
 * abandoned cart strands that pair forever, and a popular size quietly becomes
 * unbuyable.
 *
 * The hold is deliberately separate from the cart line rather than being the same
 * record. A cart is long-lived and a reservation is not, so when a hold expires
 * the line stays put and simply reports that it can no longer be fulfilled. That
 * matches what a shopper expects: your bag keeps its contents, but you can lose
 * your claim on scarce stock.
 */
export interface InventoryHold {
  userId: string;
  productId: string;
  variantSku: string;
  quantity: number;
  createdAt: string;
  expiresAt: string;
}

export function holdIsActive(hold: InventoryHold, now = new Date()): boolean {
  return new Date(hold.expiresAt).getTime() > now.getTime();
}

export function newHold(
  userId: string,
  productId: string,
  variantSku: string,
  quantity: number,
  now = new Date(),
): InventoryHold {
  return {
    userId,
    productId,
    variantSku,
    quantity,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HOLD_TTL_MS).toISOString(),
  };
}

/**
 * Stock a given user may still claim on a variant.
 *
 * Other users' active holds are subtracted; the user's own is not, because their
 * own hold *is* the line they are looking at — counting it would make their cart
 * appear to compete with itself.
 */
export function availableFor(
  userId: string,
  onHandInventory: number,
  holds: InventoryHold[],
  now = new Date(),
): number {
  const claimedByOthers = holds
    .filter((hold) => hold.userId !== userId && holdIsActive(hold, now))
    .reduce((sum, hold) => sum + hold.quantity, 0);

  return Math.max(0, onHandInventory - claimedByOthers);
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** How long a checkout idempotency key is remembered. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A recorded result for an `Idempotency-Key`.
 *
 * Checkout is not naturally idempotent: a repeat POST would place a second order.
 * A customer double-clicking Pay, or a client retrying after a timeout it could
 * not distinguish from a failure, must not be charged twice. Storing the key with
 * the order it produced lets a repeat return the original response.
 *
 * `requestFingerprint` guards against key reuse with different content: if the
 * same key arrives describing a different cart, that is a client bug, and
 * replaying the old order would hide it.
 */
export interface IdempotencyRecord {
  key: string;
  userId: string;
  requestFingerprint: string;
  orderId: string;
  createdAt: string;
  expiresAt: string;
}
