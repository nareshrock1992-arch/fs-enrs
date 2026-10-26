// Media Library list state: server-side paging, KPIs from the server summary,
// stale-response protection. Pure-function tests + a request-shape test for the
// IVR/ENS pickers. The page itself is covered only by SOURCE checks (marked
// below) — the project has no DOM testing library, so those are not equivalent
// to rendered interaction tests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  PAGE_SIZE, MAX_PAGE_SIZE, SEARCH_DEBOUNCE_MS, SORT_FIELDS,
  initialListState, normalizeListState, buildListQuery, applyListChange, toggleSort,
  totalPages, clampPage, pageAfterDelete, summaryToKpis, describeLoadError,
  emptyStateKind, createRequestGate, toPositiveInt, hasActiveFilters, clearFilters, refreshDetail,
} from '../pages/media/mediaLibraryState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.resolve(__dirname, '../pages/media/MediaLibrary.jsx'), 'utf8');
const PAGER = readFileSync(path.resolve(__dirname, '../components/ui/Pagination.jsx'), 'utf8');

describe('query construction', () => {
  it('defaults: page 1, 50 rows, newest first, no filters', () => {
    expect(buildListQuery(initialListState())).toEqual({ page: 1, limit: 50, sort: 'created_at', dir: 'desc' });
    expect(PAGE_SIZE).toBe(50);
  });
  it('includes only non-empty filters; search is trimmed', () => {
    expect(buildListQuery({ ...initialListState(), search: '  greet ', category: 'ivr_prompt', deployed: 'false', page: 3 }))
      .toEqual({ page: 3, limit: 50, sort: 'created_at', dir: 'desc', search: 'greet', category: 'ivr_prompt', deployed: 'false' });
    expect(buildListQuery({ ...initialListState(), search: '   ' })).not.toHaveProperty('search');
  });
  it('only server-supported sort fields are ever sent', () => {
    expect(SORT_FIELDS).toEqual(['name', 'category', 'duration_sec', 'size_bytes', 'created_at']);
    expect(buildListQuery({ ...initialListState(), sort: 'is_deployed' }).sort).toBe('created_at');
    expect(buildListQuery({ ...initialListState(), dir: 'sideways' }).dir).toBe('desc');
  });
  it('deployed filter: only "", "true", "false" are meaningful', () => {
    expect(buildListQuery({ ...initialListState(), deployed: 'true' }).deployed).toBe('true');
    expect(buildListQuery({ ...initialListState(), deployed: 'false' }).deployed).toBe('false');
    expect(buildListQuery({ ...initialListState(), deployed: 'maybe' })).not.toHaveProperty('deployed');
  });
});

describe('page / limit normalisation (mirrors the server policy)', () => {
  it.each([[undefined, 50], ['-5', 50], ['0', 50], ['1000', MAX_PAGE_SIZE], ['2.9', 2], ['abc', 50], [30, 30]])(
    'limit %p → %p', (v, out) => expect(normalizeListState({ ...initialListState(), limit: v }).limit).toBe(out));
  it.each([[undefined, 1], ['-2', 1], [0, 1], ['3.7', 3], ['x', 1], [4, 4]])(
    'page %p → %p', (v, out) => expect(normalizeListState({ ...initialListState(), page: v }).page).toBe(out));
  it('toPositiveInt never yields NaN, 0 or a fraction', () => {
    for (const v of [NaN, Infinity, -1, 0, 0.4, '', null, {}, []]) {
      const r = toPositiveInt(v, 7);
      expect(Number.isInteger(r) && r >= 1).toBe(true);
    }
  });
});

describe('total pages and clamping', () => {
  it.each([[0, 50, 1], [1, 50, 1], [50, 50, 1], [51, 50, 2], [321, 50, 7], [321, 200, 2], [-3, 50, 1], ['12', 5, 3]])(
    'total %p / limit %p → %p pages', (t, l, p) => expect(totalPages(t, l)).toBe(p));
  it('clampPage keeps the page inside 1..totalPages', () => {
    expect(clampPage(9, 120, 50)).toBe(3);
    expect(clampPage(2, 0, 50)).toBe(1);        // empty result → page 1
    expect(clampPage(0, 120, 50)).toBe(1);
    expect(clampPage(2, 120, 50)).toBe(2);
  });
});

describe('page after deletion', () => {
  it('deleting the only row on the last page steps back one page', () => {
    expect(pageAfterDelete({ page: 3, total: 101, limit: 50, rowsOnPage: 1 })).toBe(2);
  });
  it('deleting a row from a page that still has rows stays on that page', () => {
    expect(pageAfterDelete({ page: 2, total: 120, limit: 50, rowsOnPage: 50 })).toBe(2);
  });
  it('deleting the last remaining file goes to page 1, never page 0', () => {
    expect(pageAfterDelete({ page: 1, total: 1, limit: 50, rowsOnPage: 1 })).toBe(1);
  });
  it('never returns a page beyond the remaining total', () => {
    expect(pageAfterDelete({ page: 5, total: 60, limit: 50, rowsOnPage: 3 })).toBe(2);
  });
});

describe('filter changes reset the page', () => {
  const at3 = { ...initialListState(), page: 3 };
  it.each([['search', 'x'], ['category', 'ivr_prompt'], ['deployed', 'true'], ['sort', 'name'], ['dir', 'asc'], ['limit', 100]])(
    'changing %s → page 1', (k, v) => expect(applyListChange(at3, { [k]: v }).page).toBe(1));
  it('a page change keeps the filters', () => {
    const s = applyListChange({ ...initialListState(), search: 'x', category: 'general' }, { page: 4 });
    expect(s).toMatchObject({ page: 4, search: 'x', category: 'general' });
  });
  it('an unchanged value returns the SAME state object (no extra request)', () => {
    expect(applyListChange(at3, { search: '' })).toBe(at3);
    expect(applyListChange(at3, { page: 3 })).toBe(at3);
  });
  it('sorting: same column toggles direction, page resets', () => {
    const s1 = toggleSort(at3, 'size_bytes');
    expect(s1).toMatchObject({ sort: 'size_bytes', dir: 'desc', page: 1 });
    expect(toggleSort(s1, 'size_bytes').dir).toBe('asc');
    expect(toggleSort(at3, 'is_deployed')).toBe(at3);       // unsupported field ignored
  });
  it('first click: text columns read A→Z, numbers/dates largest/newest first', () => {
    expect(toggleSort(at3, 'name').dir).toBe('asc');
    expect(toggleSort(at3, 'category').dir).toBe('asc');
    expect(toggleSort(at3, 'duration_sec').dir).toBe('desc');
    expect(toggleSort(at3, 'size_bytes').dir).toBe('desc');
    expect(toggleSort({ ...at3, sort: 'name' }, 'created_at').dir).toBe('desc');
  });
  it('clearFilters clears search/category/deployed but keeps sort order and page size', () => {
    const s = { ...initialListState(), search: 'x', category: 'general', deployed: 'true', sort: 'name', dir: 'asc', limit: 100, page: 4 };
    expect(clearFilters(s)).toMatchObject({ search: '', category: '', deployed: '', sort: 'name', dir: 'asc', limit: 100, page: 1 });
    expect(hasActiveFilters(s)).toBe(true);
    expect(hasActiveFilters(clearFilters(s))).toBe(false);
    const clean = initialListState();
    expect(clearFilters(clean)).toBe(clean);                 // nothing to clear → no extra request
  });
});

describe('detail panel stays in step with reloaded rows', () => {
  it('replaces the open record with the reloaded row (e.g. now deployed)', () => {
    const stale = { id: 7, is_deployed: false };
    expect(refreshDetail(stale, [{ id: 3 }, { id: 7, is_deployed: true }])).toEqual({ id: 7, is_deployed: true });
  });
  it('keeps the record when it is not on the reloaded page, and null stays null', () => {
    const d = { id: 7, is_deployed: false };
    expect(refreshDetail(d, [{ id: 3 }])).toBe(d);
    expect(refreshDetail(null, [{ id: 7 }])).toBeNull();
  });
  it('[source check] load() refreshes the detail + selection; uploads return to page 1; off-page deletes just reload', () => {
    expect(PAGE).toMatch(/setDetail\(d => refreshDetail\(d, res\.files\)\)/);
    expect(PAGE).toMatch(/setSelected\(s => refreshSelection\(s, res\.files\)\)/);
    expect(PAGE).toMatch(/onSuccess=\{handleUploaded\}/);
    // only rows deleted FROM THIS PAGE move the page; others just reload
    expect(PAGE).toMatch(/const onPage = s\.done\.filter\(f => files\.some\(r => r\.id === f\.id\)\)\.length/);
    expect(PAGE).toMatch(/totals above reflect these filters/);
  });
});

describe('KPIs come from the server summary only', () => {
  it('maps every summary field', () => {
    const k = summaryToKpis({ total: 321, deployed: 300, pending: 21, size_bytes: 9876543, duration_sec: 3600.5,
      by_category: { general: 200, ivr_prompt: 121, music_on_hold: 0 } });
    expect(k).toMatchObject({ total: 321, deployed: 300, pending: 21, sizeBytes: 9876543, durationSec: 3600.5 });
    expect(k.byCategory).toEqual({ general: 200, ivr_prompt: 121, music_on_hold: 0 });
  });
  it('"categories in use" counts categories holding files, not the number of category types', () => {
    expect(summaryToKpis({ by_category: { general: 3, ivr_prompt: 0, announcement: 1 } }).categoriesInUse).toBe(2);
  });
  it('empty or missing summary → valid zeros (never page-derived)', () => {
    const z = summaryToKpis(null);
    expect(z).toEqual({ total: 0, deployed: 0, pending: 0, sizeBytes: 0, durationSec: 0, byCategory: {}, categoriesInUse: 0, allCategoriesTotal: 0 });
    expect(summaryToKpis({ total: 'NaN', size_bytes: undefined }).total).toBe(0);
  });
  it('[source check] the page does not count deployed/pending from loaded rows', () => {
    expect(PAGE).not.toMatch(/files\.filter\(f => f\.is_deployed\)/);
    expect(PAGE).not.toMatch(/files\.filter\(f => !f\.is_deployed\)/);
    expect(PAGE).toMatch(/summaryToKpis\(summary\)/);
    expect(PAGE).not.toMatch(/value: categories\.length/);       // old "Categories" KPI counted category types
  });
});

describe('empty states and load errors', () => {
  it('distinguishes "no files yet" from "no matches"', () => {
    expect(emptyStateKind(initialListState())).toBe('no-files');
    expect(emptyStateKind({ ...initialListState(), search: 'x' })).toBe('no-matches');
    expect(emptyStateKind({ ...initialListState(), deployed: 'false' })).toBe('no-matches');
    expect(emptyStateKind({ ...initialListState(), search: '   ' })).toBe('no-files');
  });
  it('403 is a permission error with no retry; other failures are retryable', () => {
    expect(describeLoadError(Object.assign(new Error('Forbidden'), { status: 403 })))
      .toMatchObject({ kind: 'forbidden', retryable: false });
    expect(describeLoadError(Object.assign(new Error('Bad gateway'), { status: 502 })))
      .toEqual({ kind: 'error', message: 'Bad gateway', retryable: true });
    expect(describeLoadError(new Error(''))).toMatchObject({ kind: 'error', message: 'Failed to load media library' });
    expect(describeLoadError(null)).toBeNull();
  });
  it('[source check] the page renders the alert, Retry only when retryable, and both empty states', () => {
    expect(PAGE).toMatch(/role="alert"/);
    expect(PAGE).toMatch(/loadError\.retryable && \(/);
    expect(PAGE).toMatch(/No matching media/);
    expect(PAGE).toMatch(/No media files/);
  });
});

describe('out-of-order responses', () => {
  it('only the newest request may apply its response', async () => {
    const gate = createRequestGate();
    const applied = [];
    const request = (value, ms) => {
      const t = gate.next();
      return new Promise(r => setTimeout(r, ms)).then(() => { if (gate.isCurrent(t)) applied.push(value); });
    };
    await Promise.all([request('old-search', 30), request('new-search', 5)]);
    expect(applied).toEqual(['new-search']);
  });
  it('[source check] the page checks the gate before applying results and errors', () => {
    expect(PAGE.match(/gate\.current\.isCurrent\(ticket\)/g).length).toBeGreaterThanOrEqual(3);
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
    expect(PAGE).toMatch(/setTimeout\([\s\S]{0,120}SEARCH_DEBOUNCE_MS\)/);
  });
});

describe('table, pagination and permissions [source checks]', () => {
  it('uses the shared Table and Pagination components with server paging', () => {
    expect(PAGE).toMatch(/import \{ Table, Th, Td, Tr \} from '..\/..\/components\/ui\/Table\.jsx'/);
    expect(PAGE).toMatch(/<Pagination page=\{list\.page\}/);
    expect(PAGE).not.toMatch(/limit: 200,/);                     // old "load 200 rows" approach
  });
  it('the table never renders internal server paths', () => {
    const start = PAGE.indexOf('<Table'), end = PAGE.indexOf('</Table>');
    expect(start).toBeGreaterThan(-1);                           // guard: never compare an empty slice
    expect(end).toBeGreaterThan(start);
    expect(PAGE.slice(start, end)).not.toMatch(/fs_path|path_or_uri/);
    // the detail drawer shows only the deployed file NAME, never the server path
    expect(PAGE).toMatch(/leafName\(file\.fs_path\)/);
    expect(PAGE).not.toMatch(/\{file\.fs_path\}/);
  });
  it('row actions keep their permission gates (scan/deploy/delete → media.manage, upload → media.upload)', () => {
    expect(PAGE).toMatch(/const canUpload = can\(user, 'media\.upload'\)/);
    expect(PAGE).toMatch(/const canEdit {3}= can\(user, 'media\.manage'\)/);
    expect(PAGE).toMatch(/\{canEdit && !f\.is_deployed && \(/);
    expect(PAGE).toMatch(/\{canEdit && \(\s*<button type="button"\s*onClick=\{e => \{ e\.stopPropagation\(\); setConfirm\(\{ kind: 'delete', files: \[f\] \}\)/);
    expect(PAGE).toMatch(/\{canUpload && \(\s*<button onClick=\{\(\) => setShowUpload\(true\)\} className="btn-primary"/);
    // bulk actions: write actions only for media.manage; download for any viewer
    expect(PAGE).toMatch(/const actions = bulkActions\(sel, \{ canEdit \}\)/);
    expect(PAGE).toMatch(/\{actions\.deploy\.allowed && \(/);
    expect(PAGE).toMatch(/\{actions\.category\.allowed && \(/);
    expect(PAGE).toMatch(/\{actions\.delete\.allowed && \(/);
    // editing in the detail drawer is gated too
    expect(PAGE).toMatch(/\{canEdit && !editing && \(/);
  });
  it('delete always goes through a confirmation, and in-use files are reported (no alert/confirm popups)', () => {
    expect(PAGE).not.toMatch(/window\.confirm\(/);
    expect(PAGE).not.toMatch(/\balert\(/);
    expect(PAGE).toMatch(/<ConfirmDialog/);
    expect(PAGE).toMatch(/describeDependency\(d\)/);
  });
  it('player is docked (not a full-screen modal) and rows toggle it', () => {
    expect(PAGE).toMatch(/const DockedPlayer = forwardRef/);
    expect(PAGE).toMatch(/role="region" aria-label="Audio player"/);
    expect(PAGE).toMatch(/className="sticky bottom-0/);
    expect(PAGE).toMatch(/playerRef\.current\?\.toggle\(\)/);
    expect(PAGE).toMatch(/aria-label="Seek"/);
  });
  it('sortable headers expose aria-sort; select-all checkbox is tri-state', () => {
    expect(PAGE).toMatch(/aria-sort=\{active \?/);
    expect(PAGE).toMatch(/el\.indeterminate = pageSel === 'some'/);
  });
  it('upload accepts multiple files with per-file status', () => {
    expect(PAGE).toMatch(/type="file" multiple/);
    expect(PAGE).toMatch(/aria-label="Files to upload"/);
  });
  it('Pagination: hidden for 0/1 page, labelled controls, current page marked', () => {
    expect(PAGER).toMatch(/if \(!totalPages \|\| totalPages <= 1\) return null/);
    expect(PAGER).toMatch(/aria-current=\{p === page \? 'page' : undefined\}/);
    for (const l of ['First page', 'Previous page', 'Next page', 'Last page']) expect(PAGER).toContain(l);
  });
});

describe('IVR / ENS picker request compatibility', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ files: [], total: 0, page: 1, limit: 30, summary: {} }) }));
  });
  afterEach(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; });

  it('api.mediaLibrary.list({ search, limit: 30, deployed: "true" }) sends the same request as before', async () => {
    const { api } = await import('../api/client.js');
    const r = await api.mediaLibrary.list({ search: 'greet', limit: 30, deployed: 'true' });
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/v1/media-library?search=greet&limit=30&deployed=true');
    expect(r.files).toEqual([]);                                  // pickers read r.files — still present
  });
  it('[source check] the picker call sites are unchanged', () => {
    for (const f of ['../components/ivr/panels/PropertyPanel.jsx', '../pages/ens/EnsList.jsx']) {
      const src = readFileSync(path.resolve(__dirname, f), 'utf8');
      expect(src).toMatch(/api\.mediaLibrary\.list\(\{ search: q \|\| undefined, limit: 30, deployed: 'true' \}\)/);
    }
  });
});
