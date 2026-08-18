import type { PageMeta } from '../lib/api.js';

/**
 * Numbered pager. The API returns real `totalPages`, so the control can be
 * honest about how much is left — one of the few genuine advantages of offset
 * pagination over cursors.
 */
interface PaginationProps {
  pagination: PageMeta;
  onGo: (page: number) => void;
}

/** Windowed page list with ellipses, always including first and last. */
function pageWindow(current: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set<number>([1, total, current]);
  if (current - 1 > 1) pages.add(current - 1);
  if (current + 1 < total) pages.add(current + 1);

  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];

  sorted.forEach((page, index) => {
    const prev = sorted[index - 1];
    if (prev !== undefined && page - prev > 1) out.push('gap');
    out.push(page);
  });

  return out;
}

export function Pagination({ pagination, onGo }: PaginationProps) {
  const { page, totalPages, hasPrev, hasNext } = pagination;
  if (totalPages <= 1) return null;

  return (
    <nav className="pager" aria-label="Pagination">
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onGo(page - 1)}
        disabled={!hasPrev}
      >
        Previous
      </button>

      <ol className="pager__list">
        {pageWindow(page, totalPages).map((entry, index) =>
          entry === 'gap' ? (
            <li key={`gap-${index}`} className="pager__gap" aria-hidden="true">
              &hellip;
            </li>
          ) : (
            <li key={entry}>
              <button
                type="button"
                className="pager__page"
                data-active={entry === page || undefined}
                aria-current={entry === page ? 'page' : undefined}
                aria-label={`Page ${entry}`}
                onClick={() => onGo(entry)}
              >
                {entry}
              </button>
            </li>
          ),
        )}
      </ol>

      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onGo(page + 1)}
        disabled={!hasNext}
      >
        Next
      </button>
    </nav>
  );
}
