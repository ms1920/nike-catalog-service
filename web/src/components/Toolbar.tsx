import type { CatalogQuery, SortValue } from '../lib/api.js';
import { pluralise } from '../lib/format.js';

const SORT_OPTIONS: Array<{ value: SortValue; label: string }> = [
  { value: 'relevance:desc', label: 'Featured' },
  { value: 'createdAt:desc', label: 'Newest' },
  { value: 'price:asc', label: 'Price: Low – High' },
  { value: 'price:desc', label: 'Price: High – Low' },
  { value: 'name:asc', label: 'Alphabetical' },
];

interface ToolbarProps {
  query: CatalogQuery;
  total: number | null;
  onPatch: (patch: Partial<CatalogQuery>) => void;
  onOpenFilters: () => void;
  activeFilterCount: number;
}

export function Toolbar({
  query,
  total,
  onPatch,
  onOpenFilters,
  activeFilterCount,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <h1 className="toolbar__heading">
        {query.q.trim() ? `Results for “${query.q.trim()}”` : 'All Products'}
        {total !== null && (
          <span className="toolbar__total"> ({pluralise(total, 'item')})</span>
        )}
      </h1>

      <div className="toolbar__controls">
        {/* Rail is a sibling on desktop; on mobile it becomes a sheet. */}
        <button
          type="button"
          className="btn btn--ghost toolbar__filters"
          onClick={onOpenFilters}
        >
          Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>

        <label className="sort">
          <span className="sr-only">Sort by</span>
          <select
            className="sort__select"
            value={query.sort}
            onChange={(event) => onPatch({ sort: event.target.value as SortValue })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <svg className="sort__chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 4.5 6 8.5l4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </label>
      </div>
    </div>
  );
}
