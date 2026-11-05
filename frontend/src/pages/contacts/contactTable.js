// Emergency Contacts table — column definitions, saved preferences, query building and
// CSV-import helpers. Kept free of React so the rules can be unit-tested.

export const PAGE_SIZES = [25, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

// `always`: cannot be hidden. `tenantOnly`: offered only to SUPER_ADMIN under "All Tenants".
export const COLUMNS = [
  { key: 'name',         label: 'Name',         sort: 'name', always: true },
  { key: 'mobile',       label: 'Mobile',       sort: 'mobile',       byDefault: true },
  { key: 'extension',    label: 'Extension',    sort: 'extension' },
  { key: 'email',        label: 'Email',        sort: 'email' },
  { key: 'role',         label: 'Role',         sort: 'role',         byDefault: true },
  { key: 'organization', label: 'Organization', sort: 'organization', byDefault: true },
  { key: 'department',   label: 'Department',   sort: 'department' },
  { key: 'location',     label: 'Location',     sort: 'location' },
  { key: 'status',       label: 'Status',       sort: 'status' },
  { key: 'updated_at',   label: 'Updated',      sort: 'updated_at' },
  { key: 'tenant',       label: 'Tenant',       sort: 'tenant',       byDefault: true, tenantOnly: true },
];

const COLUMN_KEYS = new Set(COLUMNS.map(c => c.key));
export const DEFAULT_PREFS = Object.freeze({
  columns: COLUMNS.filter(c => c.byDefault).map(c => c.key),
  pageSize: DEFAULT_PAGE_SIZE,
});

export const prefsKey = (userId) => `enrs.contacts.prefs.v1.${userId ?? 'anon'}`;

/** Saved preferences, or the defaults when storage is unavailable or holds something invalid. */
export function loadPrefs(storage, userId) {
  try {
    const raw = JSON.parse(storage?.getItem(prefsKey(userId)) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
    const columns = Array.isArray(raw.columns) ? raw.columns.filter(k => COLUMN_KEYS.has(k)) : DEFAULT_PREFS.columns;
    const pageSize = PAGE_SIZES.includes(raw.pageSize) ? raw.pageSize : DEFAULT_PAGE_SIZE;
    return { columns, pageSize };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage, userId, prefs) {
  try { storage?.setItem(prefsKey(userId), JSON.stringify(prefs)); } catch { /* private mode / quota: keep in memory only */ }
}

/** Columns offered in the chooser. */
export const choosableColumns = (showTenant) => COLUMNS.filter(c => !c.always && (!c.tenantOnly || showTenant));

/** Columns to render, in the fixed table order. */
export function visibleColumns(prefs, showTenant) {
  const chosen = new Set(prefs?.columns || []);
  return COLUMNS.filter(c => c.always || (chosen.has(c.key) && (!c.tenantOnly || showTenant)));
}

export function toggleColumn(prefs, key) {
  const cols = new Set(prefs.columns);
  if (cols.has(key)) cols.delete(key); else cols.add(key);
  return { ...prefs, columns: COLUMNS.map(c => c.key).filter(k => cols.has(k)) };
}

/** Header click: none → ascending → descending → none (back to the default name order). */
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

export function ariaSort(current, key) {
  if (!current || current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

export const EMPTY_FILTERS = Object.freeze({ organization_id: '', department_id: '', location_id: '', is_active: '', role: '' });

export const hasActiveFilters = (filters, search) =>
  !!(search && search.trim()) || Object.values(filters || {}).some(v => v !== '' && v !== null && v !== undefined);

/** Query object for the list / export API; empty values are left out. */
export function buildQuery({ filters = EMPTY_FILTERS, search = '', sort = null, page, pageSize } = {}) {
  const q = {};
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== null && v !== undefined) q[k] = v;
  const s = search.trim();
  if (s) q.search = s;
  if (sort) { q.sort = sort.key; q.dir = sort.dir; }
  if (page) q.page = page;
  if (pageSize) q.limit = pageSize;
  return q;
}

export function cellText(key, r) {
  switch (key) {
    case 'name':         return `${r.first_name || ''} ${r.last_name || ''}`.trim();
    case 'mobile':       return r.mobile_number || '';
    case 'extension':    return r.extension_number || '';
    case 'email':        return r.email || '';
    case 'role':         return r.role || '';
    case 'organization': return r.organization_name || '';
    case 'department':   return r.department_name || '';
    case 'location':     return r.location_name || '';
    case 'status':       return r.is_active === false ? 'Inactive' : 'Active';
    case 'tenant':       return r.tenant_name || '';
    case 'updated_at':   return r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '';
    default:             return '';
  }
}

/** Organization option text; under "All Tenants" the tenant is shown so the target is explicit. */
export function orgLabel(org, showTenant) {
  if (!org) return '';
  return showTenant && org.tenant_name ? `${org.name} — ${org.tenant_name}` : org.name;
}

// ── Import (CSV and Excel) ────────────────────────────────────────────────────

/** Template columns, in template order (the server's IMPORT_FIELDS; the templates are downloaded from the server). */
export const TEMPLATE_COLUMNS = ['first_name', 'last_name', 'mobile_number', 'extension_number', 'email',
  'role', 'organization', 'department', 'location', 'is_active'];

/** File picker filter and the server's upload limit. */
export const IMPORT_ACCEPT = '.xlsx,.csv';
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Problem with the chosen file before it is sent (the server checks again), or null. */
export function checkImportFile(file) {
  if (!file) return 'Choose a file to import.';
  const ext = (/\.([^.]+)$/.exec(file.name || '')?.[1] || '').toLowerCase();
  if (ext !== 'xlsx' && ext !== 'csv') return 'Only Excel workbooks (.xlsx) and CSV files (.csv) can be imported.';
  if (!file.size) return 'The file is empty.';
  if (file.size > IMPORT_MAX_BYTES) return 'The file is larger than 5 MB.';
  return null;
}

/** Counts of an import check (preview) or of a finished import. */
export function importCounts(result) {
  if (!result) return null;
  const invalid = result.invalid ?? result.errors?.length ?? 0;
  const duplicates = result.skipped ?? result.duplicates?.length ?? 0;
  const inserted = result.inserted ?? 0;
  return {
    total: result.total ?? 0,
    valid: result.preview ? (result.valid ?? 0) : inserted,
    invalid,
    duplicates,
    inserted,
  };
}

/** One line of text for an import problem ({ line, error } or { line, reason }), whatever its shape. */
export function importIssueText(issue) {
  if (issue === null || issue === undefined) return '';
  if (typeof issue !== 'object') return String(issue);
  const msg = issue.error ?? issue.reason ?? '';
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  return issue.line ? `Row ${issue.line}: ${text}` : text;
}
