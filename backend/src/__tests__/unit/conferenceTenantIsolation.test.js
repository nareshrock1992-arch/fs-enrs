/**
 * Live conference control: tenant isolation and ESL input safety.
 *
 * REAL router, auth, rbac, tenantScope, conferenceAccess and controller with REAL JWTs.
 * ESL is mocked (no call is ever placed); the database is an emulator that resolves
 * room ownership from fake incidents only if the SQL filters by room.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const INCIDENTS = [
  { conference_room: 'ers_1_p', tenant_id: 10 },
  { conference_room: 'ers_2_p', tenant_id: 20 },
];
const SNAPSHOT = [
  { name: 'ers_1_p', members: [{ callerNum: '1001' }] },
  { name: 'ers_2_p', members: [{ callerNum: '2002' }] },
  { name: 'unowned_room', members: [{ callerNum: '3003' }] },
];
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, p = []) => {
    if (/DISTINCT ON \(i\.conference_room\)/.test(sql)) {
      if (globalThis.__ownerLookupFails) throw new Error('db down');
      return { rows: INCIDENTS.filter(i => p[0].includes(i.conference_room)) };
    }
    return { rows: [] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const REC = vi.hoisted(() => `/tmp/cti-rec-${process.pid}`);
const esl = vi.hoisted(() => {
  const names = ['confLock', 'confUnlock', 'confRecord', 'confRecordStop', 'confRecordStopAll', 'confPlay', 'confSay', 'confInvite',
    'confTerminate', 'confMute', 'confUnmute', 'confKick', 'confDeaf', 'confUndeaf', 'confVolumeIn', 'confVolumeOut',
    'confEnergy', 'confFloor', 'confTransfer', 'confModerator'];
  return Object.fromEntries(names.map(n => [n, vi.fn(async () => '+OK')]));
});
vi.mock('../../services/eslService.js', () => ({
  ...esl,
  confList: vi.fn(async () => []),
  getConferenceSnapshot: () => SNAPSHOT,
  seedConferenceRegistry: vi.fn(async () => []),
  setConferenceRecordingStarting: vi.fn(), setConferenceRecordingActive: vi.fn(),
  setConferenceRecordingStopping: vi.fn(), setConferenceRecordingPath: vi.fn(), setConferenceRecordingError: vi.fn(),
  eslStatus: () => ({ connected: true }), syncConferenceFromXml: vi.fn(async () => {}),
  setSocketIO: vi.fn(),
}));
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getRecordingDirForType: () => REC, getIvrRecordingDir: () => REC, getEnrsSoundDir: () => REC, getSoundDir: () => REC, getRecordingDir: () => REC },
}));

const { config } = await import('../../config/index.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');
const router = (await import('../../routes/v1/monitoring.js')).default;
const ersRouter = (await import('../../routes/v1/ers.js')).default;
const { query } = await import('../../db/pool.js');

const app = express();
app.use(express.json());
app.use('/monitoring', router);
app.use(errorHandler);
const tok = (c) => jwt.sign(c, config.jwt.accessSecret, { expiresIn: '15m' });
const as = (t) => ({ Authorization: `Bearer ${t}` });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const SUP10 = tok({ id: 8, role: 'SUPERVISOR', tenantId: 10 });
const VIEW10 = tok({ id: 9, role: 'VIEWER', tenantId: 10 });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });
const ORPHAN = tok({ id: 7, role: 'ADMIN', tenantId: null });
const eslCalled = () => Object.values(esl).filter(f => f.mock.calls.length > 0).length;

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__ownerLookupFails = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const CONTROLS = [
  ['post', 'lock', {}], ['post', 'unlock', {}], ['post', 'record/start', {}], ['post', 'record/stop', { path: '/x.wav' }],
  ['post', 'play', { audio_path: '/x.wav' }], ['post', 'say', { text: 'hi' }], ['post', 'invite', { dial_string: 'user/1001' }],
  ['delete', '', {}], ['post', 'members/5/mute', {}], ['post', 'members/5/unmute', {}], ['delete', 'members/5', {}],
  ['post', 'members/5/deaf', {}], ['post', 'members/5/undeaf', {}], ['post', 'members/5/volume', { direction: 'in', level: 1 }],
  ['post', 'members/5/energy', { level: 100 }], ['post', 'members/5/floor', {}],
  ['post', 'members/5/transfer', { extension: '1000' }], ['post', 'members/5/moderator', {}],
];

describe('a tenant can never control or see another tenant\'s conference', () => {
  it.each(CONTROLS)('%s %s on another tenant\'s room → 404, no ESL command', async (m, p, body) => {
    const r = await request(app)[m](`/monitoring/conferences/ers_2_p/${p}`).set(as(A10)).send(body);
    expect(r.status).toBe(404);
    expect(eslCalled()).toBe(0);
  });
  it.each(CONTROLS)('%s %s on a room with no known owner → 404 for a tenant user', async (m, p, body) => {
    const r = await request(app)[m](`/monitoring/conferences/unowned_room/${p}`).set(as(A10)).send(body);
    expect(r.status).toBe(404);
    expect(eslCalled()).toBe(0);
  });
  it('own tenant keeps working, and SUPERVISOR keeps its existing rights', async () => {
    expect((await request(app).post('/monitoring/conferences/ers_1_p/members/5/mute').set(as(SUP10))).status).toBe(200);
    expect(esl.confMute).toHaveBeenCalledWith('ers_1_p', '5');
    expect((await request(app).delete('/monitoring/conferences/ers_1_p').set(as(A10))).status).toBe(200);
    expect(esl.confTerminate).toHaveBeenCalledTimes(1);
  });
  it('VIEWER cannot control even its own tenant\'s room', async () => {
    expect((await request(app).delete('/monitoring/conferences/ers_1_p').set(as(VIEW10))).status).toBe(403);
    expect(eslCalled()).toBe(0);
  });
  it('SUPER_ADMIN controls any room, and does not depend on the database to do so', async () => {
    globalThis.__ownerLookupFails = true;
    expect((await request(app).post('/monitoring/conferences/unowned_room/lock').set(as(SA))).status).toBe(200);
  });
  it('a failed ownership lookup refuses tenant users (error, not "allowed")', async () => {
    globalThis.__ownerLookupFails = true;
    expect((await request(app).delete('/monitoring/conferences/ers_1_p').set(as(A10))).status).toBe(500);
    expect(eslCalled()).toBe(0);
  });
  it('the conference list shows a tenant only its own rooms and members', async () => {
    const r = await request(app).get('/monitoring/conferences').set(as(VIEW10));
    expect(r.body.conferences.map(c => c.name)).toEqual(['ers_1_p']);
    expect(JSON.stringify(r.body)).not.toMatch(/2002|3003/);
    expect((await request(app).get('/monitoring/conferences').set(as(SA))).body.conferences).toHaveLength(3);
    expect((await request(app).get('/monitoring/conferences').set(as(ORPHAN))).status).toBe(403);
  });
  it('the cross-tenant diagnostic is SUPER_ADMIN only', async () => {
    expect((await request(app).get('/monitoring/debug/conf-sync').set(as(A10))).status).toBe(403);
  });
});

describe('nothing unsafe reaches an ESL command', () => {
  const R = '/monitoring/conferences/ers_1_p';
  const INJECT = 'x\n\napi system id';
  it.each([
    ['say', { text: INJECT }], ['say', { text: 'a'.repeat(1001) }], ['say', {}],
    ['invite', { dial_string: INJECT }], ['invite', { dial_string: 'user/1 extra' }],
    ['play', { audio_path: INJECT }], ['play', { audio_path: 'a b.wav' }],
    ['members/5/transfer', { extension: INJECT }], ['members/5/transfer', { extension: '1', context: 'a b' }],
    ['members/5/transfer', { extension: '1', dialplan: INJECT }],
    ['members/5/volume', { direction: 'in', level: '1\n\nx' }], ['members/5/volume', { direction: 'sideways', level: 1 }],
    ['members/5/energy', { level: 'x' }],
    ['record/stop', { path: INJECT }],
  ])('%s %j → 400', async (p, body) => {
    expect((await request(app).post(`${R}/${p}`).set(as(A10)).send(body)).status).toBe(400);
    expect(eslCalled()).toBe(0);
  });
  it('a recording can only be written inside the recording directory', async () => {
    for (const path of ['/etc/cron.d/x', `${REC}/../../etc/x.wav`, `${REC}/x.sh`, INJECT]) {
      expect((await request(app).post(`${R}/record/start`).set(as(A10)).send({ path })).status, path).toBe(400);
    }
    expect(esl.confRecord).not.toHaveBeenCalled();
  });
  it('characterization: room names with other punctuation stay controllable (only spaces / control characters are refused)', async () => {
    for (const room of ['%2B966512345678', 'ers%3A1', 'room%23a']) {
      expect((await request(app).post(`/monitoring/conferences/${room}/lock`).set(as(SA))).status, room).toBe(200);
    }
  });
  it('malformed room and member ids are refused', async () => {
    expect((await request(app).post('/monitoring/conferences/a%20b/lock').set(as(SA))).status).toBe(404);
    expect((await request(app).post('/monitoring/conferences/a%0Ab/lock').set(as(SA))).status).toBe(404);
    expect((await request(app).post(`${R}/members/1%0A2/mute`).set(as(A10))).status).toBe(400);
    expect((await request(app).post(`${R}/members/all/mute`).set(as(A10))).status).toBe(400);
    expect(eslCalled()).toBe(0);
  });
  it('normal values still pass (spaces in spoken text are fine)', async () => {
    expect((await request(app).post(`${R}/say`).set(as(A10)).send({ text: 'Evacuate building two now.' })).status).toBe(200);
    expect((await request(app).post(`${R}/invite`).set(as(A10)).send({ dial_string: 'sofia/gateway/gw1/0501234567' })).status).toBe(200);
    expect((await request(app).post(`${R}/members/5/volume`).set(as(A10)).send({ direction: 'out', level: -2 })).status).toBe(200);
  });
});

describe('recording files: no overwrite, no symlink', () => {
  const R = '/monitoring/conferences/ers_1_p';
  beforeAll(() => { mkdirSync(REC, { recursive: true }); writeFileSync(`${REC}/existing.wav`, 'x'); symlinkSync('/etc/passwd', `${REC}/link.wav`); symlinkSync('/nonexistent/none', `${REC}/dangling.wav`); });
  afterAll(() => rmSync(REC, { recursive: true, force: true }));

  it.each(['existing.wav', 'link.wav', 'dangling.wav'])('%s already exists → 409, no ESL command', async (name) => {
    expect((await request(app).post(`${R}/record/start`).set(as(A10)).send({ path: `${REC}/${name}` })).status).toBe(409);
    expect(esl.confRecord).not.toHaveBeenCalled();
  });
  it('a new file in the directory, or no path at all, still works', async () => {
    expect((await request(app).post(`${R}/record/start`).set(as(A10)).send({ path: `${REC}/new.wav` })).status).toBe(200);
    expect((await request(app).post(`${R}/record/start`).set(as(A10)).send({})).status).toBe(200);
  });
});

describe('SUPER_ADMIN reaches every conference; safety checks still apply', () => {
  it('focused on one tenant, it can still control rooms of other tenants and rooms with no incident', async () => {
    for (const room of ['ers_2_p', 'unowned_room']) {
      expect((await request(app).post(`/monitoring/conferences/${room}/lock?tenant_id=10`).set(as(SA))).status, room).toBe(200);
    }
  });
  it('focused on one tenant, the list holds that tenant plus ownerless rooms', async () => {
    const r = await request(app).get('/monitoring/conferences?tenant_id=10').set(as(SA));
    expect(r.body.conferences.map(c => c.name).sort()).toEqual(['ers_1_p', 'unowned_room']);
  });
  it('input validation is not bypassed', async () => {
    expect((await request(app).post('/monitoring/conferences/unowned_room/say').set(as(SA)).send({ text: 'x\n\napi system id' })).status).toBe(400);
    expect(esl.confSay).not.toHaveBeenCalled();
  });
  it('a role claimed in the request is not an identity', async () => {
    const r = await request(app).delete('/monitoring/conferences/ers_2_p?role=SUPER_ADMIN&tenant_id=20').set(as(A10)).send({ role: 'SUPER_ADMIN', tenant_id: 20 });
    expect(r.status).toBe(404);
    expect(eslCalled()).toBe(0);
  });
});

describe('conference actions are audited', () => {
  const audits = () => query.mock.calls.filter(([s]) => /conference_control/.test(s));
  it('records who did what to which room, without spoken text or dial strings', async () => {
    await request(app).post('/monitoring/conferences/ers_1_p/say').set(as(A10)).send({ text: 'secret words' });
    await request(app).post('/monitoring/conferences/ers_2_p/lock').set(as(SA));
    expect(audits().map(([, p]) => [p[0], p[1]])).toEqual([[3, 'ers_1_p'], [1, 'ers_2_p']]);
    expect(JSON.parse(audits()[1][1][2])).toMatchObject({ role: 'SUPER_ADMIN', method: 'POST', command: '/lock' });
    expect(JSON.stringify(audits())).not.toContain('secret words');
  });
  it('a refused cross-tenant attempt reaches no audit-writing path and no ESL command', async () => {
    await request(app).delete('/monitoring/conferences/ers_2_p').set(as(A10));
    expect(audits()).toHaveLength(0);
    expect(eslCalled()).toBe(0);
  });
  it('an audit failure does not block an emergency action', async () => {
    query.mockImplementationOnce(async () => { throw new Error('audit down'); });
    expect((await request(app).post('/monitoring/conferences/ers_2_p/lock').set(as(SA))).status).toBe(200);
  });
});

describe('ERS conference routes use the same rules', () => {
  const ers = express();
  ers.use(express.json());
  ers.use('/ers', ersRouter);
  ers.use(errorHandler);
  it.each([['post', 'kick', { member_id: 5 }], ['post', 'mute', { member_id: 5, muted: true }], ['post', 'play', { audio_path: '/x.wav' }], ['get', 'members', undefined]])(
    '%s %s on another tenant\'s room → 404', async (m, p, body) => {
      expect((await request(ers)[m](`/ers/conference/ers_2_p/${p}`).set(as(A10)).send(body)).status).toBe(404);
      expect(eslCalled()).toBe(0);
    });
  it('own room works; SUPER_ADMIN reaches an ownerless room; unsafe values are refused', async () => {
    expect((await request(ers).post('/ers/conference/ers_1_p/kick').set(as(A10)).send({ member_id: 5 })).status).toBe(200);
    expect((await request(ers).post('/ers/conference/unowned_room/kick?tenant_id=10').set(as(SA)).send({ member_id: 5 })).status).toBe(200);
    expect((await request(ers).post('/ers/conference/ers_1_p/kick').set(as(A10)).send({ member_id: 'all' })).status).toBe(400);
    expect((await request(ers).post('/ers/conference/ers_1_p/mute').set(as(A10)).send({ member_id: '1 2', muted: true })).status).toBe(400);
    expect((await request(ers).post('/ers/conference/ers_1_p/play').set(as(A10)).send({ audio_path: 'a b' })).status).toBe(400);
  });
});
