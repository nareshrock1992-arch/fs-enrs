// Media Library redesign helpers: selection, bulk actions, dependency labels,
// active-filter chips, player queue. Pure-function tests (no DOM library in this project).
import { describe, it, expect, vi } from 'vitest';
import {
  emptySelection, selectedFiles, selectedCount, isSelected, toggleRow, togglePage, pageSelectionState,
  refreshSelection, withoutIds, bulkActions, runSequential, summarizeBulk, describeDependency,
  adjacentFile, parseTags, leafName, MAX_BULK, MAX_BULK_DOWNLOAD,
} from '../pages/media/mediaSelection.js';
import { activeFilterChips, initialListState } from '../pages/media/mediaLibraryState.js';

const f = (id, extra = {}) => ({ id, name: `file-${id}`, is_deployed: true, ...extra });
const page1 = [f(1), f(2), f(3)];
const page2 = [f(4), f(5)];

describe('selection', () => {
  it('toggles single rows and counts them', () => {
    let s = emptySelection();
    s = toggleRow(s, page1[0]); s = toggleRow(s, page1[2]);
    expect(selectedCount(s)).toBe(2);
    expect(isSelected(s, 1) && isSelected(s, 3) && !isSelected(s, 2)).toBe(true);
    s = toggleRow(s, page1[0]);
    expect(selectedCount(s)).toBe(1);
  });
  it('header checkbox state is none / some / all for the CURRENT page', () => {
    expect(pageSelectionState(emptySelection(), page1)).toBe('none');
    expect(pageSelectionState(toggleRow({}, page1[0]), page1)).toBe('some');
    expect(pageSelectionState(togglePage({}, page1), page1)).toBe('all');
    expect(pageSelectionState(togglePage({}, page1), [])).toBe('none');
  });
  it('select-all on a page adds that page only; pressing again clears that page only', () => {
    let s = togglePage({}, page1);
    s = toggleRow(s, page2[0]);                         // a row on another page
    expect(selectedCount(s)).toBe(4);
    s = togglePage(s, page1);                           // all of page 1 selected → unselect page 1
    expect(selectedFiles(s).map(x => x.id)).toEqual([4]);
  });
  it('from "some", the header checkbox selects the rest of the page', () => {
    const s = togglePage(toggleRow({}, page1[1]), page1);
    expect(pageSelectionState(s, page1)).toBe('all');
  });
  it('selection survives paging (it is keyed by id, not by row index)', () => {
    const s = toggleRow(toggleRow({}, page1[0]), page2[1]);
    expect(pageSelectionState(s, page2)).toBe('some');
    expect(selectedFiles(s).map(x => x.id).sort()).toEqual([1, 5]);
  });
  it('refreshSelection swaps in reloaded records (e.g. now deployed) and keeps identity when unchanged', () => {
    const s = toggleRow({}, f(1, { is_deployed: false }));
    const fresh = f(1, { is_deployed: true });
    expect(refreshSelection(s, [fresh])[1]).toBe(fresh);
    const same = toggleRow({}, page1[0]);
    expect(refreshSelection(same, [page1[0]])).toBe(same);
    expect(refreshSelection(same, [])).toBe(same);
  });
  it('withoutIds removes deleted files from the selection', () => {
    expect(selectedFiles(withoutIds(togglePage({}, page1), [1, 3])).map(x => x.id)).toEqual([2]);
  });
});

describe('bulk actions by role', () => {
  const sel = [f(1), f(2, { is_deployed: false }), f(3, { is_deployed: false })];
  it('ADMIN (media.manage): deploy counts only pending files; category + delete allowed', () => {
    const a = bulkActions(sel, { canEdit: true });
    expect(a.deploy).toEqual({ allowed: true, count: 2 });
    expect(a.category.allowed && a.delete.allowed && a.download.allowed).toBe(true);
  });
  it('viewer roles (no media.manage): download only', () => {
    const a = bulkActions(sel, { canEdit: false });
    expect(a.download.allowed).toBe(true);
    expect(a.deploy.allowed || a.category.allowed || a.delete.allowed).toBe(false);
  });
  it('deploy is hidden when everything selected is already deployed', () => {
    expect(bulkActions([f(1), f(2)], { canEdit: true }).deploy.allowed).toBe(false);
  });
  it('download is capped; more than MAX_BULK selected flags tooMany', () => {
    const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => f(i + 1));
    const a = bulkActions(many, { canEdit: true });
    expect(a.download).toMatchObject({ count: MAX_BULK_DOWNLOAD, capped: true });
    expect(a.tooMany).toBe(true);
    expect(bulkActions(many.slice(0, MAX_BULK), { canEdit: true }).tooMany).toBe(false);
  });
});

describe('runSequential + summarizeBulk', () => {
  it('runs strictly one at a time, never throws, reports progress and per-item outcome', async () => {
    let active = 0, maxActive = 0;
    const progress = vi.fn();
    const worker = async (item) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 2));
      active--;
      if (item.id === 2) throw Object.assign(new Error('MEDIA_IN_USE'), { status: 409, data: { error: 'MEDIA_IN_USE', dependencies: [{ kind: 'ivr_flow_draft', name: 'Main menu' }], hidden_count: 1 } });
      if (item.id === 3) throw Object.assign(new Error('busy'), { status: 503 });
      if (item.id === 4) throw new Error('boom');
    };
    const results = await runSequential([f(1), f(2), f(3), f(4)], worker, { onProgress: progress, spacingMs: 0 });
    expect(maxActive).toBe(1);
    expect(progress).toHaveBeenLastCalledWith(4, 4);
    const s = summarizeBulk(results);
    expect(s.done.map(x => x.id)).toEqual([1]);
    expect(s.inUse).toEqual([{ file: f(2), dependencies: [{ kind: 'ivr_flow_draft', name: 'Main menu' }], hiddenCount: 1 }]);
    expect(s.failed).toEqual([{ file: f(3), message: 'Busy — try again in a moment' }, { file: f(4), message: 'boom' }]);
  });
  it('waits between items (keeps clear of the API rate limit) but not after the last one', async () => {
    const sleep = vi.fn(async () => {});
    await runSequential([f(1), f(2), f(3)], async () => {}, { spacingMs: 150, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(150);
  });
  it('a 409 that is NOT MEDIA_IN_USE (e.g. duplicate) is a plain failure', () => {
    const s = summarizeBulk([{ item: f(1), ok: false, status: 409, error: 'Duplicate', data: { error: 'DUPLICATE' } }]);
    expect(s.inUse).toEqual([]);
    expect(s.failed).toEqual([{ file: f(1), message: 'Duplicate' }]);
  });
});

describe('dependency labels (409 MEDIA_IN_USE)', () => {
  it('names the referencing item and where it is used', () => {
    expect(describeDependency({ kind: 'ivr_flow_draft', name: 'Main menu', field: 'draft' })).toBe('IVR flow (draft) “Main menu” — draft');
    expect(describeDependency({ kind: 'ens_campaign_active', name: 'Fire drill' })).toBe('ENS campaign (active or in replay window) “Fire drill”');
  });
  it('another tenant\'s reference shows only its kind (no name leaks)', () => {
    expect(describeDependency({ kind: 'ers_configuration', other_tenant: true, name: 'SHOULD NOT SHOW' })).toBe('ERS configuration in another tenant');
  });
  it('unknown kinds still render', () => {
    expect(describeDependency({ kind: 'something_new' })).toBe('Other reference');
  });
});

describe('active-filter chips', () => {
  it('one chip per active filter, with readable values', () => {
    const chips = activeFilterChips({ ...initialListState(), search: '  fire ', category: 'ivr_prompt', deployed: 'false' }, { ivr_prompt: 'IVR Prompt' });
    expect(chips).toEqual([
      { key: 'search', label: 'Search', value: '“fire”' },
      { key: 'category', label: 'Category', value: 'IVR Prompt' },
      { key: 'deployed', label: 'Status', value: 'Pending' },
    ]);
  });
  it('no chips when nothing is filtered (sort and page size are not filters)', () => {
    expect(activeFilterChips({ ...initialListState(), sort: 'name', dir: 'asc', limit: 100, page: 3 })).toEqual([]);
  });
});

describe('player queue, tags, file names', () => {
  it('previous / next within the current page, null at the ends or when not on the page', () => {
    expect(adjacentFile(page1, 2, -1).id).toBe(1);
    expect(adjacentFile(page1, 2, +1).id).toBe(3);
    expect(adjacentFile(page1, 3, +1)).toBeNull();
    expect(adjacentFile(page1, 1, -1)).toBeNull();
    expect(adjacentFile(page1, 99, +1)).toBeNull();
  });
  it('parseTags trims, de-duplicates and caps', () => {
    expect(parseTags(' fire, evacuation ,fire,, en ')).toEqual(['fire', 'evacuation', 'en']);
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
    expect(parseTags('')).toEqual([]);
  });
  it('leafName never exposes the server directory', () => {
    expect(leafName('/usr/share/freeswitch/sounds/enrs/123_welcome.wav')).toBe('123_welcome.wav');
    expect(leafName('C:\\data\\x.wav')).toBe('x.wav');
    expect(leafName(null)).toBe('');
  });
});
