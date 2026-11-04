/**
 * /api/v1/reports — validation, role gate and tenant scoping (Phase 3,
 * docs/MEDIA_REPORTING_MISSION.md). REAL router, auth, rbac and tenantScope with REAL
 * JWTs; the database is an emulator that records every query. Tenant filters are
 * honoured only when the SQL text itself carries the clause. The SQL semantics
 * (fan-out, recording choice, playback scope) are verified against real PostgreSQL
 * in the isolated e2e run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    const given = globalThis.__rowsFor?.(s);   // a test can supply detail rows for one query
    if (given) return { rows: given };
    if (/FROM audit_logs a/.test(s)) {
      const scoped = /ec\.tenant_id = \$3/.test(s);
      return { rows: AUDIT.filter(a => !scoped || p[2] == null || a.cfgTenant === p[2]).map(({ details, created_at }) => ({ details, created_at })) };
    }
    if (/INSERT INTO audit_logs/.test(s)) return { rows: [] };
    if (/COUNT\(DISTINCT c\.id\)::INT AS campaigns/.test(s)) return { rows: [globalThis.__exportSize] };
    if (/COUNT\(\*\)::INT AS incidents/.test(s)) return { rows: [{ incidents: globalThis.__exportSize.campaigns, details: globalThis.__exportSize.recipients }] };
    if (/COUNT\(\*\)::INT AS total/.test(s)) return { rows: [{ total: 0, active: 0, completed: 0, responders: 0, answered: 0, running: 0, destinations: 0 }] };
    return { rows: [] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const { config } = await import('../../config/index.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');
const reportsRouter = (await import('../../routes/v1/reports.js')).default;
const { parseReportQuery, roomWindowEnd, BUSY_CAUSE_LIST, NO_ANSWER_CAUSE_LIST, exportTimeZone, inZone } = await import('../../routes/v1/reports.js');

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
    for (const p of ['/reports/ens-campaigns/export?tenant_id=20', `/reports/ens-campaigns/${U}/export?tenant_id=20`, '/reports/ers/export?tenant_id=20',
      `/reports/ers/${U}/export?tenant_id=20`]) {
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
  it('another tenant\'s (or an unknown) campaign or incident is a 404', async () => {
    globalThis.__exportSize = { campaigns: 0, recipients: 0 };
    expect((await request(app).get(`/reports/ens-campaigns/${U}/export`).set(as(A10))).status).toBe(404);
    expect((await request(app).get(`/reports/ers/${U}/export`).set(as(A10))).status).toBe(404);
    expect((await request(app).get('/reports/ers/not-a-uuid/export').set(as(A10))).status).toBe(400);
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

describe('single campaign / single incident report (page 1: details, totals, pie chart)', () => {
  const U = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
  const binary = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  // Store-only ZIP → { partName: text }
  const parts = (buf) => {
    const eocd = buf.length - 22, out = {};
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
      const size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      out[buf.subarray(p + 46, p + 46 + nlen).toString('utf8')] = buf.subarray(start, start + size).toString('utf8');
      p += 46 + nlen;
    }
    return out;
  };
  const CAMPAIGN = {
    id: U, status: 'completed', triggered_via: 'UI', trigger_number: null, created_at: '2026-11-04T10:00:00Z',
    started_at: '2026-11-04T10:00:02Z', completed_at: '2026-11-04T10:03:00Z', campaign_duration_sec: 178,
    ens_name: 'Fire drill', org_name: 'Org A', triggered_by_name: 'Admin A', recording_file: null,
    message_audio_url: '/opt/sounds/enrs/fire.wav', message_text: null, message_duration_sec: '12.50',
    recipients: 4, answered: 2, busy: 1, no_answer: 1, failed: 0, expired: 0, skipped: 0, pending: 0, attempts: 7, retries: 3, avg_answer_sec: 6,
  };
  const INCIDENT = {
    incident_uuid: U, status: 'COMPLETED', group_type: 'primary', caller_number: '7001004', caller_name: 'Sunday Monday',
    conference_room: '3010', started_at: '2026-11-04T10:06:47Z', ended_at: '2026-11-04T10:06:50Z', cancelled_at: null,
    ers_name: 'Test_ERS', org_name: 'Default Organization', emergency_call_number: '911', queued_at: null, dequeued_at: null,
    queue_sec: null, duration_sec: 3, recording_file: 'ers_3010.wav', invited: 3, joined: 2, not_joined: 1, observers: 0, participants: 3,
  };
  beforeEach(() => {
    globalThis.__exportSize = { campaigns: 1, recipients: 2 };
    globalThis.__rowsFor = (s) => {
      if (/FROM ens_campaigns c .*ORDER BY c\.created_at DESC$/.test(s.trim()) && /md\.duration_sec/.test(s)) return [CAMPAIGN];
      if (/FROM ens_campaign_destinations d/.test(s)) return globalThis.__recipients ?? [
        { campaign_id: U, ens_name: 'Fire drill', contact_name: 'Ann', phone_number: '+966 50 000 0001', outcome: 'answered', hangup_cause: 'NORMAL_CLEARING',
          answered_at: '2026-11-04T10:00:10Z', completed_at: '2026-11-04T10:00:40Z', call_duration_sec: 30 },
        { campaign_id: U, contact_name: 'Bo', phone_number: '0500000002', outcome: 'answered', hangup_cause: 'NORMAL_CLEARING' },
        { campaign_id: U, contact_name: 'Cy', phone_number: '0500000003', outcome: 'busy', hangup_cause: 'USER_BUSY' },
        { campaign_id: U, contact_name: 'Di', phone_number: '0500000004', outcome: 'no_answer', hangup_cause: 'NO_ANSWER' },
        { campaign_id: U, contact_name: 'Ed', phone_number: '0500000005', outcome: 'no_answer', hangup_cause: 'CALL_REJECTED' },
        { campaign_id: U, contact_name: 'Fi', phone_number: '0500000006', outcome: 'no_answer', hangup_cause: 'SUBSCRIBER_ABSENT' }];
      if (/SELECT i\.incident_uuid, i\.status/.test(s)) return [INCIDENT];
      return null;
    };
  });
  afterEach(() => { delete globalThis.__rowsFor; });

  it('ERS incident: details, answered / not answered pie, times in the viewer zone, audited as that incident', async () => {
    const r = await binary(request(app).get(`/reports/ers/${U}/export?tz=Asia/Riyadh`).set(as(OP10)));
    expect(r.status).toBe(200);
    const p = parts(r.body);
    const summary = p['xl/worksheets/sheet1.xml'];
    for (const t of ['Emergency Response — Incident Report', 'Test_ERS', 'Sunday Monday', '7001004', 'Emergency number dialled',
      'Invoked (Asia/Riyadh)', 'Answered (joined)', 'Not answered']) expect(summary, t).toContain(t);
    expect(summary).toContain('<drawing r:id="rId1"/>');
    const chart = p['xl/charts/chart1.xml'];
    expect(chart).toContain('<c:pieChart>');
    expect(chart).toMatch(/<c:v>Answered<\/c:v>.*<c:v>Not answered<\/c:v>/);
    expect(chart).toMatch(/<c:pt idx="0"><c:v>2<\/c:v><\/c:pt><c:pt idx="1"><c:v>1<\/c:v>/);
    expect(p['[Content_Types].xml']).toContain('/xl/charts/chart1.xml');
    expect(p['xl/worksheets/sheet3.xml']).toContain('Rang (Asia/Riyadh)');
    const audit = calls.find(c => /report_exported/.test(c.s));
    expect(audit.p[1]).toBe(`ers-incident:${U}`);
    expect(JSON.parse(audit.p[2]).filters.tz).toBe('Asia/Riyadh');
  });
  it('ENS campaign: ENS name, invoked time, message duration, outcome pie, per-recipient call duration', async () => {
    const r = await binary(request(app).get(`/reports/ens-campaigns/${U}/export?tz=Asia/Riyadh`).set(as(OP10)));
    expect(r.status).toBe(200);
    const p = parts(r.body);
    const summary = p['xl/worksheets/sheet1.xml'];
    for (const t of ['Emergency Notification — Campaign Report', 'Fire drill', 'Invoked (Asia/Riyadh)', 'Message duration', 'fire.wav', 'Audio file'])
      expect(summary, t).toContain(t);
    expect(summary).toContain('ENS configuration ID');
    const chart = p['xl/charts/chart1.xml'];
    expect(chart).toMatch(/<c:v>Answered<\/c:v>.*<c:v>Busy<\/c:v>.*<c:v>No answer<\/c:v>.*<c:v>Declined<\/c:v>.*<c:v>Unreachable<\/c:v>/);
    // 2 answered, 1 busy, 1 ordinary no answer, 1 declined, 1 unreachable — declined/unreachable not in "No answer"
    expect(chart).toMatch(/<c:numCache><c:formatCode>General<\/c:formatCode><c:ptCount val="5"\/><c:pt idx="0"><c:v>2<\/c:v><\/c:pt><c:pt idx="1"><c:v>1<\/c:v><\/c:pt><c:pt idx="2"><c:v>1<\/c:v><\/c:pt><c:pt idx="3"><c:v>1<\/c:v><\/c:pt><c:pt idx="4"><c:v>1<\/c:v>/);
    expect(chart).not.toContain('<c:v>Failed</c:v>');   // empty slices are left out
    const recips = p['xl/worksheets/sheet3.xml'];
    for (const t of ['Call duration', 'Detailed outcome', '>declined<', '>unreachable<', '+966 50 000 0001']) expect(recips, t).toContain(t);
  });
  it('ENS running campaign, everyone pending: answer rate N/A (not 0%), pending kept, no other slices', async () => {
    globalThis.__recipients = [
      { campaign_id: U, contact_name: 'P1', phone_number: '1', outcome: 'pending' },
      { campaign_id: U, contact_name: 'P2', phone_number: '2', outcome: 'pending' }];
    try {
      const p = parts((await binary(request(app).get(`/reports/ens-campaigns/${U}/export`).set(as(OP10)))).body);
      expect(p['xl/worksheets/sheet1.xml']).toContain('N/A (no completed outcomes yet)');
      expect(p['xl/charts/chart1.xml']).toMatch(/<c:strCache><c:ptCount val="1"\/><c:pt idx="0"><c:v>Still pending<\/c:v>/);
    } finally { delete globalThis.__recipients; }
  });
  it('the list export keeps the shared outcome: no Declined / Unreachable split, no Detailed outcome column', async () => {
    const p = parts((await binary(request(app).get('/reports/ens-campaigns/export').set(as(OP10)))).body);
    expect(Object.values(p).join('')).not.toMatch(/Declined|Unreachable|Detailed outcome/);
  });
  it('ERS: configuration ID, recording length and size, cancelled duration, zero responders without a chart', async () => {
    let p = parts((await binary(request(app).get(`/reports/ers/${U}/export`).set(as(OP10)))).body);
    for (const t of ['ERS configuration ID', 'Recording length', 'Recording size']) expect(p['xl/worksheets/sheet1.xml'], t).toContain(t);
    const base = INCIDENT;
    try {
      globalThis.__rowsFor = (s) => (/SELECT i\.incident_uuid, i\.status/.test(s)
        ? [{ ...base, status: 'CANCELLED', ended_at: null, cancelled_at: '2026-11-04T10:07:27Z', duration_sec: null, cancelled_after_sec: 40,
             invited: 0, joined: 0, not_joined: 0, observers: 0, participants: 0 }] : null);
      p = parts((await binary(request(app).get(`/reports/ers/${U}/export`).set(as(OP10)))).body);
      const s = p['xl/worksheets/sheet1.xml'];
      expect(s).toContain('Duration (until cancelled)');
      expect(s).toContain('<v>0.000462962962962963</v>');     // 40 s as an Excel duration
      expect(s).toContain('No responders were invited for this incident');
      expect(Object.keys(p).some((n) => /charts|drawings/.test(n))).toBe(false);
    } finally { delete globalThis.__rowsFor; }
  });
  it('the initiator name falls back to the incident caller name only in the single-incident report', async () => {
    calls = [];
    await binary(request(app).get(`/reports/ers/${U}/export`).set(as(OP10)));
    const q = calls.find((c) => /SELECT i.incident_uuid, p.raw_number/.test(c.s));
    expect(q.s).toContain("WHEN $6::uuid IS NOT NULL AND p.role = 'initiator' THEN i.caller_name");
    expect(q.p[5]).toBe(U);
    calls = [];
    await binary(request(app).get('/reports/ers/export').set(as(OP10)));
    expect(calls.find((c) => /SELECT i.incident_uuid, p.raw_number/.test(c.s)).p[5]).toBeNull();
  });
  it('list exports are unchanged: no chart, no extra column, UTC labels', async () => {
    for (const path of ['/reports/ens-campaigns/export', '/reports/ers/export']) {
      const p = parts((await binary(request(app).get(path).set(as(OP10)))).body);
      expect(Object.keys(p).some(n => /charts|drawings/.test(n)), path).toBe(false);
      expect(p['xl/worksheets/sheet1.xml'], path).toContain('Generated (UTC)');
      expect(Object.values(p).join(''), path).not.toContain('Call duration');
    }
  });
  it('time zone: an unknown or malformed zone falls back to UTC; conversion keeps the wall clock', () => {
    expect(exportTimeZone({ tz: 'Asia/Riyadh' })).toBe('Asia/Riyadh');
    for (const tz of [undefined, '', 'Not/AZone', 'x'.repeat(80), ['Asia/Riyadh']]) expect(exportTimeZone({ tz })).toBeNull();
    expect(inZone('2026-11-04T10:06:47Z', 'Asia/Riyadh').toISOString()).toBe('2026-11-04T13:06:47.000Z');
    expect(inZone('2026-07-01T12:00:00Z', 'America/New_York').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(inZone(null, 'Asia/Riyadh')).toBeNull();
    expect(inZone('2026-11-04T10:00:00Z', null)).toBe('2026-11-04T10:00:00Z');
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
