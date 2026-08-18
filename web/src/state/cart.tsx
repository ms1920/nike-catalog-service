import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  addCartItem,
  checkout as apiCheckout,
  clearCart as apiClearCart,
  fetchCart,
  newIdempotencyKey,
  removeCartItem,
  setCartQuantity,
  type Order,
  type PricedCart,
} from '../lib/api.js';
import { useAuth } from './auth.js';

interface CartState {
  cart: PricedCart | null;
  busy: boolean;
  error: string | null;
  lastOrder: Order | null;
  add: (productId: string, variantSku: string, quantity?: number) => Promise<void>;
  setQuantity: (variantSku: string, quantity: number) => Promise<void>;
  remove: (variantSku: string) => Promise<void>;
  clear: () => Promise<void>;
  checkout: () => Promise<Order>;
  dismissOrder: () => void;
  clearError: () => void;
}

const CartContext = createContext<CartState | null>(null);

/**
 * Owns the cart.
 *
 * Every mutation returns the full recomputed cart from the server and replaces
 * local state with it. No optimistic updates: the server is the only thing that
 * knows current stock, and an optimistic add that the server then rejects on
 * stock grounds would have to be visibly rolled back. For a cart — low frequency,
 * high consequence — a brief spinner beats a flickering wrong number.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cart, setCart] = useState<PricedCart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);

  // Load on sign-in, discard on sign-out. Without the clear, one user's cart
  // would linger on screen after the next user signs in.
  useEffect(() => {
    if (!user) {
      setCart(null);
      setLastOrder(null);
      return;
    }

    const controller = new AbortController();
    fetchCart(controller.signal)
      .then(setCart)
      .catch(() => {
        if (!controller.signal.aborted) setCart(null);
      });

    return () => controller.abort();
  }, [user]);

  /** Wraps a mutation with busy/error handling so each action stays declarative. */
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong');
      throw caught;
    } finally {
      setBusy(false);
    }
  }, []);

  const add = useCallback(
    async (productId: string, variantSku: string, quantity = 1) => {
      setCart(await run(() => addCartItem(productId, variantSku, quantity)));
    },
    [run],
  );

  const setQuantity = useCallback(
    async (variantSku: string, quantity: number) => {
      setCart(await run(() => setCartQuantity(variantSku, quantity)));
    },
    [run],
  );

  const remove = useCallback(
    async (variantSku: string) => {
      setCart(await run(() => removeCartItem(variantSku)));
    },
    [run],
  );

  const clear = useCallback(async () => {
    setCart(await run(() => apiClearCart()));
  }, [run]);

  /**
   * One key per checkout attempt, held in a ref so a retry after a network
   * failure reuses it. Minting a fresh key on retry would make the server treat
   * the retry as a new order — the exact double-charge idempotency prevents.
   * Cleared only once an order actually comes back.
   */
  const checkoutKey = useRef<string | null>(null);

  const checkout = useCallback(async () => {
    checkoutKey.current ??= newIdempotencyKey();
    const order = await run(() => apiCheckout(checkoutKey.current!));
    checkoutKey.current = null;
    setLastOrder(order);
    // Checkout empties the cart server-side; reflect that without another fetch.
    setCart((prev) =>
      prev
        ? {
            ...prev,
            lines: [],
            itemCount: 0,
            lineCount: 0,
            subtotal: { amount: 0, currency: prev.currency },
            subtotalFormatted: prev.subtotalFormatted.replace(/[\d,.]+/, '0.00'),
            hasIssues: false,
          }
        : prev,
    );
    return order;
  }, [run]);

  const value = useMemo<CartState>(
    () => ({
      cart,
      busy,
      error,
      lastOrder,
      add,
      setQuantity,
      remove,
      clear,
      checkout,
      dismissOrder: () => setLastOrder(null),
      clearError: () => setError(null),
    }),
    [cart, busy, error, lastOrder, add, setQuantity, remove, clear, checkout],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside <CartProvider>');
  return context;
}
