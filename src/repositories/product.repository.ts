import type {
  Facets,
  Paginated,
  Product,
  ProductPatch,
  ProductQuery,
} from '../domain/product.js';

/**
 * Persistence boundary.
 *
 * The service depends on this interface, never on a concrete store. Swapping
 * the in-memory implementation for Postgres/DynamoDB means writing one new
 * class — no service or HTTP changes, and the existing service unit tests keep
 * passing against a fake.
 *
 * Filtering, sorting and pagination are deliberately pushed DOWN here rather
 * than done in the service. A real database must do this work in the query
 * (you cannot load a million rows into Node to filter them), so the in-memory
 * implementation mirrors that contract honestly.
 */
export interface ProductRepository {
  search(query: ProductQuery): Promise<Paginated<Product>>;
  facets(query: ProductQuery): Promise<Facets>;
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  create(product: Product): Promise<Product>;
  update(id: string, patch: ProductPatch): Promise<Product | null>;
  /** Returns the updated product, or null if not found. */
  setStatus(id: string, status: Product['status']): Promise<Product | null>;
  /**
   * Atomically applies a signed delta to a variant's inventory.
   * Returns null if the product or variant does not exist.
   * Throws if the resulting inventory would go negative.
   */
  adjustInventory(id: string, variantSku: string, delta: number): Promise<Product | null>;
  count(): Promise<number>;
}
