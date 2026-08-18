import { useState } from 'react';
import { useCatalog } from './hooks/useCatalog.js';
import type { Product } from './lib/api.js';
import { AuthProvider } from './state/auth.js';
import { CartProvider } from './state/cart.js';
import { Masthead } from './components/Masthead.js';
import { FilterRail } from './components/FilterRail.js';
import { Toolbar } from './components/Toolbar.js';
import { ProductCard } from './components/ProductCard.js';
import { Pagination } from './components/Pagination.js';
import { ProductPanel } from './components/ProductPanel.js';
import { AuthSheet } from './components/AuthSheet.js';
import { CartSheet } from './components/CartSheet.js';

export default function App() {
  return (
    // Cart sits inside Auth because it loads on sign-in and clears on sign-out.
    <AuthProvider>
      <CartProvider>
        <Storefront />
      </CartProvider>
    </AuthProvider>
  );
}

function Storefront() {
  const catalog = useCatalog();
  const [selected, setSelected] = useState<Product | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const { products, pagination, facets, status, error } = catalog;
  const isFirstLoad = status === 'loading' && products.length === 0;

  /**
   * Only one sheet is ever open. Without this, "Sign In to Add" from the product
   * panel would stack the auth form on top of it, trapping focus in two dialogs
   * at once.
   */
  function openAuth() {
    setSelected(null);
    setCartOpen(false);
    setAuthOpen(true);
  }

  function openCart() {
    setSelected(null);
    setAuthOpen(false);
    setCartOpen(true);
  }

  return (
    <>
      <Masthead
        searchDraft={catalog.searchDraft}
        onSearchChange={catalog.setSearchDraft}
        resultCount={pagination?.total ?? null}
        onOpenCart={openCart}
        onOpenAuth={openAuth}
      />

      <div className="shell">
        <div className="shell__rail" data-open={railOpen || undefined}>
          <FilterRail
            query={catalog.query}
            facets={facets}
            activeFilterCount={catalog.activeFilterCount}
            onToggle={catalog.toggleFacet}
            onPatch={catalog.patchQuery}
            onClear={catalog.clearAll}
          />
          <button
            type="button"
            className="btn btn--solid shell__rail-done"
            onClick={() => setRailOpen(false)}
          >
            Show {pagination?.total ?? 0} results
          </button>
        </div>

        {railOpen && (
          <div
            className="shell__rail-scrim"
            onClick={() => setRailOpen(false)}
            role="presentation"
          />
        )}

        <main className="shell__main">
          <Toolbar
            query={catalog.query}
            total={pagination?.total ?? null}
            onPatch={catalog.patchQuery}
            onOpenFilters={() => setRailOpen(true)}
            activeFilterCount={catalog.activeFilterCount}
          />

          {status === 'error' && (
            <div className="notice notice--error" role="alert">
              <p className="notice__title">Could not load the catalog</p>
              <p className="notice__body">{error}</p>
              <p className="notice__hint">
                Is the API running on port 3000? Start it with <code>npm run dev</code>.
              </p>
            </div>
          )}

          {isFirstLoad && (
            <div className="grid" aria-busy="true" aria-label="Loading products">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skeleton">
                  <div className="skeleton__media" />
                  <div className="skeleton__line skeleton__line--wide" />
                  <div className="skeleton__line" />
                  <div className="skeleton__line skeleton__line--short" />
                </div>
              ))}
            </div>
          )}

          {!isFirstLoad && status !== 'error' && products.length === 0 && (
            <div className="notice">
              <p className="notice__title">No products match those filters</p>
              <p className="notice__body">
                Try removing a filter or widening the price range.
              </p>
              {catalog.activeFilterCount > 0 && (
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={catalog.clearAll}
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}

          {products.length > 0 && (
            <>
              {/*
                The grid dims rather than unmounting while a new query resolves.
                Blanking it on every filter click makes the page strobe.
              */}
              <div className="grid" data-pending={status === 'loading' || undefined}>
                {products.map((product) => (
                  <ProductCard key={product.id} product={product} onOpen={setSelected} />
                ))}
              </div>

              {pagination && <Pagination pagination={pagination} onGo={catalog.goToPage} />}
            </>
          )}
        </main>
      </div>

      <footer className="footer">
        <UtilityFooter />
      </footer>

      <ProductPanel
        product={selected}
        onClose={() => setSelected(null)}
        onRequestSignIn={openAuth}
      />
      <CartSheet
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onRequestSignIn={openAuth}
      />
      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}

/**
 * Utility footer: one line of real, verifiable facts.
 *
 * Deliberately not four columns of invented links plus a social row — that
 * pattern is the single most recognisable generated-page fingerprint, and every
 * link in it would be a dead `href="#"`.
 */
function UtilityFooter() {
  return (
    <p className="footer__line">
      <span>Nike Catalog Service</span>
      <span aria-hidden="true">/</span>
      <span>API v1</span>
      <span aria-hidden="true">/</span>
      <span>Prices in INR, stored as paise</span>
      <span aria-hidden="true">/</span>
      <span>Interview exercise — not affiliated with Nike, Inc.</span>
    </p>
  );
}
