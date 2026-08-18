import {
  emptyCart,
  holdIsActive,
  type Cart,
  type IdempotencyRecord,
  type InventoryHold,
  type Order,
} from '../domain/cart.js';

/**
 * Cart persistence boundary: carts, orders, inventory holds and idempotency
 * records.
 *
 * `findByUserId` returns an empty cart rather than null for an unknown user. A
 * cart is conceptually always present for an authenticated user — it just might
 * have nothing in it — so making absence a separate case every caller must handle
 * buys nothing.
 *
 * Holds are keyed by `(userId, variantSku)`: one shopper holds one reservation per
 * variant, matching the one-line-per-variant rule the cart already enforces.
 */
export interface CartRepository {
  findByUserId(userId: string): Promise<Cart>;
  save(cart: Cart): Promise<Cart>;
  clear(userId: string): Promise<Cart>;

  createOrder(order: Order): Promise<Order>;
  findOrder(orderId: string): Promise<Order | null>;
  listOrders(userId: string): Promise<Order[]>;

  /** Creates or replaces this user's hold on a variant, refreshing its expiry. */
  upsertHold(hold: InventoryHold): Promise<InventoryHold>;
  /** Active holds on a variant, across all users. */
  activeHoldsFor(variantSku: string, now?: Date): Promise<InventoryHold[]>;
  releaseHold(userId: string, variantSku: string): Promise<boolean>;
  releaseAllHolds(userId: string): Promise<number>;
  /** Drops expired holds. Called opportunistically rather than on a timer. */
  purgeExpiredHolds(now?: Date): Promise<number>;

  findIdempotencyRecord(key: string, userId: string): Promise<IdempotencyRecord | null>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<IdempotencyRecord>;
}

export interface CartSnapshot {
  carts: Cart[];
  orders: Order[];
  holds: InventoryHold[];
  idempotency: IdempotencyRecord[];
}

export class InMemoryCartRepository implements CartRepository {
  private readonly carts = new Map<string, Cart>();
  private readonly orders = new Map<string, Order[]>();
  /** Key: `userId::variantSku` (lower-cased SKU). */
  private readonly holds = new Map<string, InventoryHold>();
  /** Key: `userId::idempotencyKey`, so keys are scoped per user. */
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly listeners = new Set<() => void>();

  /** In-memory-only change notification for the persistence layer. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  hydrate(snapshot: CartSnapshot): void {
    this.carts.clear();
    this.orders.clear();
    this.holds.clear();
    this.idempotency.clear();

    for (const cart of snapshot.carts) {
      this.carts.set(cart.userId, structuredClone(cart));
    }
    // Orders are stored flat and regrouped by user, which keeps the persisted
    // shape a plain array rather than a map JSON cannot represent.
    for (const order of snapshot.orders) {
      const existing = this.orders.get(order.userId) ?? [];
      this.orders.set(order.userId, [...existing, structuredClone(order)]);
    }
    for (const hold of snapshot.holds ?? []) {
      this.holds.set(holdKey(hold.userId, hold.variantSku), structuredClone(hold));
    }
    for (const record of snapshot.idempotency ?? []) {
      this.idempotency.set(`${record.userId}::${record.key}`, structuredClone(record));
    }
  }

  snapshot(): CartSnapshot {
    return {
      carts: [...this.carts.values()].map((c) => structuredClone(c)),
      orders: [...this.orders.values()].flat().map((o) => structuredClone(o)),
      holds: [...this.holds.values()].map((h) => structuredClone(h)),
      idempotency: [...this.idempotency.values()].map((r) => structuredClone(r)),
    };
  }

  async findByUserId(userId: string): Promise<Cart> {
    const found = this.carts.get(userId);
    return found ? structuredClone(found) : emptyCart(userId);
  }

  async save(cart: Cart): Promise<Cart> {
    const next: Cart = { ...cart, updatedAt: new Date().toISOString() };
    this.carts.set(cart.userId, structuredClone(next));
    this.notify();
    return structuredClone(next);
  }

  async clear(userId: string): Promise<Cart> {
    const cleared = emptyCart(userId);
    this.carts.set(userId, structuredClone(cleared));
    this.notify();
    return structuredClone(cleared);
  }

  async createOrder(order: Order): Promise<Order> {
    const existing = this.orders.get(order.userId) ?? [];
    // Newest first, which is the order any "my orders" view wants.
    this.orders.set(order.userId, [structuredClone(order), ...existing]);
    this.notify();
    return structuredClone(order);
  }

  async findOrder(orderId: string): Promise<Order | null> {
    for (const orders of this.orders.values()) {
      const found = orders.find((order) => order.id === orderId);
      if (found) return structuredClone(found);
    }
    return null;
  }

  async listOrders(userId: string): Promise<Order[]> {
    return structuredClone(this.orders.get(userId) ?? []);
  }

  async upsertHold(hold: InventoryHold): Promise<InventoryHold> {
    this.holds.set(holdKey(hold.userId, hold.variantSku), structuredClone(hold));
    this.notify();
    return structuredClone(hold);
  }

  async activeHoldsFor(variantSku: string, now = new Date()): Promise<InventoryHold[]> {
    const wanted = variantSku.toLowerCase();
    return [...this.holds.values()]
      .filter((hold) => hold.variantSku.toLowerCase() === wanted && holdIsActive(hold, now))
      .map((hold) => structuredClone(hold));
  }

  async releaseHold(userId: string, variantSku: string): Promise<boolean> {
    const removed = this.holds.delete(holdKey(userId, variantSku));
    if (removed) this.notify();
    return removed;
  }

  async releaseAllHolds(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, hold] of this.holds) {
      if (hold.userId === userId) {
        this.holds.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.notify();
    return removed;
  }

  /**
   * Lazy expiry rather than a background timer. A sweeper would keep the process
   * awake and is one more thing to supervise; expiry only has to be correct at the
   * moment someone asks about availability, and callers do that on every read.
   */
  async purgeExpiredHolds(now = new Date()): Promise<number> {
    let removed = 0;
    for (const [key, hold] of this.holds) {
      if (!holdIsActive(hold, now)) {
        this.holds.delete(key);
        removed += 1;
      }
    }
    for (const [key, record] of this.idempotency) {
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        this.idempotency.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.notify();
    return removed;
  }

  async findIdempotencyRecord(
    key: string,
    userId: string,
  ): Promise<IdempotencyRecord | null> {
    const found = this.idempotency.get(`${userId}::${key}`);
    if (!found) return null;
    if (new Date(found.expiresAt).getTime() <= Date.now()) return null;
    return structuredClone(found);
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    this.idempotency.set(`${record.userId}::${record.key}`, structuredClone(record));
    this.notify();
    return structuredClone(record);
  }
}

function holdKey(userId: string, variantSku: string): string {
  return `${userId}::${variantSku.toLowerCase()}`;
}
