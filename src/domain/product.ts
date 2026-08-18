import { createHash } from 'node:crypto';

/**
 * Domain model.
 *
 * This is the ONLY file that encodes "what a catalog item is". Everything else
 * (repository, service, query/pagination/faceting, HTTP layer, tests) is
 * generic catalog machinery. To retarget this service at a different domain —
 * a Backstage-style service catalog, a CI/CD pipeline registry — you rewrite
 * this file and the seed data, and the rest of the stack follows.
 */

export const GENDERS = ['men', 'women', 'unisex', 'kids'] as const;
export type Gender = (typeof GENDERS)[number];

export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Money is stored as an integer in the currency's minor unit — paise for INR,
 * cents for USD — never as a float. Floats accumulate representation error
 * under arithmetic, which is unacceptable for prices. So ₹13,295.00 is stored
 * as 1_329_500. Rendering it as "₹13,295.00" is a presentation concern.
 */
export interface Money {
  amount: number;
  currency: string;
}

/** A specific purchasable size of a product. Inventory lives here, not on the product. */
export interface Variant {
  sku: string;
  size: string;
  inventory: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  gender: Gender;
  description: string;
  price: Money;
  colorway: string;
  images: string[];
  variants: Variant[];
  tags: string[];
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may set on create. Server owns id and timestamps. */
export type NewProduct = Omit<Product, 'id' | 'createdAt' | 'updatedAt'>;

/** Partial update. SKU is immutable once assigned — it is an external identifier. */
export type ProductPatch = Partial<Omit<Product, 'id' | 'sku' | 'createdAt' | 'updatedAt'>>;

export const SORTABLE_FIELDS = ['name', 'price', 'createdAt', 'relevance'] as const;
export type SortField = (typeof SORTABLE_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  field: SortField;
  direction: SortDirection;
}

/**
 * A fully-resolved query. Defaults are applied at the HTTP boundary so the
 * service and repository never deal with `undefined` page numbers.
 */
export interface ProductQuery {
  q?: string;
  category?: string[];
  brand?: string[];
  gender?: Gender[];
  size?: string[];
  tags?: string[];
  status?: ProductStatus[];
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort: SortSpec;
  page: number;
  pageSize: number;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface Paginated<T> {
  data: T[];
  pagination: PageMeta;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface Facets {
  categories: FacetBucket[];
  brands: FacetBucket[];
  genders: FacetBucket[];
  sizes: FacetBucket[];
  tags: FacetBucket[];
  priceRange: { min: number; max: number; currency: string };
}

// ---------------------------------------------------------------------------
// Pure domain helpers — no I/O, trivially unit-testable.
// ---------------------------------------------------------------------------

export function totalInventory(product: Product): number {
  return product.variants.reduce((sum, v) => sum + v.inventory, 0);
}

export function isInStock(product: Product): boolean {
  return product.variants.some((v) => v.inventory > 0);
}

export function availableSizes(product: Product): string[] {
  return product.variants.filter((v) => v.inventory > 0).map((v) => v.size);
}

/**
 * Defaults to `en-IN` because this catalog is priced in INR, and Indian
 * numbering groups by lakh rather than by thousand: ₹1,50,000.00, not
 * ₹150,000.00. `en-US` would silently render the wrong grouping for any
 * price at or above one lakh.
 *
 * Assumes a 2-decimal minor unit, which holds for INR (paise) and USD (cents)
 * but not for zero-decimal currencies like JPY. A multi-currency catalog would
 * need to read the exponent per currency instead of dividing by 100.
 */
export function formatMoney(money: Money, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
  }).format(money.amount / 100);
}

export function buildPageMeta(total: number, page: number, pageSize: number): PageMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1 && total > 0,
  };
}

/**
 * A strong ETag for a product, derived from its content.
 *
 * Content-derived rather than a version counter, for three reasons: it needs no
 * new field (so the 38-product fixture stays untouched), two edits landing in the
 * same millisecond still produce different tags where an `updatedAt` timestamp
 * would collide, and two genuinely identical states correctly produce the same
 * tag — which is what an ETag is supposed to mean.
 *
 * Keys are sorted before hashing so the tag depends on the product's *values*,
 * not on the insertion order a spread happened to produce.
 */
export function etagFor(product: Product): string {
  const canonical = stableStringify(product);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}
