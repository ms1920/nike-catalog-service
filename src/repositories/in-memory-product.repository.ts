import {
  buildPageMeta,
  isInStock,
  type Facets,
  type FacetBucket,
  type Paginated,
  type Product,
  type ProductPatch,
  type ProductQuery,
} from '../domain/product.js';
import { InsufficientStockError } from '../domain/errors.js';
import type { ProductRepository } from './product.repository.js';

/**
 * In-memory implementation backed by a Map.
 *
 * Chosen deliberately for this exercise: no Docker or database is required to
 * run or test the service, so `npm test` works on a clean checkout. The
 * ProductRepository interface is the seam that makes this a reversible
 * decision — see README "Tradeoffs" for the Postgres migration path.
 *
 * Products are cloned on the way in and out so callers cannot mutate stored
 * state by holding a reference. A real store gives you this for free; an
 * in-memory one has to be explicit about it or tests start lying to you.
 */
export class InMemoryProductRepository implements ProductRepository {
  private readonly items = new Map<string, Product>();
  /** Secondary index for SKU lookups, kept in sync with `items`. */
  private readonly skuIndex = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(seed: Product[] = []) {
    this.hydrate(seed);
  }

  /**
   * Change notification for the persistence layer.
   *
   * Deliberately not on the `ProductRepository` interface: a SQL-backed
   * implementation has no use for it, since the database *is* the durable store.
   * This is an in-memory concern only.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Replaces all contents. Used to load a persisted snapshot at startup. */
  hydrate(products: Product[]): void {
    this.items.clear();
    this.skuIndex.clear();
    for (const product of products) {
      this.items.set(product.id, clone(product));
      this.skuIndex.set(product.sku.toLowerCase(), product.id);
    }
  }

  snapshot(): Product[] {
    return [...this.items.values()].map(clone);
  }

  async search(query: ProductQuery): Promise<Paginated<Product>> {
    const matched = this.applyFilters(query);
    const sorted = sortProducts(matched, query);

    const total = sorted.length;
    const offset = (query.page - 1) * query.pageSize;
    const data = sorted.slice(offset, offset + query.pageSize).map(clone);

    return { data, pagination: buildPageMeta(total, query.page, query.pageSize) };
  }

  /**
   * Facet counts are computed over the filtered set so the UI can show
   * "Running (12)" next to each filter option.
   */
  async facets(query: ProductQuery): Promise<Facets> {
    const matched = this.applyFilters(query);

    const prices = matched.map((p) => p.price.amount);
    const currency = matched[0]?.price.currency ?? 'USD';

    return {
      categories: bucketBy(matched, (p) => [p.category]),
      brands: bucketBy(matched, (p) => [p.brand]),
      genders: bucketBy(matched, (p) => [p.gender]),
      sizes: bucketBy(matched, (p) => p.variants.map((v) => v.size)),
      tags: bucketBy(matched, (p) => p.tags),
      priceRange: {
        min: prices.length ? Math.min(...prices) : 0,
        max: prices.length ? Math.max(...prices) : 0,
        currency,
      },
    };
  }

  async findById(id: string): Promise<Product | null> {
    const found = this.items.get(id);
    return found ? clone(found) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    const id = this.skuIndex.get(sku.toLowerCase());
    if (!id) return null;
    return this.findById(id);
  }

  async create(product: Product): Promise<Product> {
    this.items.set(product.id, clone(product));
    this.skuIndex.set(product.sku.toLowerCase(), product.id);
    this.notify();
    return clone(product);
  }

  async update(id: string, patch: ProductPatch): Promise<Product | null> {
    const existing = this.items.get(id);
    if (!existing) return null;

    const updated: Product = {
      ...existing,
      ...stripUndefined(patch),
      updatedAt: new Date().toISOString(),
    };

    this.items.set(id, updated);
    this.notify();
    return clone(updated);
  }

  async setStatus(id: string, status: Product['status']): Promise<Product | null> {
    return this.update(id, { status });
  }

  async adjustInventory(
    id: string,
    variantSku: string,
    delta: number,
  ): Promise<Product | null> {
    const existing = this.items.get(id);
    if (!existing) return null;

    const index = existing.variants.findIndex(
      (v) => v.sku.toLowerCase() === variantSku.toLowerCase(),
    );
    if (index === -1) return null;

    const variant = existing.variants[index]!;
    const next = variant.inventory + delta;
    if (next < 0) {
      throw new InsufficientStockError(variant.sku, Math.abs(delta), variant.inventory);
    }

    // Rebuild the array rather than mutating in place, so any clone already
    // handed to a caller is unaffected.
    const variants = [...existing.variants];
    variants[index] = { ...variant, inventory: next };

    const updated: Product = {
      ...existing,
      variants,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(id, updated);
    this.notify();
    return clone(updated);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  // -------------------------------------------------------------------------

  /**
   * All predicates are AND-ed across filter types and OR-ed within a single
   * multi-value filter — i.e. `category=Running&category=Training&brand=Nike`
   * means "(Running OR Training) AND Nike", which is what a shopper expects
   * from a faceted catalog.
   */
  private applyFilters(query: ProductQuery): Product[] {
    const terms = tokenize(query.q);

    return [...this.items.values()].filter((product) => {
      if (query.status?.length && !query.status.includes(product.status)) return false;
      if (query.category?.length && !containsCI(query.category, product.category))
        return false;
      if (query.brand?.length && !containsCI(query.brand, product.brand)) return false;
      if (query.gender?.length && !query.gender.includes(product.gender)) return false;

      if (query.minPrice !== undefined && product.price.amount < query.minPrice)
        return false;
      if (query.maxPrice !== undefined && product.price.amount > query.maxPrice)
        return false;

      if (query.inStockOnly && !isInStock(product)) return false;

      if (query.size?.length) {
        const sizes = product.variants
          .filter((v) => !query.inStockOnly || v.inventory > 0)
          .map((v) => v.size);
        if (!query.size.some((s) => containsCI(sizes, s))) return false;
      }

      // Tags are AND-ed: asking for `tags=sale&tags=new` means both apply.
      if (query.tags?.length && !query.tags.every((t) => containsCI(product.tags, t))) {
        return false;
      }

      if (terms.length && scoreProduct(product, terms) === 0) return false;

      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Search + sort helpers
// ---------------------------------------------------------------------------

function tokenize(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Deliberately simple weighted term match: a name hit is worth more than a
 * description hit. Every term must appear somewhere (AND semantics), otherwise
 * the score is 0 and the product is filtered out.
 *
 * This is the honest limit of the in-memory store. Real relevance ranking
 * belongs in Postgres full-text search or OpenSearch — see README.
 */
function scoreProduct(product: Product, terms: string[]): number {
  const name = product.name.toLowerCase();
  const colorway = product.colorway.toLowerCase();
  const description = product.description.toLowerCase();
  const brand = product.brand.toLowerCase();
  const category = product.category.toLowerCase();
  const tags = product.tags.map((t) => t.toLowerCase());
  const sku = product.sku.toLowerCase();

  let score = 0;

  for (const term of terms) {
    let termScore = 0;
    if (name.includes(term)) termScore += 10;
    if (sku.includes(term)) termScore += 8;
    if (brand.includes(term)) termScore += 5;
    if (category.includes(term)) termScore += 4;
    if (tags.some((t) => t.includes(term))) termScore += 3;
    if (colorway.includes(term)) termScore += 2;
    if (description.includes(term)) termScore += 1;

    if (termScore === 0) return 0; // every term must match
    score += termScore;
  }

  return score;
}

function sortProducts(products: Product[], query: ProductQuery): Product[] {
  const { field, direction } = query.sort;
  const factor = direction === 'asc' ? 1 : -1;
  const terms = tokenize(query.q);

  // `relevance` only means something when there is a search term; without one
  // it silently degrades to newest-first, which is a sane catalog default.
  if (field === 'relevance') {
    if (!terms.length) {
      return [...products].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return [...products].sort((a, b) => {
      const diff = scoreProduct(b, terms) - scoreProduct(a, terms);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }

  return [...products].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'price':
        cmp = a.price.amount - b.price.amount;
        break;
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'createdAt':
        cmp = a.createdAt.localeCompare(b.createdAt);
        break;
    }
    // Tie-break on id so pagination is stable and deterministic. Without this,
    // two products with the same price can swap places between page 1 and 2.
    return cmp !== 0 ? cmp * factor : a.id.localeCompare(b.id);
  });
}

function bucketBy(products: Product[], extract: (p: Product) => string[]): FacetBucket[] {
  const counts = new Map<string, number>();
  for (const product of products) {
    // Dedupe within a product so a product with two size-10 variants counts once.
    for (const value of new Set(extract(product))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function containsCI(haystack: string[], needle: string): boolean {
  const lowered = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase() === lowered);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
