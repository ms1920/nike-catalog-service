import { z } from 'zod';
import {
  GENDERS,
  PRODUCT_STATUSES,
  SORTABLE_FIELDS,
  type ProductQuery,
  type ProductStatus,
  type SortSpec,
} from '../domain/product.js';
import type { Config } from '../config.js';

/**
 * Request validation lives at the HTTP boundary. Untrusted input is parsed into
 * typed domain values here and nowhere else, so every layer below this can
 * assume its inputs are well-formed.
 */

/** Query strings give `?a=1` as a string and `?a=1&a=2` as an array. Normalize both. */
const csvList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter(Boolean),
  );

const optionalCsvList = csvList.optional();

const positiveIntString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number);

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const moneySchema = z.object({
  // Integer minor units. Rejecting floats here is what keeps `19.999` out of
  // the datastore entirely rather than discovering it at checkout.
  amount: z
    .number()
    .int('price.amount must be an integer number of minor units (cents)')
    .nonnegative(),
  currency: z
    .string()
    .length(3, 'currency must be a 3-letter ISO 4217 code')
    .transform((c) => c.toUpperCase()),
});

const variantSchema = z.object({
  sku: z.string().min(1).max(64),
  size: z.string().min(1).max(16),
  inventory: z.number().int().nonnegative(),
});

export const createProductSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  brand: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  gender: z.enum(GENDERS),
  description: z.string().max(5000).default(''),
  price: moneySchema,
  colorway: z.string().max(120).default(''),
  images: z.array(z.string().url('each image must be a valid URL')).default([]),
  variants: z.array(variantSchema).min(1, 'a product needs at least one variant'),
  tags: z.array(z.string().min(1).max(50)).default([]),
  status: z.enum(PRODUCT_STATUSES).default('draft'),
});

/**
 * PATCH semantics: every field optional, but reject `{}` outright. An empty
 * patch is almost always a client bug, and silently returning 200 hides it.
 */
export const updateProductSchema = createProductSchema
  .omit({ sku: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Request body must contain at least one field to update',
  });

export const adjustInventorySchema = z.object({
  delta: z
    .number()
    .int()
    .refine((d) => d !== 0, { message: '`delta` must not be zero' }),
});

const rawQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    category: optionalCsvList,
    brand: optionalCsvList,
    gender: optionalCsvList,
    size: optionalCsvList,
    tags: optionalCsvList,
    status: optionalCsvList,
    minPrice: positiveIntString.optional(),
    maxPrice: positiveIntString.optional(),
    inStockOnly: booleanString.optional(),
    sort: z.string().optional(),
    page: positiveIntString.optional(),
    pageSize: positiveIntString.optional(),
  })
  .strict();

/** `sort=price:asc` — field and direction in one compact param. */
function parseSort(raw: string | undefined): SortSpec {
  if (!raw) return { field: 'relevance', direction: 'desc' };

  const [field, direction = 'asc'] = raw.split(':');

  const parsedField = z.enum(SORTABLE_FIELDS).safeParse(field);
  if (!parsedField.success) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['sort'],
        message: `Unsupported sort field '${field}'. Allowed: ${SORTABLE_FIELDS.join(', ')}`,
      },
    ]);
  }

  const parsedDirection = z.enum(['asc', 'desc']).safeParse(direction);
  if (!parsedDirection.success) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['sort'],
        message: `Unsupported sort direction '${direction}'. Allowed: asc, desc`,
      },
    ]);
  }

  return { field: parsedField.data, direction: parsedDirection.data };
}

/**
 * Turns a raw query string into a fully-defaulted ProductQuery.
 *
 * Two defaults worth calling out:
 *  - `status` defaults to ['active'], so drafts and archived products never
 *    leak into a public listing by accident. Callers must opt in explicitly.
 *  - `pageSize` is clamped to `config.maxPageSize` rather than rejected, so a
 *    slightly-too-large request still succeeds.
 */
export function parseProductQuery(raw: unknown, config: Config): ProductQuery {
  const parsed = rawQuerySchema.parse(raw);
  const sort = parseSort(parsed.sort);

  const gender = parsed.gender
    ? z.array(z.enum(GENDERS)).parse(parsed.gender.map((g) => g.toLowerCase()))
    : undefined;

  const status: ProductStatus[] = parsed.status
    ? z.array(z.enum(PRODUCT_STATUSES)).parse(parsed.status.map((s) => s.toLowerCase()))
    : ['active'];

  if (
    parsed.minPrice !== undefined &&
    parsed.maxPrice !== undefined &&
    parsed.minPrice > parsed.maxPrice
  ) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['minPrice'],
        message: '`minPrice` must be less than or equal to `maxPrice`',
      },
    ]);
  }

  return {
    q: parsed.q,
    category: parsed.category,
    brand: parsed.brand,
    gender,
    size: parsed.size,
    tags: parsed.tags,
    status,
    minPrice: parsed.minPrice,
    maxPrice: parsed.maxPrice,
    inStockOnly: parsed.inStockOnly,
    sort,
    page: Math.max(1, parsed.page ?? 1),
    pageSize: Math.min(parsed.pageSize ?? config.defaultPageSize, config.maxPageSize),
  };
}
