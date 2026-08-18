import type { CatalogQuery, Facets } from '../lib/api.js';
import { paiseToRupeeLabel, titleCase } from '../lib/format.js';

/**
 * The filter rail.
 *
 * Nike's own facets are plain text with a count and no chrome — no boxed
 * cards, no accordion chevrons on every group, no coloured pills. Counts come
 * straight from the API's /facets endpoint, so they narrow as filters apply
 * and a zero-result option simply is not listed.
 */

interface FilterRailProps {
  query: CatalogQuery;
  facets: Facets | null;
  activeFilterCount: number;
  onToggle: (key: 'category' | 'brand' | 'gender' | 'size', value: string) => void;
  onPatch: (patch: Partial<CatalogQuery>) => void;
  onClear: () => void;
}

/** Bands are in paise. Kept coarse — six bands is a filter, twelve is a chore. */
const PRICE_BANDS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: 'Under ₹5,000', min: null, max: 500_000 },
  { label: '₹5,000 – ₹10,000', min: 500_000, max: 1_000_000 },
  { label: '₹10,000 – ₹15,000', min: 1_000_000, max: 1_500_000 },
  { label: '₹15,000 – ₹20,000', min: 1_500_000, max: 2_000_000 },
  { label: 'Over ₹20,000', min: 2_000_000, max: null },
];

export function FilterRail({
  query,
  facets,
  activeFilterCount,
  onToggle,
  onPatch,
  onClear,
}: FilterRailProps) {
  const isBandActive = (band: (typeof PRICE_BANDS)[number]) =>
    query.minPrice === band.min && query.maxPrice === band.max;

  return (
    <aside className="rail" aria-label="Filters">
      <div className="rail__head">
        <h2 className="rail__title">Filter</h2>
        {activeFilterCount > 0 && (
          <button type="button" className="rail__clear" onClick={onClear}>
            Clear ({activeFilterCount})
          </button>
        )}
      </div>

      <FilterGroup title="Availability">
        <Check
          label="In stock only"
          checked={query.inStockOnly}
          onChange={(checked) => onPatch({ inStockOnly: checked })}
        />
      </FilterGroup>

      {facets && (
        <>
          <FacetGroup
            title="Category"
            buckets={facets.categories}
            selected={query.category}
            onToggle={(value) => onToggle('category', value)}
          />

          <FacetGroup
            title="Gender"
            buckets={facets.genders}
            selected={query.gender}
            format={titleCase}
            onToggle={(value) => onToggle('gender', value)}
          />

          <FilterGroup title="Price">
            {PRICE_BANDS.map((band) => (
              <Check
                key={band.label}
                label={band.label}
                checked={isBandActive(band)}
                onChange={(checked) =>
                  onPatch(
                    checked
                      ? { minPrice: band.min, maxPrice: band.max }
                      : { minPrice: null, maxPrice: null },
                  )
                }
              />
            ))}
            {/*
              A single matching product makes min === max, and "spans ₹13,295 to
              ₹13,295" reads as broken. Say what is actually true instead.
            */}
            {facets.priceRange.max > 0 &&
              (facets.priceRange.min === facets.priceRange.max ? (
                <p className="rail__note">
                  One price in these results: {paiseToRupeeLabel(facets.priceRange.min)}
                </p>
              ) : (
                <p className="rail__note">
                  These results span {paiseToRupeeLabel(facets.priceRange.min)} to{' '}
                  {paiseToRupeeLabel(facets.priceRange.max)}
                </p>
              ))}
          </FilterGroup>

          <FacetGroup
            title="Brand"
            buckets={facets.brands}
            selected={query.brand}
            onToggle={(value) => onToggle('brand', value)}
          />

          <FacetGroup
            title="Size"
            buckets={facets.sizes}
            selected={query.size}
            layout="grid"
            onToggle={(value) => onToggle('size', value)}
          />
        </>
      )}
    </aside>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="group">
      <h3 className="group__title">{title}</h3>
      <div className="group__body">{children}</div>
    </section>
  );
}

interface FacetGroupProps {
  title: string;
  buckets: Array<{ value: string; count: number }>;
  selected: string[];
  onToggle: (value: string) => void;
  format?: (value: string) => string;
  layout?: 'list' | 'grid';
}

function FacetGroup({
  title,
  buckets,
  selected,
  onToggle,
  format = (v) => v,
  layout = 'list',
}: FacetGroupProps) {
  if (buckets.length === 0) return null;

  // Size reads as a swatch grid; everything else reads as a checkbox list.
  if (layout === 'grid') {
    return (
      <section className="group">
        <h3 className="group__title">{title}</h3>
        <div className="sizes">
          {buckets.map((bucket) => {
            const active = selected.includes(bucket.value);
            return (
              <button
                key={bucket.value}
                type="button"
                className="size"
                data-active={active || undefined}
                aria-pressed={active}
                onClick={() => onToggle(bucket.value)}
              >
                {bucket.value}
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="group">
      <h3 className="group__title">{title}</h3>
      <div className="group__body">
        {buckets.map((bucket) => (
          <Check
            key={bucket.value}
            label={format(bucket.value)}
            count={bucket.count}
            checked={selected.includes(bucket.value)}
            onChange={() => onToggle(bucket.value)}
          />
        ))}
      </div>
    </section>
  );
}

interface CheckProps {
  label: string;
  count?: number;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function Check({ label, count, checked, onChange }: CheckProps) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="check__box" aria-hidden="true">
        <svg viewBox="0 0 12 12">
          <path
            d="M2.5 6.5l2.5 2.5 4.5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="square"
          />
        </svg>
      </span>
      <span className="check__label">{label}</span>
      {count !== undefined && <span className="check__count">{count}</span>}
    </label>
  );
}
