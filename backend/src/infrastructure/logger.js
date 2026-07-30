/**
 * Platform Logging Service — structured JSON logger (Platform Observability Framework).
 *
 * Every line is a valid JSON object with at minimum:
 *   timestamp   ISO-8601 UTC
 *   level       debug | info | warn | error
 *   severity    DEBUG | INFO | WARNING | ERROR  (GCP / Azure / enterprise ingestion alias)
 *   service     process.env.SERVICE_NAME ?? 'enrs-backend'
 *   pid         process.pid
 *   msg         human-readable message
 *   ...meta     caller-supplied context (correlation IDs, module, operation, etc.)
 *
 * Call signatures (both supported):
 *   logger.info('message', { field: value })              — legacy (msg, meta)
 *   logger.info({ field: value }, 'message')              — structured (meta, msg)
 *   logger.child({ module: 'ESL', callUuid })             — scope to a context
 *   logger.forModule('ESL')                               — module-scoped logger
 *   logger.isLevelEnabled('debug')                        — guard expensive work
 *   const done = logger.startTimer({ threshold_ms: 200 }) — performance timing
 *   logger.audit({ actor, resourceId }, 'Config updated') — compliance; never suppressed
 *   logger.exception(err, { operation, input })           — exception policy helper
 *
 * Per-module log level (env vars read at call time — no restart needed):
 *   LOG_LEVEL=info                   global default
 *   LOG_LEVEL_ESL=debug              ESL module at DEBUG, others at global default
 *   LOG_LEVEL_CAMPAIGN_ENGINE=debug  'campaign-engine' → CAMPAIGN_ENGINE (hyphens→underscores)
 *
 * Enterprise integrations: newline-delimited JSON to stdout/stderr.
 * ELK, OpenSearch, Splunk, Grafana Loki, AWS CloudWatch, Azure Monitor, and GCP Cloud Logging
 * all accept this format via their respective agents — zero application code changes required.
 */

const LEVELS   = { debug: 0, info: 1, warn: 2, error: 3 };
const SEVERITY = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };
const SERVICE  = process.env.SERVICE_NAME ?? 'enrs-backend';

// 'campaign-engine' → 'CAMPAIGN_ENGINE'  (for LOG_LEVEL_CAMPAIGN_ENGINE lookup)
function normalizeModuleName(name) {
  return name.toUpperCase().replace(/[-.\s]+/g, '_');
}

// Per-module env var checked first; falls back to global LOG_LEVEL; defaults to info.
// Read at call time so a running process can change verbosity without a restart.
function effectiveMinLevel(moduleName) {
  if (moduleName) {
    const envVal = process.env[`LOG_LEVEL_${normalizeModuleName(moduleName)}`]?.toLowerCase();
    if (envVal !== undefined && LEVELS[envVal] !== undefined) return LEVELS[envVal];
  }
  const globalVal = process.env.LOG_LEVEL?.toLowerCase();
  return LEVELS[globalVal] ?? LEVELS.info;
}

// Normalise (msg, meta) and (meta, msg) into a canonical { msg, meta } pair.
function resolveArgs(first, second) {
  return typeof first === 'string'
    ? { msg: first, meta: second ?? {} }
    : { msg: second ?? '', meta: first ?? {} };
}

// Core writer.
// moduleName — the logger instance's bound module, used for per-module level check.
// skipLevelCheck — true only for audit(), which must never be suppressed.
function writeEntry(level, msg, meta, moduleName, skipLevelCheck) {
  if (!skipLevelCheck && LEVELS[level] < effectiveMinLevel(moduleName)) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    severity: SEVERITY[level],
    service:  SERVICE,
    pid:      process.pid,
    msg,
    ...meta,
  });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

function createLogger(boundMeta = {}) {
  const moduleName = boundMeta.module ?? null;

  function log(level, first, second) {
    const { msg, meta } = resolveArgs(first, second);
    writeEntry(level, msg, { ...boundMeta, ...meta }, moduleName);
  }

  return {
    debug: (first, second) => log('debug', first, second),
    info:  (first, second) => log('info',  first, second),
    warn:  (first, second) => log('warn',  first, second),
    error: (first, second) => log('error', first, second),

    // Returns a new logger with additional fields merged into every subsequent line.
    child: (extra) => createLogger({ ...boundMeta, ...extra }),

    // Returns a module-scoped logger that reads LOG_LEVEL_<MODULE> automatically.
    forModule: (name) => createLogger({ ...boundMeta, module: name }),

    // Returns true when the given level passes the effective filter for this logger instance.
    // Use to guard expensive serialisation before calling write:
    //   if (log.isLevelEnabled('debug')) { log.debug({ raw: evt.serialize() }, 'ESL event'); }
    isLevelEnabled(level) {
      return LEVELS[level] !== undefined && LEVELS[level] >= effectiveMinLevel(moduleName);
    },

    // Performance timer. Returns a done(context?) callback.
    // done() emits WARN when elapsed > threshold_ms (always visible); DEBUG otherwise (dev only).
    // done({ operation, ...extra }) — context fields merged into the log entry.
    // done({ msg, operation, ...extra }) — 'msg' field overrides the auto-generated message.
    startTimer({ threshold_ms } = {}) {
      const start = Date.now();
      return (context = {}) => {
        const elapsed = Date.now() - start;
        const { msg: ctxMsg, ...ctxMeta } =
          context !== null && typeof context === 'object' ? context : {};
        const combined  = { ...boundMeta, ...ctxMeta, elapsed_ms: elapsed };
        const exceeded  = threshold_ms !== undefined && elapsed > threshold_ms;
        const autoMsg   = exceeded
          ? `Slow operation — ${elapsed}ms exceeded ${threshold_ms}ms threshold`
          : 'Operation completed';
        writeEntry(exceeded ? 'warn' : 'debug', ctxMsg ?? autoMsg, combined, moduleName);
        return elapsed;
      };
    },

    // Compliance / audit log. Emitted at INFO regardless of LOG_LEVEL — never suppressed.
    // Use for: configuration changes, authentication, role assignment, tenant actions.
    audit(first, second) {
      const { msg, meta } = resolveArgs(first, second);
      writeEntry('info', msg, { ...boundMeta, ...meta, category: 'audit' }, moduleName, true);
    },

    // Exception policy helper. Extracts message and stack from err; merges caller context.
    // Caller decides whether to re-throw after calling this.
    exception(err, context = {}) {
      writeEntry('error', err?.message ?? 'Unknown error', {
        ...boundMeta,
        ...context,
        err: {
          message: err?.message,
          stack:   err?.stack,
          ...(err?.code !== undefined ? { code: err.code } : {}),
        },
      }, moduleName);
    },
  };
}

export const logger             = createLogger();
export const createModuleLogger = (name) => createLogger({ module: name });

// Startup health log: tells operators which log level is active without reading env files.
// Suppressed in test environments to avoid corrupting test output (tests mock stdout/stderr
// and parse single JSON lines — an extra line would break JSON.parse).
if (process.env.NODE_ENV !== 'test') {
  writeEntry('info', 'Platform Logging Service initialized', {
    category: 'health',
    module:   'platform',
    minLevel: process.env.LOG_LEVEL?.toLowerCase() ?? 'info',
  }, null, false);
}
