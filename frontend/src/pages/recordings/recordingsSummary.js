// Pure helpers for the Recordings page (unit-tested in __tests__/recordingsSummary.test.js).

export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Tab and status counts from the server's `summary` (whole filtered result set).
 * Missing summary (older backend / failed request) yields zeros — never counts
 * derived from the rows currently loaded on the page.
 */
export function summaryCounts(summary) {
  const byType = summary?.by_type || {};
  const byStatus = summary?.by_status || {};
  return {
    byType,
    allTypes: Number(summary?.all_types_total) || 0,
    active: Number(byStatus.RECORDING) || 0,
    completed: Number(byStatus.COMPLETED) || 0,
  };
}
