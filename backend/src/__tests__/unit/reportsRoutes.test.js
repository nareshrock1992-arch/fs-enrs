/**
 * /api/v1/reports — validation, role gate and tenant scoping (Phase 3,
 * docs/MEDIA_REPORTING_MISSION.md). REAL router, auth, rbac and tenantScope with REAL
 * JWTs; the database is an emulator that records every query. Tenant filters are
 * honoured only when the SQL text itself carries the clause. The SQL semantics
 * (fan-out, recording choice, playback scope) are verified against real PostgreSQL
 * in the isolated e2e run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { URL } from 'url';

let calls = [];
const AUDIT = [
  { details: { configuration_id: 1, caller: '100', outcome: 'allowed' }, created_at: '2026-10-01T10:00:00Z', cfgTenant: 10 },
  { details: { configuration_id: 2, caller: '200', outcome: 'rejected' }, created_at: '2026-10-01T11:00:00Z', cfgTenant: 20 },
];
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ s, p });
    if (/FROM audit_logs a/.test(s)) {
      const scoped = /ec\.tenant_id = \$3/.test(s);
      return { rows: AUDIT.filter(a => !scoped || p[2] == null || a.cfgTenant === p[2]).map(({ details, created_at }) => ({ details, created_at })) };
    }
    if (/INSERT INTO audit_logs/.test(s)) return { rows: [] };
    if (/COUNT\(DISTINCT c\.id\)::INT AS campaigns/.test(s)) return { rows: [globalThis.__exportSize] };
    if (/COUNT\(\*\)::INT AS incidents/.test(s)) return { rows: [{ incidents: 1, details: globalThis.__exportSize.recipients }] };
    if (/COUNT\(\*\)::INT AS total/.test(s)) return { rows: [{ total: 0, active: 0, completed: 0, responders: 0, answered: 0, running: 0, destinations: 0 }] };
    return { rows: [] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const { config } = await import('../../config/index.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');
const reportsRouter = (await import('../../routes/v1/reports.js')).default;
const { parseReportQuery, roomWindowEnd, BUSY_CAUSE_LIST, NO_ANSWER_CAUSE_LIST } = await import('../../routes/v1/reports.js');

const app = express();
app.use('/reports', reportsRouter);
app.use(errorHandler);
const tok = (c) => jwt.sign(c, config.jwt.accessSecret, { expiresIn: '15m' });
const as = (t) => ({ Authorization: `Bearer ${t}` });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const OP10 = tok({ id: 4, role: 'OPERATOR', tenantId: 10 });
const SUP10 = tok({ id: 8, role: 'SUPERVISOR', tenantId: 10 });
const VIEW10 = tok({ id: 9, role: 'VIEWER', tenantId: 10 });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });
const ORPHAN = tok({ id: 7, role: 'ADMIN', tenantId: null });

beforeEach(() => {
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('role gate (adminOrOp) and tenant context', () => {
  it('SUPERVISOR / VIEWER → 403; tenant-less → 403; no token → 401; OPERATOR / ADMIN → 200', async () => {
    for (const t of [SUP10, VIEW10, ORPHAN]) expect((await request(app).get('/reports/ers').set(as(t))).status).toBe(403);
    expect((await request(app).get('/reports/ers')).status).toBe(401);
    expect((await request(app).get('/reports/ers').set(as(OP10))).status).toBe(200);
    expect((await request(app).get('/reports/ens-campaigns').set(as(A10))).status).toBe(200);
  });
});

describe('tenant scoping', () => {
  it('ENS broadcast playback log only shows attempts for the caller tenant\'s ERS configurations', async () => {
    const r = await request(app).get('/reports/ens-broadcasts').set(as(A10));
    expect(r.status).toBe(200);
    expect(r.body.playback_access_log.map(a => a.details.configuration_id)).toEqual([1]);
    const audit = calls.find(c => /FROM audit_logs a/.test(c.s));
    expect(audit.p[2]).toBe(10);                                     // tenant from the token
  });
  it('a forged ?tenant_id is ignored for tenant users; SUPER_ADMIN sees all or one tenant', async () => {
    await request(app).get('/reports/ens-broadcasts?tenant_id=20').set(as(A10));
    expect(calls.find(c => /FROM audit_logs a/.test(c.s)).p[2]).toBe(10);
    calls = [];
    const all = await request(app).get('/reports/ens-broadcasts').set(as(SA));
    expect(all.body.playback_access_log).toHaveLength(2);
    calls = [];
    const one = await request(app).get('/reports/ens-broadcasts?tenant_id=20').set(as(SA));
    expect(one.body.playback_access_log.map(a => a.details.configuration_id)).toEqual([2]);
  });
  it('every list query passes the token tenant as its tenant parameter', async () => {
    for (const p of ['/reports/ers', '/reports/ens', '/reports/ens-campaigns', '/reports/notifications', '/reports/contact-usage']) {
      calls = [];
      expect((await request(app).get(p).set(as(A10))).status, p).toBe(200);
      for (const c of calls) {
        expect(c.s, p).toMatch(/tenant_id = \$\d/);
        expect(c.p, p).toContain(10);
      }
    }
  });
});

describe('Excel exports', () => {
  const U = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
  beforeEach(() => { globalThis.__exportSize = { campaigns: 1, recipients: 2 }; });
  const binary = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  it('returns a real .xlsx with no-store, and records who exported what', async () => {
    const r = await binary(request(app).get('/reports/ers/export?from=2026-10-01').set(as(OP10)));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.readUInt32LE(0)).toBe(0x04034b50);
    expect(r.body.toString('latin1')).toContain('xl/worksheets/sheet4.xml');
    const audit = calls.find(c => /report_exported/.test(c.s));
    expect(audit.p[1]).toBe('ers-incidents');
    expect(JSON.parse(audit.p[2]).filters.from).toBe('2026-10-01');
  });
  it('every export query is tenant-scoped with the token tenant; a forged ?tenant_id changes nothing', async () => {
    for (const p of ['/reports/ens-campaigns/export?tenant_id=20', `/reports/ens-campaigns/${U}/export?tenant_id=20`, '/reports/ers/export?tenant_id=20']) {
      calls = [];
      expect((await binary(request(app).get(p).set(as(A10)))).status, p).toBe(200);
      // current_setting reads no tenant data
      const selects = calls.filter(c => /^\s*SELECT/.test(c.s) && !/current_setting/.test(c.s));
      expect(selects.length, p).toBeGreaterThanOrEqual(3);
      for (const c of selects) {
        expect(c.s, p).toMatch(/tenant_id = \$1/);
        expect(c.p[0], p).toBe(10);
      }
    }
  });
  it('role gate, tenant context and validation apply as on the lists', async () => {
    for (const t of [SUP10, VIEW10, ORPHAN]) expect((await request(app).get('/reports/ers/export').set(as(t))).status).toBe(403);
    expect((await request(app).get('/reports/ens-campaigns/export')).status).toBe(401);
    calls = [];
    expect((await request(app).get('/reports/ers/export?from=bad').set(as(A10))).status).toBe(400);
    expect((await request(app).get('/reports/ens-campaigns/abc/export').set(as(A10))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('another tenant\'s (or an unknown) campaign is a 404', async () => {
    globalThis.__exportSize = { campaigns: 0, recipients: 0 };
    expect((await request(app).get(`/reports/ens-campaigns/${U}/export`).set(as(A10))).status).toBe(404);
  });
  it('a selection over the row cap is refused before any detail query', async () => {
    globalThis.__exportSize = { campaigns: 1, recipients: 50_000 };
    calls = [];
    const r = await request(app).get('/reports/ens-campaigns/export').set(as(A10));
    expect(r.status).toBe(413);
    expect(r.body.max_rows).toBe(50_000);
    expect(calls).toHaveLength(1);
    expect((await request(app).get('/reports/ers/export').set(as(A10))).status).toBe(413);
  });
  it('outcome cause lists stay in step with the campaign engine', () => {
    const src = readFileSync(new URL('../../services/campaignEngine.js', import.meta.url), 'utf8');
    const set = (name) => [...src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))[1].replace(/\/\/.*$/gm, '').matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
    expect(BUSY_CAUSE_LIST.slice().sort()).toEqual(set('BUSY_CAUSES').sort());
    // every retryable cause is classified, except a routing failure, which reports as "failed"
    const classified = new Set([...BUSY_CAUSE_LIST, ...NO_ANSWER_CAUSE_LIST, 'NO_ROUTE_DESTINATION']);
    expect(set('RETRYABLE_CAUSES').filter(c => !classified.has(c))).toEqual([]);
  });
});

describe('summary is computed over the whole filtered set', () => {
  it('/ers and /ens-campaigns return a server summary from the count query (not the page)', async () => {
    const ers = await request(app).get('/reports/ers?page=3&limit=10').set(as(A10));
    expect(ers.body.summary).toEqual({ total: 0, active: 0, completed: 0, responders: 0, responders_answered: 0 });
    const countSql = calls.find(c => /AS responders/.test(c.s));
    expect(countSql.s).not.toMatch(/LIMIT|OFFSET/);
    const ens = await request(app).get('/reports/ens-campaigns').set(as(A10));
    expect(ens.body.summary).toEqual({ total: 0, running: 0, completed: 0, destinations: 0, destinations_answered: 0 });
  });
});

describe('malformed input is a 400 (never a 500, never "no filter")', () => {
  it.each([
    ['from=yesterday'], ['to=2026-02-30'], ['from=2026-13-01'], ['org_id=abc'], ['org_id=0'], ['org_id=-1'],
    ['status=a%3Bdrop'], ['from=2026-10-10&to=2026-10-01'],
  ])('/reports/ers?%s → 400', async (qs) => {
    const r = await request(app).get(`/reports/ers?${qs}`).set(as(A10));
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);                                    // rejected before any SQL
  });
  it('invalid detail ids → 400 before any SQL', async () => {
    for (const p of ['/reports/ers/not-a-uuid', '/reports/ens/123', '/reports/ens-campaigns/abc', '/reports/ens-campaigns/1.5']) {
      calls = [];
      const r = await request(app).get(p).set(as(A10));
      expect(r.status, p).toBe(400);
      expect(calls, p).toHaveLength(0);
    }
  });
  it('valid detail ids are accepted (ens_campaigns.id is a UUID) → 404 from the empty emulator, not 400', async () => {
    const u = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
    for (const p of [`/reports/ens-campaigns/${u}`, `/reports/ers/${u}`, `/reports/ens/${u}`]) {
      const r = await request(app).get(p).set(as(A10));
      expect(r.status, p).toBe(404);
    }
  });
  it('room-match window closes: ended_at, else cancelled_at, "now" only while ACTIVE, else start + 2 min', () => {
    const started_at = '2026-10-01T10:00:00Z';
    expect(roomWindowEnd({ started_at, ended_at: '2026-10-01T10:30:00Z', status: 'COMPLETED' })).toBe('2026-10-01T10:30:00Z');
    expect(roomWindowEnd({ started_at, ended_at: null, cancelled_at: '2026-10-01T10:05:00Z', status: 'CANCELLED' })).toBe('2026-10-01T10:05:00Z');
    expect(roomWindowEnd({ started_at, ended_at: null, status: 'FAILED' }).toISOString()).toBe('2026-10-01T10:02:00.000Z');
    expect(Math.abs(roomWindowEnd({ started_at, ended_at: null, status: 'ACTIVE' }) - Date.now())).toBeLessThan(5000);
  });
  it('malformed paging falls back to defaults (was NaN → SQL error)', async () => {
    const r = await request(app).get('/reports/ers?page=abc&limit=-3').set(as(A10));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, limit: 50 });
    expect(parseReportQuery({ page: '2', limit: '1000' })).toMatchObject({ page: 2, limit: 200, offset: 200 });
  });
  it('valid filters pass through unchanged', () => {
    expect(parseReportQuery({ from: '2026-10-01', to: '2026-10-31', status: 'COMPLETED', org_id: '4' }))
      .toMatchObject({ from: '2026-10-01', to: '2026-10-31', status: 'COMPLETED', org_id: 4 });
  });
});
