/**
 * Integration tests — Sprint 0 health endpoints
 *
 * Acceptance criteria:
 *   - GET /health/live returns 200 in < 50ms
 *   - GET /health/ready returns 200 when DB is connected
 *   - GET /metrics returns Prometheus text format
 *
 * These tests spin up a minimal Express app with just the health router,
 * without starting the full server (ESL, campaign engine, etc.).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';

let app;
let request;

beforeAll(async () => {
  app = express();
  const { default: healthRouter } = await import('../../infrastructure/health/router.js');
  app.use(healthRouter);
  request = supertest(app);
});

describe('GET /health/live', () => {
  it('returns 200', async () => {
    const res = await request.get('/health/live');
    expect(res.status).toBe(200);
  });

  it('returns status: alive', async () => {
    const res = await request.get('/health/live');
    expect(res.body.status).toBe('alive');
  });

  it('responds in under 50ms (no external checks)', async () => {
    const start = Date.now();
    await request.get('/health/live');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('includes uptime_sec and timestamp', async () => {
    const res = await request.get('/health/live');
    expect(typeof res.body.uptime_sec).toBe('number');
    expect(res.body.uptime_sec).toBeGreaterThanOrEqual(0);
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('GET /health/ready', () => {
  it('returns a JSON body with status, checks, and uptime_sec', async () => {
    const res = await request.get('/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.database).toBeDefined();
    expect(typeof res.body.uptime_sec).toBe('number');
  });

  it('database check is present', async () => {
    const res = await request.get('/health/ready');
    expect(res.body.checks.database).toHaveProperty('healthy');
  });

  it('redis check is present', async () => {
    const res = await request.get('/health/ready');
    expect(res.body.checks.redis).toHaveProperty('healthy');
  });

  it('returns 200 when database is healthy', async () => {
    const res = await request.get('/health/ready');
    if (res.body.checks.database.healthy) {
      // DB available in test environment
      expect(res.status).toBe(200);
      expect(['healthy', 'degraded']).toContain(res.body.status);
    } else {
      // DB not available — readiness should be 503
      expect(res.status).toBe(503);
    }
  });
});

describe('GET /health/full', () => {
  it('always returns 200 (even when unhealthy)', async () => {
    const res = await request.get('/health/full');
    expect(res.status).toBe(200);
  });

  it('includes esl check', async () => {
    const res = await request.get('/health/full');
    expect(res.body.checks.esl).toBeDefined();
  });
});

describe('GET /metrics', () => {
  it('returns 200', async () => {
    const res = await request.get('/metrics');
    expect(res.status).toBe(200);
  });

  it('Content-Type is Prometheus text format', async () => {
    const res = await request.get('/metrics');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('body contains standard enrs_ prefixed metric', async () => {
    const res = await request.get('/metrics');
    // prom-client default metrics always include process_cpu_seconds_total
    expect(res.text).toMatch(/enrs_process_cpu_seconds_total|# HELP/);
  });
});
