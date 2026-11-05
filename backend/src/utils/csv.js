// CSV writing (RFC 4180) for downloads that users open in spreadsheet programs.
//
// Escaping: a value containing a comma, double quote, CR or LF is wrapped in double
// quotes and inner quotes are doubled. Lines end with CRLF.
//
// Spreadsheet formula injection: a cell that starts with = @ TAB CR or - , or with +
// followed by anything other than phone-number characters, is prefixed with a single
// quote so spreadsheet programs show it as text instead of evaluating it. Phone numbers
// such as "+966 50 123 4567" are left untouched.

const ALWAYS_FORMULA = /^[=@\t\r-]/;
const PHONE_LIKE     = /^\+[\d\s().\-/]*$/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (ALWAYS_FORMULA.test(s) || (s.startsWith('+') && !PHONE_LIKE.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** header: array of column names; rows: array of arrays. Returns the CSV text (no BOM). */
export function toCsv(header, rows) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
