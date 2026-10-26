// ── Media Library: selection, bulk actions, dependency labels, player queue ───
// Framework-independent helpers for MediaLibrary.jsx (unit-tested).
//
// Bulk actions run CLIENT-SIDE, one request at a time, through the existing
// per-file endpoints (deploy / PUT / DELETE / signed download). There is no bulk
// API: each item gets the server's normal permission, tenant and dependency
// checks, and a failure on one item never affects the others.

export const MAX_BULK = 50;            // items per bulk action (keeps well under the 300 req/min API limit)
export const MAX_BULK_DOWNLOAD = 10;   // browsers throttle many simultaneous downloads
export const BULK_SPACING_MS = 150;

// Selection is a plain { [id]: file } map, so it survives paging and the bulk
// bar can show names. It is cleared whenever the filter set changes.
export const emptySelection = () => ({});
export const selectedFiles = (sel) => Object.values(sel || {});
export const selectedCount = (sel) => Object.keys(sel || {}).length;
export const isSelected = (sel, id) => Boolean(sel && sel[id]);

export function toggleRow(sel, file) {
  const next = { ...sel };
  if (next[file.id]) delete next[file.id]; else next[file.id] = file;
  return next;
}

/** 'none' | 'some' | 'all' — for the header checkbox of the CURRENT page. */
export function pageSelectionState(sel, files) {
  if (!files?.length) return 'none';
  const n = files.filter(f => sel?.[f.id]).length;
  return n === 0 ? 'none' : n === files.length ? 'all' : 'some';
}

/** Header checkbox: if every row on the page is selected, unselect them; otherwise select them all. */
export function togglePage(sel, files) {
  const next = { ...sel };
  if (pageSelectionState(sel, files) === 'all') files.forEach(f => { delete next[f.id]; });
  else files.forEach(f => { next[f.id] = f; });
  return next;
}

/** Keep selected records in step with freshly loaded rows (e.g. after deploy). */
export function refreshSelection(sel, rows) {
  if (!rows?.length || !selectedCount(sel)) return sel;
  let changed = false;
  const next = { ...sel };
  for (const r of rows) if (next[r.id] && next[r.id] !== r) { next[r.id] = r; changed = true; }
  return changed ? next : sel;
}

/** Drop ids that no longer exist (deleted). */
export function withoutIds(sel, ids) {
  const next = { ...sel };
  ids.forEach(id => { delete next[id]; });
  return next;
}

/** Which bulk actions the role permits, and how many selected items each applies to. */
export function bulkActions(files, { canEdit }) {
  const n = files.length;
  return {
    download: { allowed: n > 0, count: Math.min(n, MAX_BULK_DOWNLOAD), capped: n > MAX_BULK_DOWNLOAD },
    deploy:   { allowed: canEdit && files.some(f => !f.is_deployed), count: files.filter(f => !f.is_deployed).length },
    category: { allowed: canEdit && n > 0, count: n },
    delete:   { allowed: canEdit && n > 0, count: n },
    tooMany:  n > MAX_BULK,
  };
}

/**
 * Run `worker(item)` for each item, strictly one at a time. Never throws:
 * every item ends as { item, ok, status, error, data }.
 */
export async function runSequential(items, worker, { onProgress, spacingMs = BULK_SPACING_MS, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      await worker(item);
      results.push({ item, ok: true });
    } catch (e) {
      results.push({ item, ok: false, status: e?.status ?? null, error: e?.message || 'Failed', data: e?.data ?? null });
    }
    onProgress?.(i + 1, items.length);
    if (i < items.length - 1 && spacingMs > 0) await wait(spacingMs);
  }
  return results;
}

/** Split bulk results into done / in-use (with dependency list) / failed. */
export function summarizeBulk(results) {
  const done = [], inUse = [], failed = [];
  for (const r of results) {
    if (r.ok) done.push(r.item);
    else if (r.status === 409 && r.data?.error === 'MEDIA_IN_USE') {
      inUse.push({ file: r.item, dependencies: r.data.dependencies || [], hiddenCount: r.data.hidden_count || 0 });
    } else {
      failed.push({ file: r.item, message: r.status === 503 ? 'Busy — try again in a moment' : (r.error || 'Failed') });
    }
  }
  return { done, inUse, failed };
}

const DEP_KINDS = {
  ivr_flow_draft:      'IVR flow (draft)',
  ivr_flow_published:  'IVR flow (published version)',
  ens_configuration:   'ENS configuration',
  ers_configuration:   'ERS configuration',
  ens_campaign_active: 'ENS campaign (active or in replay window)',
  platform_config:     'Platform configuration',
  ivr_template:        'IVR template',
};

/** Human label for one dependency row from the 409 MEDIA_IN_USE body. */
export function describeDependency(dep) {
  const kind = DEP_KINDS[dep?.kind] || 'Other reference';
  if (dep?.other_tenant) return `${kind} in another tenant`;
  const name = dep?.name ? ` “${dep.name}”` : '';
  const where = dep?.field ? ` — ${dep.field}` : '';
  return `${kind}${name}${where}`;
}

/** Previous / next file in the current page for the player (null at the ends). */
export function adjacentFile(files, currentId, delta) {
  const i = (files || []).findIndex(f => f.id === currentId);
  if (i < 0) return null;
  return files[i + delta] || null;
}

/** "a, b , a" → ['a', 'b'] (trimmed, de-duplicated, max 20 tags of ≤ 40 chars). */
export function parseTags(input) {
  const seen = new Set();
  for (const raw of String(input || '').split(',')) {
    const t = raw.trim().slice(0, 40);
    if (t && !seen.has(t)) seen.add(t);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

/** Server file path → bare file name (never show internal paths in the UI). */
export const leafName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
