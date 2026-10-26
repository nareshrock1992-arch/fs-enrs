// Recordings page counts must come from the server summary (whole filtered set).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { summaryCounts, SEARCH_DEBOUNCE_MS } from '../pages/recordings/recordingsSummary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.resolve(__dirname, '../pages/recordings/Recordings.jsx'), 'utf8');

describe('summaryCounts', () => {
  it('maps the server summary to tab and status counts', () => {
    expect(summaryCounts({ by_type: { ERS: 120, ENS: 4 }, all_types_total: 124, by_status: { COMPLETED: 110, RECORDING: 2 } }))
      .toEqual({ byType: { ERS: 120, ENS: 4 }, allTypes: 124, active: 2, completed: 110 });
  });
  it('yields zeros (not page-derived numbers) when there is no summary', () => {
    expect(summaryCounts(null)).toEqual({ byType: {}, allTypes: 0, active: 0, completed: 0 });
  });
  it('debounce interval is a sensible typing delay', () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(200);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(600);
  });
});

describe('Recordings page wiring (source checks)', () => {
  it('no longer derives tab/status counts from the loaded rows', () => {
    expect(PAGE).not.toMatch(/recordings\.reduce\(/);
    expect(PAGE).not.toMatch(/recordings\.filter\(r => r\.status === 'COMPLETED'\)/);
    expect(PAGE).toMatch(/summaryCounts\(summary\)/);
  });
  it('ignores stale responses and shows load errors with a retry', () => {
    expect(PAGE).toMatch(/seq !== requestSeq\.current/);
    expect(PAGE).toMatch(/role="alert"/);
    expect(PAGE).toMatch(/Retry/);
  });
  it('the search placeholder only promises fields the API searches (file name, notes)', () => {
    expect(PAGE).toMatch(/placeholder="Search file name or notes…"/);
    expect(PAGE).not.toMatch(/Search room, file, notes/);
  });
  it('warns instead of silently presenting a partial page as complete', () => {
    expect(PAGE).toMatch(/total > recordings\.length/);
  });
});
