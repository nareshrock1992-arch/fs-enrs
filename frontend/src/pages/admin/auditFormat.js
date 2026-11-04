// Presentation of audit records. The stored codes are kept as they are (and shown in the
// details view); these helpers only make them readable.

const LABELS = {
  conference_control: 'Conference control',
  global_setting_changed: 'Global setting changed',
  report_exported: 'Report exported',
  ers_playback_attempt: 'ERS playback attempt',
  ers_playback_line: 'ERS playback line',
  ivr: 'IVR',
  ens: 'ENS',
  ers: 'ERS',
};

/** "global_setting_changed" → "Global setting changed"; known acronyms kept upper case. */
export function auditActionLabel(code) {
  if (!code) return '';
  if (LABELS[code]) return LABELS[code];
  const words = String(code).split(/[_.:-]+/).filter(Boolean)
    .map((w) => (['ivr', 'ens', 'ers', 'sip', 'esl', 'id', 'url'].includes(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  if (words.length === 0) return String(code);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

const KEY_LABELS = { tenant_id: 'Tenant', role: 'Role', method: 'Method', command: 'Command', key: 'Setting', report: 'Report', rows: 'Rows', format: 'Format' };

function valueText(k, v, tenantName) {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'tenant_id') return tenantName?.(v) ? `${tenantName(v)} (${v})` : String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parse(details) {
  if (!details) return {};
  if (typeof details === 'string') { try { return JSON.parse(details) || {}; } catch { return { value: details }; } }
  return typeof details === 'object' ? details : { value: String(details) };
}

/** [[label, text], …] for the details view. */
export function detailEntries(details, tenantName) {
  return Object.entries(parse(details)).map(([k, v]) => [KEY_LABELS[k] || auditActionLabel(k), valueText(k, v, tenantName)]);
}

/** One line for the table: "Tenant: Northwind (3) · Method: POST · Command: /lock". */
export function auditSummary(details, tenantName) {
  return detailEntries(details, tenantName).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' · ');
}
