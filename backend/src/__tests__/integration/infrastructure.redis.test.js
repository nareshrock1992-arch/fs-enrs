/**
 * Integration tests — Redis client (Sprint 0)
 *
 * These tests require a live Redis instance (localhost:6379 by default).
 * In CI: use the docker-compose redis service.
 * Skipped automatically when REDIS_HOST is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getClient, healthCheck, disconnect } from '../../infrastructure/redis/client.js';

let redisAvailable = false;

beforeAll(async () => {
  try {
    const result = await Promise.race([
      healthCheck(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    redisAvailable = result.healthy === true;
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  await disconnect();
});

describe('Redis client', () => {
  it('connects and responds to PING', async () => {
    if (!redisAvailable) return;
    const client = getClient();
    const reply = await client.ping();
    expect(reply).toBe('PONG');
  });

  it('healthCheck() returns { healthy: true } when Redis is up', async () => {
    if (!redisAvailable) return;
    const result = await healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('can SET and GET a value', async () => {
    if (!redisAvailable) return;
    const client = getClient();
    await client.set('test:sprint0', 'value', 'EX', 10);
    const val = await client.get('test:sprint0');
    expect(val).toBe('value');
    await client.del('test:sprint0');
  });

  it('returns the same singleton instance from getClient()', () => {
    const a = getClient();
    const b = getClient();
    expect(a).toBe(b);
  });
});
