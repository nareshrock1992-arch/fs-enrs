/**
 * Unit tests — infrastructure logger
 * Sprint 0 acceptance criterion: "All log lines are valid JSON"
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('infrastructure/logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importFresh() {
    // Clear module cache between tests by using a cache-busting query param.
    // In vitest we can use vi.resetModules() for a clean import.
    vi.resetModules();
    return import('../../infrastructure/logger.js');
  }

  it('emits valid JSON on stdout for info level', async () => {
    const lines = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      lines.push(data);
      return true;
    });

    const { logger } = await importFresh();
    logger.info('test message', { foo: 'bar' });

    expect(writeSpy).toHaveBeenCalled();
    const raw = lines.join('');
    const parsed = JSON.parse(raw.trim());

    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.foo).toBe('bar');
    expect(parsed.service).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.pid).toBe(process.pid);
  });

  it('emits errors to stderr', async () => {
    const lines = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      lines.push(data);
      return true;
    });

    const { logger } = await importFresh();
    logger.error('something broke', { code: 'ERR_500' });

    expect(writeSpy).toHaveBeenCalled();
    const parsed = JSON.parse(lines.join('').trim());
    expect(parsed.level).toBe('error');
    expect(parsed.code).toBe('ERR_500');
  });

  it('child logger merges bound metadata into every line', async () => {
    const lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      lines.push(data);
      return true;
    });

    const { logger } = await importFresh();
    const child = logger.child({ correlation_id: 'abc-123', tenant_id: 'tenant-x' });
    child.info('child log');

    const parsed = JSON.parse(lines.join('').trim());
    expect(parsed.correlation_id).toBe('abc-123');
    expect(parsed.tenant_id).toBe('tenant-x');
    expect(parsed.msg).toBe('child log');
  });

  it('additional call-site metadata merges with bound metadata', async () => {
    const lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      lines.push(data);
      return true;
    });

    const { logger } = await importFresh();
    const child = logger.child({ correlation_id: 'base' });
    child.info('extra field', { campaign_id: 'camp-1' });

    const parsed = JSON.parse(lines.join('').trim());
    expect(parsed.correlation_id).toBe('base');
    expect(parsed.campaign_id).toBe('camp-1');
  });
});
