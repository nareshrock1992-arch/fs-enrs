/**
 * The authorization boundary: SUPER_ADMIN reaches everything the product supports;
 * tenant roles never reach platform-wide actions. REAL routers, auth and rbac with REAL
 * JWTs. Handlers are stubbed where reaching them is the whole assertion, so "not 403"
 * means the request passed authorization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pool.js', () => ({ query: db.query, withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../services/eslService.js', () => ({ eslStatus: () => ({ connected: false }) }));

const handled = vi.hoisted(() => (req, res) => res.json({ reached: true }));
const stubAll = vi.hoisted(() => (names) => Object.fromEntries(names.map(n => [n, handled])));
vi.mock('../../controllers/ivrController.js', () => stubAll(['bindNumber','createFlow','deleteFlow','getFlowById','getVersion','listFlows','listVersions','publishFlow','unbindNumber','updateFlow','validateFlow']));
vi.mock('../../controllers/ivrTemplates.js', () => ({ BUILTIN_IVR_TEMPLATES: {}, listTemplates: handled, createFromTemplate: handled }));
vi.mock('../../controllers/gatewayController.js', () => stubAll(['createGateway','deleteGateway','deployGatewayRoute','listGateways','updateGateway']));
vi.mock('../../controllers/deploymentController.js', () => stubAll(['listCategories', 'listAudio', 'scanAudio', 'uploadAudio', 'audioUploadMiddleware', 'deployAudio',
  'streamAudio', 'deleteAudio', 'listFlowStatus', 'previewDeploy', 'triggerDeploy', 'deployHistory', 'triggerRedeployAll', 'getDiagnostics', 'triggerReloadXml',
  'getPaths', 'getEslStatus', 'disableLegacyExtensionRoute']));

const { config } = await import('../../config/index.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');

const app = express();
app.use(express.json());
app.use('/settings', (await import('../../routes/v1/settings.js')).default);
app.use('/gateways', (await import('../../routes/v1/gateways.js')).default);
app.use('/ivr', (await import('../../routes/v1/ivr.js')).default);
app.use('/deployment', (await import('../../routes/v1/deployment.js')).default);
app.use(errorHandler);

const tok = (c) => jwt.sign(c, config.jwt.accessSecret, { expiresIn: '15m' });
const as = (t) => ({ Authorization: `Bearer ${t}` });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const SUP10 = tok({ id: 8, role: 'SUPERVISOR', tenantId: 10 });
const OP10 = tok({ id: 4, role: 'OPERATOR', tenantId: 10 });
const U = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [{ key: 'k', value: 'v' }] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
const writes = () => db.query.mock.calls.filter(([s]) => /system_settings|UPDATE feature_flags/.test(s));
const audits = () => db.query.mock.calls.filter(([s]) => /INSERT INTO audit_logs/.test(s));

const GLOBAL = [
  ['put', '/settings/test_mode_enabled', { value: 'true' }],
  ['patch', '/settings/feature-flags/some_flag', { is_enabled: true }],
  ['post', '/deployment/redeploy-all', {}],
  ['post', '/deployment/diagnostics/reloadxml', {}],
  ['post', '/deployment/diagnostics/disable-legacy-extension', {}],
];

describe('platform-wide actions are SUPER_ADMIN only', () => {
  it.each(GLOBAL)('%s %s: tenant ADMIN 403, SUPER_ADMIN passes', async (m, p, body) => {
    expect((await request(app)[m](p).set(as(A10)).send(body)).status).toBe(403);
    expect(writes()).toHaveLength(0);
    expect((await request(app)[m](p).set(as(SA)).send(body)).status).toBe(200);
  });
  it('a claimed role or tenant in the request changes nothing', async () => {
    const r = await request(app).put('/settings/x?role=SUPER_ADMIN').set(as(A10)).send({ value: 1, role: 'SUPER_ADMIN', tenant_id: null });
    expect(r.status).toBe(403);
  });
  it('tenant ADMIN keeps read access to settings', async () => {
    expect((await request(app).get('/settings').set(as(A10))).status).toBe(200);
    expect((await request(app).get('/settings').set(as(OP10))).status).toBe(403);
  });
  it('global changes are audited by key, never with the value', async () => {
    await request(app).put('/settings/test_mode_caller_id').set(as(SA)).send({ value: 'SECRET-VALUE' });
    await request(app).patch('/settings/feature-flags/f1').set(as(SA)).send({ is_enabled: true });
    expect(audits().map(([, p]) => [p[0], p[1], p[2]])).toEqual([
      [1, 'global_setting_changed', 'test_mode_caller_id'], [1, 'feature_flag_changed', 'f1']]);
    expect(JSON.stringify(audits())).not.toContain('SECRET-VALUE');
  });
  it('validation applies to SUPER_ADMIN too', async () => {
    expect((await request(app).put('/settings/bad%20key').set(as(SA)).send({ value: 'x' })).status).toBe(400);
    expect((await request(app).put('/settings/ok').set(as(SA)).send({})).status).toBe(400);
  });
});

describe('SUPER_ADMIN is not blocked by ordinary role checks', () => {
  const ROUTES = [
    ['post', '/ivr'], ['put', `/ivr/${U}`], ['delete', `/ivr/${U}`], ['post', `/ivr/${U}/publish`], ['post', `/ivr/${U}/validate`],
    ['patch', `/ivr/${U}/bind`], ['patch', `/ivr/${U}/unbind`],
    ['post', '/gateways'], ['put', '/gateways/1'], ['delete', '/gateways/1'], ['post', '/gateways/1/deploy'],
  ];
  it.each(ROUTES)('%s %s reaches the handler', async (m, p) => {
    expect((await request(app)[m](p).set(as(SA)).send({})).status).toBe(200);
  });
  it.each(ROUTES)('%s %s: ADMIN and SUPERVISOR keep access, OPERATOR does not', async (m, p) => {
    expect((await request(app)[m](p).set(as(A10)).send({})).status).toBe(200);
    expect((await request(app)[m](p).set(as(SUP10)).send({})).status).toBe(200);
    expect((await request(app)[m](p).set(as(OP10)).send({})).status).toBe(403);
  });
});

describe('audit log', () => {
  const audit = express();
  beforeEach(() => db.query.mockResolvedValue({ rows: [{ total: 0 }] }));
  it('is SUPER_ADMIN only', async () => {
    audit.use('/audit', (await import('../../routes/v1/audit.js')).default);
    audit.use(errorHandler);
    for (const t of [A10, SUP10, OP10]) expect((await request(audit).get('/audit?audit_tenant_id=10').set(as(t))).status).toBe(403);
    expect((await request(audit).get('/audit')).status).toBe(401);
    expect((await request(audit).get('/audit').set(as(SA))).status).toBe(200);
  });
  it('malformed filters are a 400 before any SQL', async () => {
    db.query.mockClear();
    for (const q of ['action=a%3Bdrop', 'user_id=x', 'from=nope', 'audit_tenant_id=-1']) {
      expect((await request(audit).get(`/audit?${q}`).set(as(SA))).status, q).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});
