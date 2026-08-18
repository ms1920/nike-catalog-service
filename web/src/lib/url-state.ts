import { emptyQuery, type CatalogQuery, type SortValue } from './api.js';

/**
 * Serialises catalog query state into the address bar and back.
 *
 * This is what makes a filtered view shareable and the browser Back button
 * behave the way a shopper expects. Without it, refreshing a page of results
 * silently resets every filter — a small omission that feels broken.
 */

const SORTS: SortValue[] = [
  'relevance:desc',
  'price:asc',
  'price:desc',
  'name:asc',
  'createdAt:desc',
];

function csv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function positiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function queryFromLocation(search: string): CatalogQuery {
  const params = new URLSearchParams(search);
  const sortRaw = params.get('sort');

  return {
    q: params.get('q') ?? '',
    category: csv(params.get('category')),
    brand: csv(params.get('brand')),
    gender: csv(params.get('gender')),
    size: csv(params.get('size')),
    minPrice: params.has('minPrice') ? positiveInt(params.get('minPrice'), 0) : null,
    maxPrice: params.has('maxPrice') ? positiveInt(params.get('maxPrice'), 0) : null,
    inStockOnly: params.get('inStockOnly') === 'true',
    sort: SORTS.includes(sortRaw as SortValue) ? (sortRaw as SortValue) : emptyQuery.sort,
    page: positiveInt(params.get('page'), 1),
    pageSize: positiveInt(params.get('pageSize'), emptyQuery.pageSize),
  };
}

/**
 * Only non-default values are written, so a pristine catalog view has a clean
 * URL instead of a wall of `?page=1&pageSize=24&sort=relevance%3Adesc`.
 */
export function locationFromQuery(query: CatalogQuery): string {
  const params = new URLSearchParams();

  if (query.q.trim()) params.set('q', query.q.trim());
  for (const key of ['category', 'brand', 'gender', 'size'] as const) {
    if (query[key].length > 0) params.set(key, query[key].join(','));
  }
  if (query.minPrice !== null) params.set('minPrice', String(query.minPrice));
  if (query.maxPrice !== null) params.set('maxPrice', String(query.maxPrice));
  if (query.inStockOnly) params.set('inStockOnly', 'true');
  if (query.sort !== emptyQuery.sort) params.set('sort', query.sort);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize !== emptyQuery.pageSize)
    params.set('pageSize', String(query.pageSize));

  const serialised = params.toString();
  // Returns the search string only (with leading '?'), or '' when pristine.
  // Callers combine it with the pathname; mixing the two in here made the
  // comparison at the call site ambiguous about what it was comparing.
  return serialised ? `?${serialised}` : '';
}
