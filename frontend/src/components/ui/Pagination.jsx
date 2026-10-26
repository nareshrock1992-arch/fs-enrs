// Reusable pager — same look and behaviour as the EnsReport pager (« ‹ 1 2 3 › »,
// a window of ±2 pages, "Page X of Y"), plus accessible labels and a row range.
// Renders nothing for an empty result or a single page.

export default function Pagination({ page, totalPages, onPage, total, limit, disabled = false }) {
  if (!totalPages || totalPages <= 1) return null;
  const pages = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pages.push(p);
  const go = (p) => { if (!disabled && p >= 1 && p <= totalPages && p !== page) onPage(p); };
  const first = total ? (page - 1) * limit + 1 : 0;
  const last  = total ? Math.min(total, page * limit) : 0;

  return (
    <nav className="flex items-center justify-center gap-1 pt-2 flex-wrap" aria-label="Pagination">
      <button type="button" className="btn-ghost btn-sm" disabled={disabled || page <= 1}
        onClick={() => go(1)} aria-label="First page">«</button>
      <button type="button" className="btn-ghost btn-sm" disabled={disabled || page <= 1}
        onClick={() => go(page - 1)} aria-label="Previous page">‹</button>
      {pages.map(p => (
        <button key={p} type="button" onClick={() => go(p)} disabled={disabled}
          aria-label={`Page ${p}`} aria-current={p === page ? 'page' : undefined}
          className={`btn-sm rounded-lg font-semibold ${p === page ? 'btn-primary' : 'btn-ghost'}`}>{p}</button>
      ))}
      <button type="button" className="btn-ghost btn-sm" disabled={disabled || page >= totalPages}
        onClick={() => go(page + 1)} aria-label="Next page">›</button>
      <button type="button" className="btn-ghost btn-sm" disabled={disabled || page >= totalPages}
        onClick={() => go(totalPages)} aria-label="Last page">»</button>
      <span className="text-xs text-text-muted ml-2">
        Page {page} of {totalPages}{total ? ` · ${first}–${last} of ${total}` : ''}
      </span>
    </nav>
  );
}
