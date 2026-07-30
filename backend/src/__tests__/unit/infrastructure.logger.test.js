/**
 * Unit tests — Platform Logging Service (infrastructure/logger.js)
 *
 * Sprint 0 acceptance criterion: "All log lines are valid JSON"
 * Platform Observability Service: extensions to the Sprint 0 foundation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('infrastructure/logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importFresh() {
    vi.resetModules();
    return import('../../infrastructure/logger.js');
  }

  // ─── Sprint 0 acceptance tests (must never be modified) ──────────────────

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

  // ─── Platform Observability Service extensions ────────────────────────────

  describe('severity field', () => {
    let savedLogLevel;
    beforeEach(() => { savedLogLevel = process.env.LOG_LEVEL; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
    });

    it('info level emits severity: INFO', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      logger.info('sev test');
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.severity).toBe('INFO');
    });

    it('warn level emits severity: WARNING (GCP alias)', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      logger.warn('sev warn test');
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.severity).toBe('WARNING');
    });

    it('debug level emits severity: DEBUG', async () => {
      process.env.LOG_LEVEL = 'debug';
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      logger.debug('sev debug test');
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.severity).toBe('DEBUG');
    });

    it('error level emits severity: ERROR', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      logger.error('sev error test');
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.severity).toBe('ERROR');
    });
  });

  describe('dual call signature', () => {
    afterEach(() => vi.restoreAllMocks());

    it('pino-style (meta, msg) and legacy (msg, meta) produce identical field output', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      logger.info('my message', { op: 'test', val: 42 });
      const legacy = JSON.parse(lines[0].trim());
      lines.length = 0;

      logger.info({ op: 'test', val: 42 }, 'my message');
      const pinoStyle = JSON.parse(lines[0].trim());

      expect(pinoStyle.msg).toBe(legacy.msg);
      expect(pinoStyle.op).toBe(legacy.op);
      expect(pinoStyle.val).toBe(legacy.val);
      expect(pinoStyle.level).toBe(legacy.level);
    });

    it('(meta) with no message arg produces empty msg string', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      logger.info({ field: 'x' });
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.field).toBe('x');
      expect(typeof parsed.msg).toBe('string');
    });
  });

  describe('forModule', () => {
    afterEach(() => vi.restoreAllMocks());

    it('binds module field to every emitted line', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      const modLog = logger.forModule('ESL');
      modLog.info('originate dispatched', { callUuid: 'u-1' });
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.module).toBe('ESL');
      expect(parsed.callUuid).toBe('u-1');
    });

    it('child of forModule logger inherits module binding', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      const callLog = logger.forModule('ESL').child({ callUuid: 'u-2' });
      callLog.info('answer received');
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.module).toBe('ESL');
      expect(parsed.callUuid).toBe('u-2');
    });
  });

  describe('per-module log level', () => {
    let savedLogLevel;

    beforeEach(() => { savedLogLevel = process.env.LOG_LEVEL; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
      delete process.env.LOG_LEVEL_PLAT_TESTMOD;
      delete process.env.LOG_LEVEL_PLAT_CAMP_ENG;
    });

    it('LOG_LEVEL_<MODULE> enables debug for that module while global stays at info', async () => {
      process.env.LOG_LEVEL          = 'info';
      process.env.LOG_LEVEL_PLAT_TESTMOD = 'debug';
      const stdoutLines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { stdoutLines.push(d); return true; });
      const { logger } = await importFresh();

      const modLog = logger.forModule('PLAT_TESTMOD');
      modLog.debug('module debug — should appear');
      logger.debug('root debug — should be suppressed');

      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0].trim());
      expect(parsed.msg).toBe('module debug — should appear');
    });

    it('hyphenated module name is normalized to uppercase underscore', async () => {
      process.env.LOG_LEVEL              = 'info';
      process.env.LOG_LEVEL_PLAT_CAMP_ENG = 'debug';
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const modLog = logger.forModule('plat-camp-eng');
      modLog.debug('normalized module name');
      expect(lines).toHaveLength(1);
    });

    it('dot-separated module name is normalized to uppercase underscore', async () => {
      process.env.LOG_LEVEL              = 'info';
      process.env.LOG_LEVEL_PLAT_CAMP_ENG = 'debug';
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const modLog = logger.forModule('plat.camp.eng');
      modLog.debug('dot-separated module name');
      expect(lines).toHaveLength(1);
    });
  });

  describe('isLevelEnabled', () => {
    let savedLogLevel;

    beforeEach(() => { savedLogLevel = process.env.LOG_LEVEL; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
      delete process.env.LOG_LEVEL_PLAT_TESTMOD;
    });

    it('returns true for levels at or above global minimum', async () => {
      process.env.LOG_LEVEL = 'info';
      const { logger } = await importFresh();
      expect(logger.isLevelEnabled('info')).toBe(true);
      expect(logger.isLevelEnabled('warn')).toBe(true);
      expect(logger.isLevelEnabled('error')).toBe(true);
    });

    it('returns false for levels below global minimum', async () => {
      process.env.LOG_LEVEL = 'info';
      const { logger } = await importFresh();
      expect(logger.isLevelEnabled('debug')).toBe(false);
    });

    it('module-scoped logger reflects its own env var', async () => {
      process.env.LOG_LEVEL          = 'info';
      process.env.LOG_LEVEL_PLAT_TESTMOD = 'debug';
      const { logger } = await importFresh();
      const modLog = logger.forModule('PLAT_TESTMOD');
      expect(modLog.isLevelEnabled('debug')).toBe(true);
      expect(logger.isLevelEnabled('debug')).toBe(false);
    });

    it('returns false for unrecognised level string', async () => {
      const { logger } = await importFresh();
      expect(logger.isLevelEnabled('verbose')).toBe(false);
    });
  });

  describe('startTimer', () => {
    let savedLogLevel;

    beforeEach(() => { savedLogLevel = process.env.LOG_LEVEL; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
    });

    it('done() returns elapsed_ms as a number', async () => {
      const { logger } = await importFresh();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const done = logger.startTimer({ threshold_ms: 5000 });
      const elapsed = done();
      expect(typeof elapsed).toBe('number');
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it('emits DEBUG with elapsed_ms when under threshold', async () => {
      process.env.LOG_LEVEL = 'debug';
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const done = logger.startTimer({ threshold_ms: 5000 });
      done({ operation: 'fast-query' });

      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines[lines.length - 1].trim());
      expect(parsed.level).toBe('debug');
      expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(parsed.operation).toBe('fast-query');
    });

    it('emits WARN when threshold is exceeded', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const done = logger.startTimer({ threshold_ms: -1 }); // always exceeded
      done({ operation: 'slow-query' });

      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines[lines.length - 1].trim());
      expect(parsed.level).toBe('warn');
      expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(parsed.operation).toBe('slow-query');
    });

    it('caller-supplied msg overrides auto-generated message', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const done = logger.startTimer({ threshold_ms: -1 });
      done({ msg: 'Slow database call', operation: 'select' });

      const parsed = JSON.parse(lines[lines.length - 1].trim());
      expect(parsed.msg).toBe('Slow database call');
      expect(parsed.operation).toBe('select');
    });

    it('works without threshold — emits DEBUG on done()', async () => {
      process.env.LOG_LEVEL = 'debug';
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const done = logger.startTimer(); // no threshold
      done();

      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines[lines.length - 1].trim());
      expect(parsed.level).toBe('debug');
      expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('audit()', () => {
    let savedLogLevel;

    beforeEach(() => { savedLogLevel = process.env.LOG_LEVEL; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
    });

    it('emits regardless of LOG_LEVEL restriction', async () => {
      process.env.LOG_LEVEL = 'error'; // only errors normally pass
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      logger.audit({ actor: 'admin@example.com', resourceId: 42 }, 'Gateway updated');

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.msg).toBe('Gateway updated');
      expect(parsed.level).toBe('info');
      expect(parsed.category).toBe('audit');
    });

    it('merges bound metadata with caller context', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();
      const modLog = logger.forModule('DEPLOYMENT').child({ tenantId: 5 });

      modLog.audit({ actor: 'ops@example.com', providerId: 'dialplan:default' }, 'Provider deployed');

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.module).toBe('DEPLOYMENT');
      expect(parsed.tenantId).toBe(5);
      expect(parsed.actor).toBe('ops@example.com');
      expect(parsed.category).toBe('audit');
    });

    it('supports legacy (msg, meta) call style', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      logger.audit('User logged in', { userId: 99, ip: '10.0.0.1' });

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.msg).toBe('User logged in');
      expect(parsed.userId).toBe(99);
      expect(parsed.category).toBe('audit');
    });
  });

  describe('exception()', () => {
    afterEach(() => vi.restoreAllMocks());

    it('emits ERROR with err.message as msg and full err object', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const err = new Error('originate failed');
      logger.exception(err, { operation: 'OriginateCall', input: { callUuid: 'u-1' } });

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.level).toBe('error');
      expect(parsed.msg).toBe('originate failed');
      expect(parsed.err.message).toBe('originate failed');
      expect(parsed.err.stack).toMatch(/Error:/);
      expect(parsed.operation).toBe('OriginateCall');
      expect(parsed.input).toEqual({ callUuid: 'u-1' });
    });

    it('includes err.code when present', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const err = Object.assign(new Error('file not found'), { code: 'ENOENT' });
      logger.exception(err, { operation: 'MediaCheck' });

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.err.code).toBe('ENOENT');
    });

    it('omits err.code field when error has no code', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const err = new Error('plain error');
      logger.exception(err, {});

      const parsed = JSON.parse(lines[0].trim());
      expect('code' in parsed.err).toBe(false);
    });

    it('merges bound metadata from logger instance', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      const modLog = logger.forModule('CAMPAIGN').child({ campaignId: 7, tenantId: 2 });
      modLog.exception(new Error('tick failed'), { operation: 'tick' });

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.module).toBe('CAMPAIGN');
      expect(parsed.campaignId).toBe(7);
      expect(parsed.tenantId).toBe(2);
      expect(parsed.operation).toBe('tick');
    });

    it('falls back to Unknown error when err has no message', async () => {
      const lines = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { logger } = await importFresh();

      logger.exception(null, { operation: 'NullThrow' });

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.msg).toBe('Unknown error');
    });
  });

  describe('createModuleLogger export', () => {
    afterEach(() => vi.restoreAllMocks());

    it('createModuleLogger(name) is equivalent to logger.forModule(name)', async () => {
      const lines = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(d => { lines.push(d); return true; });
      const { createModuleLogger } = await importFresh();

      const log = createModuleLogger('DATABASE');
      log.info('pool initialized', { poolSize: 10 });

      const parsed = JSON.parse(lines[0].trim());
      expect(parsed.module).toBe('DATABASE');
      expect(parsed.poolSize).toBe(10);
    });
  });
});
