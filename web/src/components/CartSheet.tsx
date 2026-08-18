import { MAX_QUANTITY } from '../lib/constants.js';
import { useAuth } from '../state/auth.js';
import { useCart } from '../state/cart.js';
import { ProductMedia } from './ProductMedia.js';
import { Sheet } from './Sheet.js';

interface CartSheetProps {
  open: boolean;
  onClose: () => void;
  onRequestSignIn: () => void;
}

/**
 * The Bag.
 *
 * Three states, in priority order: signed out, order just placed, and the cart
 * itself. Collapsing the order confirmation into the empty state would be a small
 * bug with a real cost — a shopper who just paid would see "Your Bag is empty"
 * and reasonably wonder whether the order went through.
 */
export function CartSheet({ open, onClose, onRequestSignIn }: CartSheetProps) {
  const { user } = useAuth();
  const {
    cart,
    busy,
    error,
    lastOrder,
    setQuantity,
    remove,
    clear,
    checkout,
    dismissOrder,
  } = useCart();

  const lines = cart?.lines ?? [];
  const canCheckout = Boolean(cart && lines.length > 0 && !cart.hasIssues && !busy);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={user && lines.length > 0 ? `Bag · ${cart?.itemCount ?? 0}` : 'Bag'}
      labelledBy="cart-title"
      footer={
        user && lines.length > 0 && !lastOrder ? (
          <>
            <div className="totals">
              <div className="totals__row">
                <span>Subtotal</span>
                <span>{cart?.subtotalFormatted}</span>
              </div>
              {/*
                No invented tax or shipping line. Both are real business rules
                that vary by destination, and fabricating a percentage would make
                the total a lie. The API returns a subtotal, so that is what shows.
              */}
              <p className="totals__note">Taxes and shipping are calculated at checkout.</p>
            </div>
            <button
              type="button"
              className="btn btn--solid cart__checkout"
              disabled={!canCheckout}
              onClick={() => void checkout()}
            >
              {busy ? 'Working…' : 'Checkout'}
            </button>
            {cart?.hasIssues && (
              <p className="cart__blocked" role="alert">
                Reduce the highlighted items to continue.
              </p>
            )}
          </>
        ) : null
      }
    >
      <div className="cart">
        {!user && (
          <div className="cart__empty">
            <h2 id="cart-title" className="cart__title">
              Your Bag
            </h2>
            <p className="cart__lede">Sign in to see your Bag and place an order.</p>
            <button type="button" className="btn btn--solid" onClick={onRequestSignIn}>
              Sign In
            </button>
          </div>
        )}

        {user && lastOrder && (
          <div className="cart__empty">
            <h2 id="cart-title" className="cart__title">
              Order placed
            </h2>
            <p className="cart__lede">
              {lastOrder.itemCount} {lastOrder.itemCount === 1 ? 'item' : 'items'} ·{' '}
              {lastOrder.totalFormatted}
            </p>
            <ul className="order__lines">
              {lastOrder.lines.map((line) => (
                <li key={line.variantSku}>
                  {line.quantity} × {line.name} · Size {line.size}
                </li>
              ))}
            </ul>
            <p className="cart__ref">
              Order reference <code>{lastOrder.id.slice(0, 8)}</code>
            </p>
            <button type="button" className="btn btn--outline" onClick={dismissOrder}>
              Keep Shopping
            </button>
          </div>
        )}

        {user && !lastOrder && lines.length === 0 && (
          <div className="cart__empty">
            <h2 id="cart-title" className="cart__title">
              Your Bag is empty
            </h2>
            <p className="cart__lede">Add something to get started.</p>
            <button type="button" className="btn btn--outline" onClick={onClose}>
              Continue Shopping
            </button>
          </div>
        )}

        {user && !lastOrder && lines.length > 0 && (
          <>
            <h2 id="cart-title" className="sr-only">
              Your Bag
            </h2>

            {error && (
              <p className="form__banner" role="alert">
                {error}
              </p>
            )}

            <ul className="cart__lines">
              {lines.map((line) => (
                <li
                  className="line"
                  key={line.variantSku}
                  data-issue={line.exceedsStock || undefined}
                >
                  <div className="line__media">
                    <ProductMedia
                      src={line.image ?? undefined}
                      alt={line.name}
                      colorway={line.colorway}
                      seed={line.productId}
                    />
                  </div>

                  <div className="line__body">
                    <p className="line__name">{line.name}</p>
                    <p className="line__meta">{line.category}</p>
                    <p className="line__meta line__meta--dim">
                      Size {line.size} · {line.colorway}
                    </p>

                    <div className="line__controls">
                      <div className="stepper">
                        <button
                          type="button"
                          className="stepper__btn"
                          aria-label={`Decrease quantity of ${line.name}`}
                          disabled={busy}
                          onClick={() =>
                            void setQuantity(line.variantSku, line.quantity - 1)
                          }
                        >
                          &minus;
                        </button>
                        <span className="stepper__value" aria-live="polite">
                          {line.quantity}
                        </span>
                        <button
                          type="button"
                          className="stepper__btn"
                          aria-label={`Increase quantity of ${line.name}`}
                          disabled={
                            busy ||
                            line.quantity >= line.availableInventory ||
                            line.quantity >= MAX_QUANTITY
                          }
                          onClick={() =>
                            void setQuantity(line.variantSku, line.quantity + 1)
                          }
                        >
                          +
                        </button>
                      </div>

                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => void remove(line.variantSku)}
                      >
                        Remove
                      </button>
                    </div>

                    {/* Real stock figures from the API, not manufactured urgency. */}
                    {line.exceedsStock && (
                      <p className="line__issue" role="alert">
                        Only {line.availableInventory} left — reduce the quantity to check
                        out.
                      </p>
                    )}
                    {!line.exceedsStock && line.availableInventory <= 3 && (
                      <p className="line__low">Only {line.availableInventory} left</p>
                    )}
                  </div>

                  <p className="line__price">{line.lineTotalFormatted}</p>
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="link-button cart__clear"
              disabled={busy}
              onClick={() => void clear()}
            >
              Empty Bag
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
