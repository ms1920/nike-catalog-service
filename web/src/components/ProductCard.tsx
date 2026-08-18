import type { Product } from '../lib/api.js';
import { titleCase } from '../lib/format.js';
import { ProductMedia } from './ProductMedia.js';

/**
 * Every string on this card comes from the API. Nike's real product tile shows
 * a badge, a name, one subtitle line and a price — nothing else. No star
 * ratings, no review counts, no "bestseller" flags, because the API does not
 * expose those and inventing them would be fabricated social proof.
 */

/** Badges are derived from real tags, in priority order. At most one shows. */
function badgeFor(product: Product): { label: string; tone: 'sale' | 'ink' } | null {
  if (product.tags.includes('sale')) return { label: 'Sale', tone: 'sale' };
  if (product.tags.includes('limited')) return { label: 'Limited', tone: 'sale' };
  if (product.tags.includes('new')) return { label: 'Just In', tone: 'ink' };
  return null;
}

interface ProductCardProps {
  product: Product;
  onOpen: (product: Product) => void;
}

export function ProductCard({ product, onOpen }: ProductCardProps) {
  const badge = badgeFor(product);
  const soldOut = !product.inStock;

  return (
    <article className="card">
      {/*
        The whole tile is one button rather than a link because this opens a
        detail panel in place — there is no separate route to navigate to. A
        real storefront would use an <a href="/t/{slug}"> so the card is
        middle-clickable and crawlable.
      */}
      <button
        type="button"
        className="card__hit"
        onClick={() => onOpen(product)}
        aria-label={`${product.name}, ${product.priceFormatted}${soldOut ? ', sold out' : ''}`}
      >
        <ProductMedia
          src={product.images[0]}
          alt={product.name}
          colorway={product.colorway}
          seed={product.id}
          muted={soldOut}
        />

        <div className="card__body">
          <div className="card__labels">
            {badge && (
              <span className="label" data-tone={badge.tone}>
                {badge.label}
              </span>
            )}
            {soldOut && (
              <span className="label" data-tone="muted">
                Sold Out
              </span>
            )}
          </div>

          <h3 className="card__name">{product.name}</h3>
          <p className="card__meta">
            {titleCase(product.gender)}&rsquo;s {product.category}
          </p>
          <p className="card__meta card__meta--dim">{product.colorway}</p>
          <p className="card__price">{product.priceFormatted}</p>
        </div>
      </button>
    </article>
  );
}
