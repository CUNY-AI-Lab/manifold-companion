/**
 * Pagination — reusable page navigation component.
 *
 * Props:
 *   currentPage   number  — 1-based current page
 *   totalPages    number  — total pages
 *   onPageChange  fn      — called with the new page number
 *   totalItems    number  — total record count (for label)
 *   pageSize      number  — records per page (for label)
 *
 * Renders nothing when totalPages <= 1.
 */
export default function Pagination({ currentPage, totalPages, onPageChange, totalItems, pageSize }) {
  if (!totalPages || totalPages <= 1) return null;

  // Build the page window: first, last, and up to 2 neighbours around current.
  function getPageNumbers() {
    const pages = new Set();
    pages.add(1);
    pages.add(totalPages);
    for (let d = -2; d <= 2; d++) {
      const p = currentPage + d;
      if (p >= 1 && p <= totalPages) pages.add(p);
    }
    const sorted = [...pages].sort((a, b) => a - b);

    // Insert ellipsis markers
    const result = [];
    let prev = null;
    for (const p of sorted) {
      if (prev !== null && p - prev > 1) result.push('…');
      result.push(p);
      prev = p;
    }
    return result;
  }

  const pages = getPageNumbers();

  // Item range label
  const firstItem = totalItems && pageSize ? (currentPage - 1) * pageSize + 1 : null;
  const lastItem  = totalItems && pageSize ? Math.min(currentPage * pageSize, totalItems) : null;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6 select-none">
      {/* Item count label */}
      {firstItem !== null ? (
        <p className="text-xs text-gray-500 dark:text-slate-400 order-2 sm:order-1">
          Showing {firstItem}–{lastItem} of {totalItems}
        </p>
      ) : (
        <span className="hidden sm:block" />
      )}

      {/* Desktop: full page list */}
      <nav
        aria-label="Pagination"
        className="hidden sm:flex items-center gap-1 order-1 sm:order-2"
      >
        {/* Prev */}
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous page"
        >
          ← Prev
        </button>

        {/* Page numbers */}
        {pages.map((item, i) =>
          item === '…' ? (
            <span
              key={`ellipsis-${i}`}
              className="px-2 text-sm text-gray-500 dark:text-slate-500"
            >
              …
            </span>
          ) : (
            <button
              key={item}
              onClick={() => item !== currentPage && onPageChange(item)}
              aria-current={item === currentPage ? 'page' : undefined}
              className={`w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                item === currentPage
                  ? 'bg-cail-blue text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              }`}
            >
              {item}
            </button>
          )
        )}

        {/* Next */}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Next page"
        >
          Next →
        </button>
      </nav>

      {/* Mobile: compact Prev / Page N of M / Next */}
      <nav
        aria-label="Pagination"
        className="flex sm:hidden items-center gap-2 order-1"
      >
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ← Prev
        </button>
        <span className="text-sm text-gray-500 dark:text-slate-400">
          Page {currentPage} of {totalPages}
        </span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Next →
        </button>
      </nav>
    </div>
  );
}
