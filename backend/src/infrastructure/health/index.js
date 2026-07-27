/**
 * Health check aggregator — Sprint 0 infrastructure foundation.
 *
 * Collects health status from all infrastructure dependencies and
 * returns a normalised HealthStatus object.
 *
 * Status rules:
 *   healthy   — all required checks pass
 *   degraded  — at least one optional check fails, all required checks pass
 *   unhealthy — at least one required check fails
 *
 * Required checks: database
 * Optional checks: redis, esl
 *
 * ESL check is optional because the app works without FreeSWITCH
 * (dashboards, config management, reporting are all available).
 * Redis check is optional in dev but should be required in production
 * when Socket.IO Redis adapter is enabled.
 */

import { healthCheck as dbHealthCheck } from '../db/pool.js';
import { healthCheck as redisHealthCheck } from '../redis/client.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'health' });

const STARTUP_TIME = Date.now();

/**
 * @returns {{ status: 'healthy'|'degraded'|'unhealthy', checks: object, uptime_sec: number }}
 */
export async function getHealthStatus() {
  const [db, redis] = await Promise.allSettled([
    dbHealthCheck(),
    redisHealthCheck(),
  ]);

  const checks = {
    database: db.status === 'fulfilled'
      ? db.value
      : { healthy: false, error: db.reason?.message },

    redis: redis.status === 'fulfilled'
      ? redis.value
      : { healthy: false, error: redis.reason?.message },
  };

  // Attempt to pull ESL status if the service is already loaded.
  // We do a dynamic import so health checks work even before ESL connects.
  try {
    const { eslStatus } = await import('../../services/eslService.js');
    const esl = eslStatus();
    checks.esl = { healthy: esl.connected, host: esl.host, port: esl.port };
  } catch {
    checks.esl = { healthy: false, error: 'ESL service not loaded' };
  }

  const dbHealthy    = checks.database.healthy === true;
  const redisHealthy = checks.redis.healthy    === true;

  let status;
  if (!dbHealthy) {
    status = 'unhealthy';
  } else if (!redisHealthy) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return {
    status,
    checks,
    uptime_sec: Math.floor((Date.now() - STARTUP_TIME) / 1000),
    timestamp:  new Date().toISOString(),
  };
}

/**
 * Liveness: the process is alive and the event loop is not blocked.
 * Does NOT check external dependencies.
 */
export function getLivenessStatus() {
  return {
    status:     'alive',
    uptime_sec: Math.floor((Date.now() - STARTUP_TIME) / 1000),
    timestamp:  new Date().toISOString(),
    pid:        process.pid,
  };
}
