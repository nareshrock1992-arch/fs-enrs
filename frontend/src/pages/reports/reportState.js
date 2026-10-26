// Pure helpers shared by the ERS / ENS report pages (unit-tested, no React).

// Latest-request guard: a slow response for an old filter/page/tenant must never
// overwrite the result of a newer request.
export function createLatestGuard() {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (token) => token === seq,
  };
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Summary over the WHOLE filtered result set, as computed by the server. Returns null
// when the server sent none, so the page shows nothing rather than page-only numbers.
export function ersSummary(resp) {
  const s = resp?.summary;
  if (!s) return null;
  return {
    total: n(s.total), active: n(s.active), completed: n(s.completed),
    responders: n(s.responders), answered: n(s.responders_answered),
  };
}

export function ensSummary(resp) {
  const s = resp?.summary;
  if (!s) return null;
  return {
    total: n(s.total), running: n(s.running), completed: n(s.completed),
    destinations: n(s.destinations), answered: n(s.destinations_answered),
  };
}

// User-facing message for a failed load (the API error text when present).
export function loadErrorMessage(e) {
  const msg = e?.message || e?.error;
  return msg ? String(msg) : 'The report could not be loaded.';
}

// RFC 4180 CSV cell: quote when needed, double embedded quotes, and neutralise
// spreadsheet formulas (a value starting with = + - @ or a tab/CR is prefixed with ').
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // numbers like -5 stay numbers
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells) => cells.map(csvCell).join(',');
