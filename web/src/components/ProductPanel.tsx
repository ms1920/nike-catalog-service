import { useEffect, useState } from 'react';
import type { Product } from '../lib/api.js';
import { titleCase } from '../lib/format.js';
import { useAuth } from '../state/auth.js';
import { useCart } from '../state/cart.js';
import { ProductMedia } from './ProductMedia.js';
import { Sheet } from './Sheet.js';

interface ProductPanelProps {
  product: Product | null;
  onClose: () => void;
  onRequestSignIn: () => void;
}

/**
 * Product detail, with size selection and Add to Bag.
 *
 * Adding requires a size. Nike's own PDP behaves this way, and it is not merely a
 * convention: inventory lives on the variant, so there is no such thing as adding
 * "the shoe" — the API needs a variant SKU.
 */
export function ProductPanel({ product, onClose, onRequestSignIn }: ProductPanelProps) {
  const { user } = useAuth();
  const { add, busy } = useCart();
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per product, so opening a second product doesn't inherit the first
  // one's selection or its success message.
  useEffect(() => {
    setSelectedSku(null);
    setAdded(false);
    setError(null);
  }, [product?.id]);

  if (!product) return null;

  const lowStock = product.variants.filter((v) => v.inventory > 0 && v.inventory <= 3);
  const selected = product.variants.find((v) => v.sku === selectedSku) ?? null;

  async function onAdd() {
    if (!product) return;
    if (!user) {
      onRequestSignIn();
      return;
    }
    if (!selected) {
      setError('Please select a size.');
      return;
    }

    setError(null);
    try {
      await add(product.id, selected.sku, 1);
      setAdded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add to bag');
    }
  }

  return (
    <Sheet open onClose={onClose} title={product.sku} labelledBy="panel-title">
      <ProductMedia
        src={product.images[0]}
        alt={product.name}
        colorway={product.colorway}
        seed={product.id}
        muted={!product.inStock}
      />

      <div className="detail">
        <h2 id="panel-title" className="detail__name">
          {product.name}
        </h2>
        <p className="detail__meta">
          {titleCase(product.gender)}&rsquo;s {product.category} &middot; {product.brand}
        </p>
        <p className="detail__price">{product.priceFormatted}</p>
        <p className="detail__colorway">{product.colorway}</p>

        <p className="detail__copy">{product.description}</p>

        <h3 className="detail__label">Select Size</h3>
        <div className="sizes sizes--detail" role="group" aria-label="Select size">
          {product.variants.map((variant) => {
            const soldOut = variant.inventory === 0;
            return (
              <button
                key={variant.sku}
                type="button"
                className="size size--detail"
                disabled={soldOut}
                data-active={variant.sku === selectedSku || undefined}
                aria-pressed={variant.sku === selectedSku}
                aria-label={
                  soldOut ? `Size ${variant.size}, unavailable` : `Size ${variant.size}`
                }
                onClick={() => {
                  setSelectedSku(variant.sku);
                  setAdded(false);
                  setError(null);
                }}
              >
                {variant.size}
              </button>
            );
          })}
        </div>

        {/*
          Sizes are labelled explicitly. "Low stock: 11 (3 left)" read as a
          quantity of 11 when 11 was in fact the shoe size — the number needs a
          noun in front of it.
        */}
        {lowStock.length > 0 && (
          <p className="detail__stock">
            {lowStock.map((v) => `Size ${v.size} — only ${v.inventory} left`).join(' · ')}
          </p>
        )}

        {error && (
          <p className="form__banner" role="alert">
            {error}
          </p>
        )}

        {added && (
          <p className="detail__added" role="status">
            Added to your Bag.
          </p>
        )}

        <div className="detail__actions">
          <button
            type="button"
            className="btn btn--solid"
            disabled={!product.inStock || busy}
            onClick={() => void onAdd()}
          >
            {!product.inStock
              ? 'Sold Out'
              : busy
                ? 'Adding…'
                : !user
                  ? 'Sign In to Add'
                  : 'Add to Bag'}
          </button>
          <button type="button" className="btn btn--outline">
            Favourite
          </button>
        </div>

        <dl className="spec">
          <div>
            <dt>Total inventory</dt>
            <dd>{product.totalInventory}</dd>
          </div>
          <div>
            <dt>Available sizes</dt>
            <dd>{product.availableSizes.join(', ') || 'None'}</dd>
          </div>
          <div>
            <dt>Tags</dt>
            <dd>{product.tags.join(', ') || '—'}</dd>
          </div>
        </dl>
      </div>
    </Sheet>
  );
}
