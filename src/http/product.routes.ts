import { Router, type Request } from 'express';
import type { Config } from '../config.js';
import {
  PreconditionFailedError,
  PreconditionRequiredError,
  ValidationError,
} from '../domain/errors.js';
import {
  availableSizes,
  etagFor,
  formatMoney,
  isInStock,
  totalInventory,
  type Product,
} from '../domain/product.js';
import type { ProductService } from '../services/product.service.js';
import { asyncHandler, requireCatalogWrite } from './middleware.js';
import {
  adjustInventorySchema,
  createProductSchema,
  parseProductQuery,
  updateProductSchema,
} from './product.schemas.js';

/**
 * Express 5 types path params as `string | string[] | undefined`. This narrows
 * to a non-empty string once, at the boundary, instead of casting at each use.
 */
function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Missing or invalid path parameter '${name}'`, {
      param: name,
    });
  }
  return value;
}

/**
 * Strips the quoting and weak-validator prefix an ETag travels with, so
 * `W/"abc"`, `"abc"` and `abc` all compare equal to the stored tag.
 */
function normaliseEtag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/**
 * Routes are a thin translation layer: parse and validate input, call the
 * service, shape the response. No business logic here — that keeps handlers
 * boring and makes the service independently testable.
 */
export function productRoutes(service: ProductService, config: Config): Router {
  const router = Router();
  // Catalog mutations need either a valid API key (machine callers) or an
  // authenticated admin (a human in the storefront).
  const authed = requireCatalogWrite(config);

  /**
   * Products are enriched on the way out with derived read-model fields
   * (inStock, totalInventory, formatted price). These are computed, never
   * stored, so they cannot drift from the underlying variants.
   */
  const present = (product: Product) => ({
    ...product,
    inStock: isInStock(product),
    totalInventory: totalInventory(product),
    availableSizes: availableSizes(product),
    priceFormatted: formatMoney(product.price),
  });

  // GET /products — search, filter, sort, paginate.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = parseProductQuery(req.query, config);
      const result = await service.search(query);

      res.json({
        data: result.data.map(present),
        pagination: result.pagination,
        // Echoing the resolved query makes the API self-documenting: clients can
        // see exactly which defaults and clamps were applied to their request.
        query: {
          q: query.q ?? null,
          filters: {
            category: query.category ?? null,
            brand: query.brand ?? null,
            gender: query.gender ?? null,
            size: query.size ?? null,
            tags: query.tags ?? null,
            status: query.status ?? null,
            minPrice: query.minPrice ?? null,
            maxPrice: query.maxPrice ?? null,
            inStockOnly: query.inStockOnly ?? false,
          },
          sort: query.sort,
        },
      });
    }),
  );

  /**
   * GET /products/facets — filter-option counts for the current result set.
   * Registered before `/:id` so "facets" is not swallowed as an id.
   */
  router.get(
    '/facets',
    asyncHandler(async (req, res) => {
      const query = parseProductQuery(req.query, config);
      res.json({ data: await service.facets(query) });
    }),
  );

  router.get(
    '/sku/:sku',
    asyncHandler(async (req, res) => {
      const product = await service.getBySku(pathParam(req, 'sku'));
      res.json({ data: present(product) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const product = await service.getById(pathParam(req, 'id'));

      // The ETag a client must echo back in `If-Match` to update this product.
      const tag = etagFor(product);
      res.setHeader('ETag', `"${tag}"`);

      // Cheap conditional GET as a bonus: an unchanged product costs a 304 with
      // no body instead of re-serialising the whole thing.
      if (normaliseEtag(req.header('if-none-match') ?? '') === tag) {
        res.status(304).end();
        return;
      }

      res.json({ data: present(product) });
    }),
  );

  router.post(
    '/',
    authed,
    asyncHandler(async (req, res) => {
      const input = createProductSchema.parse(req.body);
      const created = await service.create(input);
      // 201 + Location is the correct contract for resource creation.
      res
        .status(201)
        .location(`/api/v1/products/${created.id}`)
        .json({ data: present(created) });
    }),
  );

  /**
   * Optimistic concurrency.
   *
   * `If-Match` carries the ETag the client last read. If the product has changed
   * since, the write is rejected with 412 rather than applied — which is what
   * prevents the lost-update problem: two editors who both loaded version A would
   * otherwise each write their change, and the second would silently erase the
   * first.
   *
   * The header is required rather than optional. Making it optional means the
   * unsafe path is the default one, and every client that forgets gets
   * last-write-wins without ever being told. `If-Match: *` is accepted as an
   * explicit opt-out for callers that genuinely want to overwrite blind.
   */
  router.patch(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      const patch = updateProductSchema.parse(req.body);
      const id = pathParam(req, 'id');

      const ifMatch = req.header('if-match');
      if (!ifMatch) throw new PreconditionRequiredError('If-Match');

      const current = await service.getById(id);
      const currentTag = etagFor(current);

      if (ifMatch !== '*' && normaliseEtag(ifMatch) !== currentTag) {
        throw new PreconditionFailedError(normaliseEtag(ifMatch), currentTag);
      }

      const updated = await service.update(id, patch);
      res.setHeader('ETag', `"${etagFor(updated)}"`);
      res.json({ data: present(updated) });
    }),
  );

  /** Soft delete — sets status to `archived`. See ProductService.archive. */
  router.delete(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      const archived = await service.archive(pathParam(req, 'id'));
      res.json({ data: present(archived) });
    }),
  );

  router.post(
    '/:id/variants/:sku/inventory',
    authed,
    asyncHandler(async (req, res) => {
      const { delta } = adjustInventorySchema.parse(req.body);
      const updated = await service.adjustInventory(
        pathParam(req, 'id'),
        pathParam(req, 'sku'),
        delta,
      );
      res.json({ data: present(updated) });
    }),
  );

  return router;
}
