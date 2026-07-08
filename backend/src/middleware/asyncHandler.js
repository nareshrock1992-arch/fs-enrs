// Wraps async route handlers so unhandled Promise rejections become 500 errors
export const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Structured error logger ────────────────────────────────────────────────────
//
// Prints a full diagnostic block for every unhandled error so you can identify
// exactly which endpoint, controller, query, and parameters caused the failure.
//
// Example output:
//
//   ╔══ UNHANDLED ERROR ═══════════════════════════════════════════════
//   ║  Request   : GET /api/v1/dashboard/metrics
//   ║  Message   : column "tenant_id" does not exist
//   ║  PG Code   : 42703  (undefined_column)
//   ║  PG Table  : ers_incidents
//   ║  PG Column : tenant_id
//   ║  PG Detail : (none)
//   ║  SQL       : SELECT COUNT(*)::INT AS n FROM ers_incidents WHERE ...
//   ║  Params    : [1]
//   ║  Stack     :
//   ║    at dashboardController.js:38
//   ║    at asyncHandler.js:2
//   ╚══════════════════════════════════════════════════════════════════

// PostgreSQL error codes → human name (subset — the ones most commonly seen)
const PG_CODE_NAMES = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23502': 'not_null_violation',
  '42703': 'undefined_column',
  '42P01': 'undefined_table',
  '42601': 'syntax_error',
  '22001': 'string_data_right_truncation',
  '08006': 'connection_failure',
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
};

function logError(err, req) {
  const method = req?.method  || 'UNKNOWN';
  const url    = req?.originalUrl || req?.url || 'UNKNOWN';
  const isDb   = !!(err.code && /^\d{5}$/.test(String(err.code)));

  const lines = [
    '╔══ UNHANDLED ERROR ══════════════════════════════════════════════════',
    `║  Request   : ${method} ${url}`,
    `║  Message   : ${err.message || String(err)}`,
  ];

  if (isDb) {
    const codeName = PG_CODE_NAMES[err.code] || 'unknown';
    lines.push(`║  PG Code   : ${err.code}  (${codeName})`);
    if (err.table)    lines.push(`║  PG Table  : ${err.table}`);
    if (err.column)   lines.push(`║  PG Column : ${err.column}`);
    if (err.detail)   lines.push(`║  PG Detail : ${err.detail}`);
    if (err.hint)     lines.push(`║  PG Hint   : ${err.hint}`);
    if (err.where)    lines.push(`║  PG Where  : ${err.where}`);
  }

  // SQL and parameters — injected by pool.js query wrapper
  if (err._sql) {
    const sqlPreview = String(err._sql).replace(/\s+/g, ' ').trim();
    lines.push(`║  SQL       : ${sqlPreview.length > 400 ? sqlPreview.slice(0, 400) + '…' : sqlPreview}`);
  }
  if (err._params !== undefined) {
    lines.push(`║  Params    : ${JSON.stringify(err._params ?? [])}`);
  }

  // Stack trace — show first 8 frames, skip node_modules
  if (err.stack) {
    const frames = err.stack.split('\n').slice(1)
      .filter(l => !l.includes('node_modules') && l.trim().startsWith('at '))
      .slice(0, 8);
    if (frames.length) {
      lines.push('║  Stack     :');
      frames.forEach(f => lines.push(`║    ${f.trim()}`));
    }
  }

  lines.push('╚═════════════════════════════════════════════════════════════════');
  console.error(lines.join('\n'));
}

// Global error handler — register LAST in Express
export function errorHandler(err, req, res, _next) {
  logError(err, req);

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error:  'Validation failed',
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
  }

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with this value already exists' });
  }

  // PostgreSQL FK violation
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Referenced record does not exist' });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
