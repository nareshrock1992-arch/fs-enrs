/**
 * Health check router — Sprint 0 infrastructure foundation.
 *
 * GET /health/live   — liveness probe (no external deps; always fast)
 * GET /health/ready  — readiness probe (checks DB + Redis)
 * GET /health/full   — full status with all check details (authenticated in prod)
 * GET /metrics       — Prometheus text format exposition
 *
 * Mount in server.js:
 *   import healthRouter from './src/infrastructure/health/router.js';
 *   app.use(healthRouter);
 */

import { Router } from 'express';
import { getLivenessStatus, getHealthStatus } from './index.js';
import { metricsText } from '../metrics.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'health-router' });
const router = Router();

// GET /health/live — liveness probe
// Should never return 5xx unless the process is fatally broken.
// Kubernetes/PM2 watchdogs call this to decide whether to restart.
router.get('/health/live', (_req, res) => {
  res.status(200).json(getLivenessStatus());
});

// GET /health/ready — readiness probe
// Returns 200 when the process is ready to serve traffic.
// Returns 503 when a required dependency (DB) is unavailable.
// Kubernetes calls this to decide whether to route traffic.
router.get('/health/ready', async (_req, res) => {
  try {
    const status = await getHealthStatus();
    const httpStatus = status.status === 'unhealthy' ? 503 : 200;
    res.status(httpStatus).json(status);
  } catch (err) {
    log.error('Health check threw', { error: err.message });
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// GET /health/full — detailed status (same as ready but always returns body)
// Intended for operator dashboards — not for automated probes.
router.get('/health/full', async (_req, res) => {
  try {
    const status = await getHealthStatus();
    res.status(200).json(status);
  } catch (err) {
    log.error('Health check threw', { error: err.message });
    res.status(200).json({ status: 'unhealthy', error: err.message });
  }
});

// GET /metrics — Prometheus text format
// In production this endpoint should be firewalled (only accessible from
// the Prometheus scraper IP). No auth middleware here — add network-level
// restriction in Nginx / firewall rules.
router.get('/metrics', async (_req, res) => {
  try {
    const body = await metricsText();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(body);
  } catch (err) {
    res.status(500).send(`# Error: ${err.message}\n`);
  }
});

export default router;
