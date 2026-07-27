/**
 * Infrastructure DB pool — Sprint 0 infrastructure foundation.
 *
 * Re-exports from the canonical pool at src/db/pool.js.
 * Adds a healthCheck() function that satisfies the IHealthCheck interface.
 *
 * New infrastructure modules import from here.
 * Existing modules that import from '../../db/pool.js' continue to work unchanged.
 */

export { pool, query, withTransaction, testConnection } from '../../db/pool.js';

/**
 * Returns { healthy: true, latency_ms } or { healthy: false, error, latency_ms }.
 * Times out after 3 s.
 */
export async function healthCheck() {
  const { query } = await import('../../db/pool.js');
  const start = Date.now();

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('DB health check timeout')), 3_000)
  );

  try {
    await Promise.race([query('SELECT 1'), timeout]);
    return { healthy: true, latency_ms: Date.now() - start };
  } catch (err) {
    return { healthy: false, error: err.message, latency_ms: Date.now() - start };
  }
}
