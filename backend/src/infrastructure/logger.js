/**
 * Structured JSON logger — Sprint 0 infrastructure foundation.
 *
 * Every line emitted is a valid JSON object with:
 *   timestamp  — ISO-8601 UTC
 *   level      — debug | info | warn | error
 *   service    — 'enrs-backend'
 *   pid        — process.pid
 *   msg        — human-readable message
 *   ...meta    — any caller-supplied key/value pairs (correlation_id, tenant_id, etc.)
 *
 * Usage:
 *   import { logger } from './infrastructure/logger.js';
 *   logger.info('Campaign started', { campaign_id: id, tenant_id: tid });
 *   logger.child({ correlation_id: cid }).warn('Retry limit reached');
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const SERVICE   = process.env.SERVICE_NAME ?? 'enrs-backend';

function write(level, msg, meta) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    pid: process.pid,
    msg,
    ...meta,
  });

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function createLogger(boundMeta = {}) {
  return {
    debug: (msg, meta) => write('debug', msg, { ...boundMeta, ...meta }),
    info:  (msg, meta) => write('info',  msg, { ...boundMeta, ...meta }),
    warn:  (msg, meta) => write('warn',  msg, { ...boundMeta, ...meta }),
    error: (msg, meta) => write('error', msg, { ...boundMeta, ...meta }),

    // Returns a new logger with additional fields bound to every line.
    child: (extra) => createLogger({ ...boundMeta, ...extra }),
  };
}

export const logger = createLogger();
