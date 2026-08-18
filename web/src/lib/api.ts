/**
 * Typed API client.
 *
 * Wire types are declared here rather than imported from `src/` on purpose: the
 * browser bundle must not be able to reach server code. The duplication is the
 * cost of that boundary. In a production repo these types would be generated
 * from an OpenAPI spec derived from the server's Zod schemas, so they could not
 * drift silently.
 */

export type Gender = 'men' | 'women' | 'unisex' | 'kids';
export type ProductStatus = 'active' | 'draft' | 'archived';

export interface Money {
  /** Integer minor units — paise for INR. */
  amount: number;
  currency: string;
}

export interface Variant {
  sku: string;
  size: string;
  inventory: number;
}

/** A product as returned by the API, including server-derived read-model fields. */
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
  inStock: boolean;
  totalInventory: number;
  availableSizes: string[];
  priceFormatted: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
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

export interface ProductListResponse {
  data: Product[];
  pagination: PageMeta;
}

export type SortValue =
  'relevance:desc' | 'price:asc' | 'price:desc' | 'name:asc' | 'createdAt:desc';

/** Client-side query state. Mirrors the subset of API params the UI exposes. */
export interface CatalogQuery {
  q: string;
  category: string[];
  brand: string[];
  gender: string[];
  size: string[];
  minPrice: number | null;
  maxPrice: number | null;
  inStockOnly: boolean;
  sort: SortValue;
  page: number;
  pageSize: number;
}

export const emptyQuery: CatalogQuery = {
  q: '',
  category: [],
  brand: [],
  gender: [],
  size: [],
  minPrice: null,
  maxPrice: null,
  inStockOnly: false,
  sort: 'relevance:desc',
  page: 1,
  pageSize: 24,
};

/**
 * The API rejects unknown query parameters and empty values with a 400 — a
 * deliberate strictness so typo'd filters fail loudly. That means the client
 * must omit empty params rather than send `q=`, so this builder skips anything
 * blank instead of serialising it.
 */
export function toSearchParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();

  const trimmed = query.q.trim();
  if (trimmed) params.set('q', trimmed);

  for (const key of ['category', 'brand', 'gender', 'size'] as const) {
    const values = query[key];
    if (values.length > 0) params.set(key, values.join(','));
  }

  if (query.minPrice !== null) params.set('minPrice', String(query.minPrice));
  if (query.maxPrice !== null) params.set('maxPrice', String(query.maxPrice));
  if (query.inStockOnly) params.set('inStockOnly', 'true');

  params.set('sort', query.sort);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));

  return params;
}

/** A field-level validation failure, as returned by the server's Zod layer. */
export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    /** Present on VALIDATION_ERROR: which fields failed and why. */
    readonly details?: FieldIssue[] | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Extracts a message for a specific form field, so a signup form can show
   * "must be at least 12 characters" under the password input rather than
   * dumping the whole error at the top.
   */
  fieldError(field: string): string | null {
    if (!Array.isArray(this.details)) return null;
    return this.details.find((issue) => issue.path === field)?.message ?? null;
  }
}

interface ErrorBody {
  error?: {
    message?: string;
    code?: string;
    requestId?: string;
    details?: FieldIssue[] | Record<string, unknown>;
  };
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    // Surface the server's structured error, including the request id, so a
    // failure in the UI can be traced to a specific server log line.
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new ApiError(
      body.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.requestId,
    );
  }

  return (await response.json()) as T;
}

export function fetchProducts(
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<ProductListResponse> {
  return request<ProductListResponse>(`/api/v1/products?${toSearchParams(query)}`, signal);
}

export async function fetchFacets(
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<Facets> {
  // Facets describe the whole filtered set, so paging params are irrelevant and
  // would only cause needless cache misses.
  const params = toSearchParams({ ...query, page: 1 });
  params.delete('page');
  params.delete('pageSize');
  params.delete('sort');

  const body = await request<{ data: Facets }>(`/api/v1/products/facets?${params}`, signal);
  return body.data;
}

export async function fetchProduct(id: string, signal?: AbortSignal): Promise<Product> {
  const body = await request<{ data: Product }>(`/api/v1/products/${id}`, signal);
  return body.data;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type UserRole = 'customer' | 'admin';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

/**
 * Called when an authenticated request comes back 401.
 *
 * Lets the auth provider tear down a session the server has already rejected,
 * instead of leaving a UI that claims to be signed in while every request fails.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/**
 * Persisted so a refresh doesn't sign the user out.
 *
 * `localStorage` is readable by any script on the page, so an XSS becomes a token
 * theft. The stronger design is an httpOnly, Secure, SameSite refresh cookie plus
 * a short-lived in-memory access token; this is the deliberate simplification for
 * an exercise, recorded in the README rather than pretended away.
 */
const TOKEN_KEY = 'nike.catalog.token';

export function loadStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Safari private mode and similar throw on access rather than returning null.
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Storage unavailable — the session simply won't survive a refresh. */
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** When true, attach the bearer token. */
  authed?: boolean;
  /** Extra headers, e.g. `Idempotency-Key` or `If-Match`. */
  headers?: Record<string, string>;
}

async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, authed = false } = options;

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...options.headers,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  // Read the token at request time from the one place it lives.
  //
  // An earlier version cached it in a module variable set by the auth provider.
  // That created two sources of truth, and they desynced in practice: a Vite HMR
  // reload re-evaluates this module and resets the variable to null while React
  // state survives, so the header showed "signed in" and every request went out
  // anonymous and 401'd. Reading storage per request is a few microseconds and
  // cannot drift.
  if (authed) {
    const token = loadStoredToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let parsed: ErrorBody = {};
    try {
      parsed = (await response.json()) as ErrorBody;
    } catch {
      /* non-JSON error body */
    }

    // A rejected session must not leave a signed-in-looking UI behind. This also
    // covers the in-memory store losing every session on server restart.
    if (response.status === 401 && authed) {
      storeToken(null);
      onUnauthorized?.();
    }

    throw new ApiError(
      parsed.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      parsed.error?.code ?? 'UNKNOWN',
      parsed.error?.requestId,
      parsed.error?.details,
    );
  }

  return (await response.json()) as T;
}

export async function signup(
  email: string,
  name: string,
  password: string,
): Promise<AuthResult> {
  const body = await send<{ data: AuthResult }>('/api/v1/users', {
    method: 'POST',
    body: { email, name, password },
  });
  return body.data;
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const body = await send<{ data: AuthResult }>('/api/v1/users/sessions', {
    method: 'POST',
    body: { email, password },
  });
  return body.data;
}

export async function logout(): Promise<void> {
  await send<void>('/api/v1/users/sessions/current', { method: 'DELETE', authed: true });
}

export async function fetchMe(signal?: AbortSignal): Promise<PublicUser> {
  const body = await send<{ data: PublicUser }>('/api/v1/users/me', {
    authed: true,
    signal,
  });
  return body.data;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartLine {
  productId: string;
  variantSku: string;
  quantity: number;
  size: string;
  name: string;
  brand: string;
  category: string;
  colorway: string;
  image: string | null;
  unitPrice: Money;
  unitPriceFormatted: string;
  lineTotal: Money;
  lineTotalFormatted: string;
  availableInventory: number;
  exceedsStock: boolean;
}

export interface PricedCart {
  userId: string;
  lines: CartLine[];
  itemCount: number;
  lineCount: number;
  subtotal: Money;
  subtotalFormatted: string;
  currency: string;
  hasIssues: boolean;
  updatedAt: string;
}

export interface OrderLine {
  productId: string;
  variantSku: string;
  name: string;
  size: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
}

export interface Order {
  id: string;
  userId: string;
  lines: OrderLine[];
  itemCount: number;
  total: Money;
  totalFormatted: string;
  placedAt: string;
}

export async function fetchCart(signal?: AbortSignal): Promise<PricedCart> {
  const body = await send<{ data: PricedCart }>('/api/v1/cart', { authed: true, signal });
  return body.data;
}

export async function addCartItem(
  productId: string,
  variantSku: string,
  quantity = 1,
): Promise<PricedCart> {
  const body = await send<{ data: PricedCart }>('/api/v1/cart/items', {
    method: 'POST',
    authed: true,
    body: { productId, variantSku, quantity },
  });
  return body.data;
}

export async function setCartQuantity(
  variantSku: string,
  quantity: number,
): Promise<PricedCart> {
  const body = await send<{ data: PricedCart }>(
    `/api/v1/cart/items/${encodeURIComponent(variantSku)}`,
    { method: 'PATCH', authed: true, body: { quantity } },
  );
  return body.data;
}

export async function removeCartItem(variantSku: string): Promise<PricedCart> {
  const body = await send<{ data: PricedCart }>(
    `/api/v1/cart/items/${encodeURIComponent(variantSku)}`,
    { method: 'DELETE', authed: true },
  );
  return body.data;
}

export async function clearCart(): Promise<PricedCart> {
  const body = await send<{ data: PricedCart }>('/api/v1/cart', {
    method: 'DELETE',
    authed: true,
  });
  return body.data;
}

/**
 * Places the order.
 *
 * The caller supplies the idempotency key and keeps it stable across retries —
 * generating one here would defeat the point, since a fresh key on every attempt
 * is indistinguishable from a fresh order.
 */
export async function checkout(idempotencyKey: string): Promise<Order> {
  const body = await send<{ data: Order }>('/api/v1/cart/checkout', {
    method: 'POST',
    authed: true,
    headers: { 'idempotency-key': idempotencyKey },
  });
  return body.data;
}

/**
 * A key for one checkout attempt, stable across retries of that attempt.
 *
 * `crypto.randomUUID` needs a secure context; a plain HTTP origin other than
 * localhost does not get it, so this falls back rather than throwing.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `chk-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
