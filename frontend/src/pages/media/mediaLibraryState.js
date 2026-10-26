// ── Media Library list state (framework-independent, unit-tested) ────────────
// Pagination, totals and KPIs all come from the server response for the
// current filter set (GET /media-library → { files, total, page, limit, summary }).
// Nothing here derives counts from the rows of the loaded page.

export const PAGE_SIZE = 50;           // default rows per page
export const MAX_PAGE_SIZE = 200;      // server-enforced maximum (normalizeMediaPaging)
export const SEARCH_DEBOUNCE_MS = 300;

// Columns the backend accepts in ?sort= (MEDIA_SORT_FIELDS). Only these headers sort.
export const SORT_FIELDS = ['name', 'category', 'duration_sec', 'size_bytes', 'created_at'];
export const DEFAULT_SORT = { sort: 'created_at', dir: 'desc' };

// Deployed filter: '' = all, 'true' = deployed, 'false' = pending (not deployed).
export const DEPLOY_FILTERS = [
  { value: '',      label: 'All statuses' },
  { value: 'true',  label: 'Deployed' },
  { value: 'false', label: 'Pending' },
];

export const initialListState = () => ({
  search: '', category: '', deployed: '', page: 1, limit: PAGE_SIZE, ...DEFAULT_SORT,
});

/** Integer ≥ 1 (truncated), else `dflt`; capped at `max`. Mirrors the server policy. */
export function toPositiveInt(v, dflt, max = Infinity) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt;
}

/** Normalise page/limit/sort so the UI never sends values the server would rewrite. */
export function normalizeListState(s) {
  const limit = toPositiveInt(s.limit, PAGE_SIZE, MAX_PAGE_SIZE);
  return {
    ...s,
    page:  toPositiveInt(s.page, 1),
    limit,
    sort:  SORT_FIELDS.includes(s.sort) ? s.sort : DEFAULT_SORT.sort,
    dir:   s.dir === 'asc' ? 'asc' : 'desc',
    deployed: s.deployed === 'true' || s.deployed === 'false' ? s.deployed : '',
  };
}

/** Query object for api.mediaLibrary.list(); empty filters are omitted. */
export function buildListQuery(state) {
  const s = normalizeListState(state);
  const q = { page: s.page, limit: s.limit, sort: s.sort, dir: s.dir };
  const search = (s.search || '').trim();
  if (search)     q.search = search;
  if (s.category) q.category = s.category;
  if (s.deployed) q.deployed = s.deployed;
  return q;
}

/**
 * Filter / search / sort / page-size changes go back to page 1; a page change
 * keeps the filters. Returns the SAME object when nothing changes, so React
 * state updates with an unchanged value don't trigger another request.
 */
export function applyListChange(state, patch) {
  const changed = Object.keys(patch).filter(k => patch[k] !== state[k]);
  if (changed.length === 0) return state;
  const resetsPage = changed.some(k => ['search', 'category', 'deployed', 'sort', 'dir', 'limit'].includes(k));
  return normalizeListState({ ...state, ...patch, page: resetsPage ? 1 : (patch.page ?? state.page) });
}

// First click on a column: text reads A→Z, numbers and dates largest/newest first.
export const SORT_FIRST_DIR = { name: 'asc', category: 'asc', duration_sec: 'desc', size_bytes: 'desc', created_at: 'desc' };

/** Clicking a sortable header: same column toggles direction, a new column starts at SORT_FIRST_DIR. */
export function toggleSort(state, field) {
  if (!SORT_FIELDS.includes(field)) return state;
  const dir = state.sort === field ? (state.dir === 'asc' ? 'desc' : 'asc') : SORT_FIRST_DIR[field];
  return applyListChange(state, { sort: field, dir });
}

/** True when any filter (not sort / page size) narrows the result set. */
export function hasActiveFilters(state) {
  return Boolean((state.search || '').trim() || state.category || state.deployed);
}

/**
 * One removable chip per active filter, for the active-filter bar.
 * `key` is the list-state field the chip clears.
 */
export function activeFilterChips(state, catLabels = {}) {
  const chips = [];
  const search = (state.search || '').trim();
  if (search) chips.push({ key: 'search', label: 'Search', value: `“${search}”` });
  if (state.category) chips.push({ key: 'category', label: 'Category', value: catLabels[state.category] || state.category });
  if (state.deployed) chips.push({ key: 'deployed', label: 'Status', value: state.deployed === 'true' ? 'Deployed' : 'Pending' });
  return chips;
}

/** Clear search + filters only; keep sort order and page size. */
export function clearFilters(state) {
  return applyListChange(state, { search: '', category: '', deployed: '' });
}

/** Replace the open detail record with its freshly loaded row (same id), if present. */
export function refreshDetail(detail, rows) {
  if (!detail) return detail;
  return (rows || []).find(r => r.id === detail.id) || detail;
}

export function totalPages(total, limit) {
  const t = Math.max(0, Math.trunc(Number(total) || 0));
  const l = toPositiveInt(limit, PAGE_SIZE, MAX_PAGE_SIZE);
  return Math.max(1, Math.ceil(t / l));
}

/** Keep `page` inside 1..totalPages (e.g. after a delete shrank the result set). */
export function clampPage(page, total, limit) {
  return Math.min(toPositiveInt(page, 1), totalPages(total, limit));
}

/**
 * After deleting `deletedCount` rows from the current page: the page to load next.
 * If the deletion emptied the last page, step back to the previous valid page.
 */
export function pageAfterDelete({ page, total, limit, rowsOnPage, deletedCount = 1 }) {
  const remainingTotal = Math.max(0, (Number(total) || 0) - deletedCount);
  const remainingOnPage = Math.max(0, (Number(rowsOnPage) || 0) - deletedCount);
  const target = remainingOnPage === 0 ? page - 1 : page;
  return clampPage(Math.max(1, target), remainingTotal, limit);
}

/**
 * Server summary → KPI values. Only server numbers are used; a missing summary
 * yields zeros, never page-derived counts. `categoriesInUse` counts categories
 * that actually hold files in the (non-category) filtered set — not the number
 * of category types that exist.
 */
export function summaryToKpis(summary) {
  const s = summary || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const byCategory = {};
  for (const [k, v] of Object.entries(s.by_category || {})) byCategory[k] = num(v);
  return {
    total:           num(s.total),
    deployed:        num(s.deployed),
    pending:         num(s.pending),
    sizeBytes:       num(s.size_bytes),
    durationSec:     num(s.duration_sec),
    byCategory,
    categoriesInUse: Object.values(byCategory).filter(n => n > 0).length,
    allCategoriesTotal: Object.values(byCategory).reduce((a, n) => a + n, 0),
  };
}

/** Classify a load failure for the UI. */
export function describeLoadError(err) {
  if (!err) return null;
  if (err.status === 403) {
    return { kind: 'forbidden', message: 'You do not have permission to view the media library.', retryable: false };
  }
  return { kind: 'error', message: err.message || 'Failed to load media library', retryable: true };
}

/** Which empty state applies once loading finished with no rows. */
export function emptyStateKind(state) {
  return hasActiveFilters(state) ? 'no-matches' : 'no-files';
}

/**
 * Out-of-order protection: each request takes a ticket; only the newest ticket
 * may apply its response.
 */
export function createRequestGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
  };
}

export function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTotalDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}
