/**
 * Presentation helpers.
 *
 * The API already returns `priceFormatted`, so the server is the single source
 * of truth for currency rendering. These helpers cover the cases the server
 * cannot: range labels built from two separate bounds, and pluralisation.
 */

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Paise -> "₹13,295". Whole rupees only, for axis labels and range chips. */
export function paiseToRupeeLabel(paise: number): string {
  return rupees.format(Math.round(paise / 100));
}

export function pluralise(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Nike writes gender facets in title case in the UI, lowercase on the wire. */
export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Deterministic index into a palette or pattern set, derived from a string.
 * Same product always gets the same generated tile — a random pick would make
 * the grid reshuffle its own artwork on every render.
 */
export function stableIndex(seed: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % buckets;
}
