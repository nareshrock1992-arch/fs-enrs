/**
 * Redis client — Sprint 0 infrastructure foundation.
 *
 * Single ioredis instance for the process. Provides:
 *   - Automatic reconnection with exponential backoff (capped at 30 s)
 *   - Structured error logging via the infrastructure logger
 *   - healthCheck() for the /health/ready endpoint
 *   - Graceful shutdown via disconnect()
 *
 * The connection is lazy — ioredis connects on first command, not at import.
 * Use getClient() to obtain the shared instance.
 *
 * Configuration env vars:
 *   REDIS_URL    — full URL e.g. redis://localhost:6379  (takes priority)
 *   REDIS_HOST   — default: 127.0.0.1
 *   REDIS_PORT   — default: 6379
 *   REDIS_PASSWORD — optional
 *   REDIS_DB     — database index, default: 0
 */

import Redis from 'ioredis';
import { logger } from '../logger.js';

const log = logger.child({ module: 'redis' });

function buildConfig() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  return {
    host:     process.env.REDIS_HOST     ?? '127.0.0.1',
    port:     Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? undefined,
    db:       Number(process.env.REDIS_DB  ?? 0),
  };
}

function createClient() {
  const cfg = buildConfig();

  const opts = {
    // Reconnection strategy: exponential backoff capped at 30 s.
    // Return null to stop retrying (never — we always want to reconnect).
    retryStrategy(times) {
      const delay = Math.min(100 * Math.pow(2, times), 30_000);
      log.warn('Redis reconnecting', { attempt: times, delay_ms: delay });
      return delay;
    },

    // Do not crash the process on connection errors — let retryStrategy handle them.
    enableOfflineQueue: true,

    // Lazy connect: don't attempt connection until the first command.
    lazyConnect: false,

    // Connection name visible in Redis CLIENT LIST
    connectionName: 'enrs-backend',

    ...(cfg.url ? { url: cfg.url } : cfg),
  };

  const client = cfg.url ? new Redis(cfg.url, opts) : new Redis(opts);

  client.on('connect', () => {
    log.info('Redis connected', { host: cfg.host ?? cfg.url, port: cfg.port });
  });

  client.on('ready', () => {
    log.info('Redis ready');
  });

  client.on('error', (err) => {
    log.error('Redis error', { error: err.message });
  });

  client.on('close', () => {
    log.warn('Redis connection closed');
  });

  client.on('reconnecting', (delay) => {
    log.warn('Redis reconnecting', { delay_ms: delay });
  });

  return client;
}

// Singleton — one client per process.
let _client = null;

export function getClient() {
  if (!_client) {
    _client = createClient();
  }
  return _client;
}

/**
 * Performs a PING and resolves to { healthy: true } or { healthy: false, error }.
 * Times out after 2 s so it never blocks the health check indefinitely.
 */
export async function healthCheck() {
  const client = getClient();

  if (client.status === 'end' || client.status === 'close') {
    return { healthy: false, error: `Client status: ${client.status}` };
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Redis health check timeout')), 2_000)
  );

  try {
    const reply = await Promise.race([client.ping(), timeout]);
    return { healthy: reply === 'PONG', status: client.status };
  } catch (err) {
    return { healthy: false, error: err.message, status: client.status };
  }
}

/**
 * Gracefully disconnect. Call during process shutdown AFTER all in-flight
 * operations complete. Safe to call multiple times.
 */
export async function disconnect() {
  if (_client) {
    await _client.quit().catch(() => _client.disconnect());
    _client = null;
    log.info('Redis disconnected');
  }
}
