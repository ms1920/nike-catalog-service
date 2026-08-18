import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchFacets,
  fetchProducts,
  type CatalogQuery,
  type Facets,
  type PageMeta,
  type Product,
} from '../lib/api.js';
import { locationFromQuery, queryFromLocation } from '../lib/url-state.js';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface CatalogState {
  products: Product[];
  pagination: PageMeta | null;
  facets: Facets | null;
  status: Status;
  error: string | null;
}

const initialState: CatalogState = {
  products: [],
  pagination: null,
  facets: null,
  status: 'idle',
  error: null,
};

/**
 * Owns catalog query state and the data it resolves to.
 *
 * Three things this deliberately handles, because each is a visible bug when
 * omitted:
 *  - **Abort in-flight requests.** Typing in the search box fires a request per
 *    keystroke-batch; without aborting, a slow early response can land after a
 *    fast later one and overwrite fresh results with stale ones.
 *  - **Debounce the search term only.** Clicking a filter should feel instant, so
 *    only free-text input waits.
 *  - **Keep the previous page visible while loading.** Blanking the grid on every
 *    filter change makes the UI flash; the list dims instead.
 */
export function useCatalog() {
  const [query, setQuery] = useState<CatalogQuery>(() =>
    queryFromLocation(window.location.search),
  );
  const [state, setState] = useState<CatalogState>(initialState);

  // The raw input value is tracked separately from the committed query so the
  // text field stays responsive while the request is debounced.
  const [searchDraft, setSearchDraft] = useState(query.q);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((prev) =>
        prev.q === searchDraft ? prev : { ...prev, q: searchDraft, page: 1 },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  // Reflect committed state in the URL without adding a history entry per
  // keystroke — replaceState keeps Back meaning "the previous view".
  useEffect(() => {
    const nextSearch = locationFromQuery(query);
    // Compare like with like: both sides are a search string ('' or '?a=b').
    if (nextSearch !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${nextSearch}`);
    }
  }, [query]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({ ...prev, status: 'loading', error: null }));

    Promise.all([
      fetchProducts(query, controller.signal),
      fetchFacets(query, controller.signal),
    ])
      .then(([list, facets]) => {
        if (controller.signal.aborted) return;
        setState({
          products: list.data,
          pagination: list.pagination,
          facets,
          status: 'ready',
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error as Error).name === 'AbortError') return;
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: error instanceof Error ? error.message : 'Something went wrong',
        }));
      });

    return () => controller.abort();
  }, [query]);

  /** Any filter change resets to page 1 — staying on page 4 of a 2-page result is a dead end. */
  const patchQuery = useCallback((patch: Partial<CatalogQuery>) => {
    setQuery((prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }));
  }, []);

  const toggleFacet = useCallback(
    (key: 'category' | 'brand' | 'gender' | 'size', value: string) => {
      setQuery((prev) => {
        const current = prev[key];
        const next = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
        return { ...prev, [key]: next, page: 1 };
      });
    },
    [],
  );

  const goToPage = useCallback((page: number) => {
    setQuery((prev) => ({ ...prev, page }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const clearAll = useCallback(() => {
    setSearchDraft('');
    setQuery((prev) => ({
      ...prev,
      q: '',
      category: [],
      brand: [],
      gender: [],
      size: [],
      minPrice: null,
      maxPrice: null,
      inStockOnly: false,
      page: 1,
    }));
  }, []);

  const activeFilterCount =
    query.category.length +
    query.brand.length +
    query.gender.length +
    query.size.length +
    (query.inStockOnly ? 1 : 0) +
    (query.minPrice !== null || query.maxPrice !== null ? 1 : 0) +
    (query.q.trim() ? 1 : 0);

  return {
    query,
    searchDraft,
    setSearchDraft,
    patchQuery,
    toggleFacet,
    goToPage,
    clearAll,
    activeFilterCount,
    ...state,
  };
}
