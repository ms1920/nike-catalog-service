import { useAuth } from '../state/auth.js';
import { useCart } from '../state/cart.js';
import { Swoosh } from './Swoosh.js';

/**
 * Edge-aligned masthead: Swoosh hard against the left gutter, utility hard
 * against the right, one hairline beneath. Nike's own header is this thin and
 * this quiet — the wordmark is the Swoosh alone, with no "NIKE" text beside it.
 */
interface MastheadProps {
  searchDraft: string;
  onSearchChange: (value: string) => void;
  resultCount: number | null;
  onOpenCart: () => void;
  onOpenAuth: () => void;
}

export function Masthead({
  searchDraft,
  onSearchChange,
  resultCount,
  onOpenCart,
  onOpenAuth,
}: MastheadProps) {
  const { user, initialising, signOut } = useAuth();
  const { cart } = useCart();
  const bagCount = cart?.itemCount ?? 0;

  return (
    <header className="masthead">
      <a className="masthead__brand" href="/" aria-label="Nike home">
        <Swoosh size={52} />
      </a>

      <nav className="masthead__nav" aria-label="Primary">
        <a href="/" aria-current="page">
          New &amp; Featured
        </a>
        <a href="/">Men</a>
        <a href="/">Women</a>
        <a href="/">Kids</a>
      </nav>

      <div className="masthead__utility">
        <form className="search" role="search" onSubmit={(event) => event.preventDefault()}>
          <label className="sr-only" htmlFor="catalog-search">
            Search products
          </label>
          <svg className="search__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="11"
              cy="11"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M16.5 16.5 21 21"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
            />
          </svg>
          <input
            id="catalog-search"
            className="search__input"
            type="search"
            placeholder="Search"
            value={searchDraft}
            onChange={(event) => onSearchChange(event.target.value)}
            autoComplete="off"
          />
          {searchDraft && (
            <button
              type="button"
              className="search__clear"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </form>

        {/*
          A real count from the API, or nothing. Never a placeholder number.
          Labelled, because a lone "37" next to a search box is as ambiguous as a
          bare name next to Sign Out.
        */}
        {resultCount !== null && (
          <output className="masthead__count" aria-live="polite">
            {resultCount} <span className="masthead__count-label">items</span>
          </output>
        )}

        {/* `initialising` guards against a flash of "Sign In" for a user whose
            stored token is still being validated. */}
        {!initialising &&
          (user ? (
            <div className="account">
              {/* The icon is what makes the name legible as account identity.
                  Rendered bare, a first name beside "Sign Out" reads as stray
                  text with no indication of what it refers to. */}
              <span className="account__badge" title={`${user.name} · ${user.email}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true" className="account__icon">
                  <circle
                    cx="12"
                    cy="8"
                    r="3.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M5.5 20a6.5 6.5 0 0 1 13 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                </svg>
                <span className="account__name">{user.name.split(' ')[0]}</span>
              </span>
              <button type="button" className="link-button" onClick={() => void signOut()}>
                Sign Out
              </button>
            </div>
          ) : (
            <button type="button" className="link-button" onClick={onOpenAuth}>
              Sign In
            </button>
          ))}

        <button
          type="button"
          className="bag"
          onClick={onOpenCart}
          aria-label={bagCount > 0 ? `Bag, ${bagCount} items` : 'Bag, empty'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="bag__icon">
            <path
              d="M6 8h12l-1 12H7L6 8Zm3 0V6a3 3 0 0 1 6 0v2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
          {bagCount > 0 && <span className="bag__count">{bagCount}</span>}
        </button>
      </div>
    </header>
  );
}
