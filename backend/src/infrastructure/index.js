/**
 * Infrastructure layer barrel — Sprint 0.
 *
 * Provides clean import paths for the new module system.
 * New modules (Sprint 1+) import from here rather than relative paths.
 *
 * Usage:
 *   import { logger, metrics, eventBus } from '../infrastructure/index.js';
 */

export { logger }    from './logger.js';
export { metrics, metricsText } from './metrics.js';
export { getClient as getRedis, healthCheck as redisHealthCheck, disconnect as redisDisconnect } from './redis/client.js';
export { eventBus, InProcessEventBus } from './eventBus/InProcessEventBus.js';
export { getHealthStatus, getLivenessStatus } from './health/index.js';
export { validateEnvironment } from './config/validator.js';
