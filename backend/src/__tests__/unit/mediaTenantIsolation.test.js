/**
 * Media + recording file access across tenants (Phase 1, docs/MEDIA_REPORTING_MISSION.md).
 *
 * REAL routers, controllers, auth, rbac, signed-link and /uploads middleware with
 * REAL signed JWTs and REAL files on disk (temp dir). Only the database is an
 * in-memory emulator that returns a row only if the SQL's own tenant parameter
 * matches — so a missing tenant check in the code would make these tests fail.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';

const UP = path.join(os.tmpdir(), `mti-uploads-${process.pid}`);
vi.mock('../../config/index.js', async () => {
  const a = await vi.importActual('../../config/index.js');
  const p = await import('path'); const o = await import('os');
  return { config: { ...a.config, uploads: { dir: p.join(o.tmpdir(), `mti-uploads-${process.pid}`), maxSizeMb: 50 } } };
});
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getEnrsSoundDir: () => '/nonexistent/sounds/enrs', getIvrRecordingDir: () => '/nonexistent/rec/ivr',
                   getSoundDir: () => '/nonexistent/sounds', getRecordingDir: () => '/nonexistent/rec', getRecordingDirForType: () => '/nonexistent/rec' },
}));
vi.mock('../../services/deploymentEngine.js', () => ({ deployFlow: vi.fn(), redeployAll: vi.fn(), getDeploymentHistory: vi.fn(), previewDeployment: vi.fn() }));
vi.mock('../../services/diagnosticsService.js', () => ({ runDiagnostics: vi.fn(), pingEsl: vi.fn(), reloadXml: vi.fn(), disableLegacyExtension: vi.fn() }));

let MEDIA, RECS;
const deleteCalls = [];
vi.mock('../../services/mediaDependencyService.js', async () => {
  const actual = await vi.importActual('../../services/mediaDependencyService.js');
  return {
    ...actual,
    // Emulates the real service's tenant rule: a row outside the caller's scope is "not_found".
    deleteMediaSafely: vi.fn(async ({ id, tenantId }) => {
      deleteCalls.push({ id, tenantId });
      const row = MEDIA.find(m => m.id === Number(id) && !m.deleted_at);
      if (!row || (tenantId != null && row.tenant_id !== tenantId)) return { status: 'not_found' };
      row.deleted_at = new Date();
      return { status: 'deleted', record: row };
    }),
  };
});
// The tenant filter is applied ONLY if the SQL text itself contains the tenant clause, so
// deleting a clause from the code (while still passing the value) fails these tests.
const TENANT2 = /tenant_id = \$2/;
const inScope = (row, tenantParam) => row && !row.deleted_at && (tenantParam == null || row.tenant_id === tenantParam);
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/right\(path_or_uri/.test(s)) {
      return { rows: MEDIA.filter(m => !m.deleted_at && m.path_or_uri.endsWith(p[1]) && (!/tenant_id = \$3/.test(s) || p[2] == null || m.tenant_id === p[2] || m.tenant_id == null))
        .map(m => ({ path_or_uri: m.path_or_uri })) };
    }
    if (/^UPDATE media_files SET name/.test(s.trim())) {
      const row = MEDIA.find(m => m.id === Number(p[0]));
      if (!inScope(row, TENANT2.test(s) ? p[1] : null)) return { rows: [] };
      if (p[2]) row.name = p[2];
      return { rows: [row] };
    }
    if (/^UPDATE media_files/.test(s.trim())) return { rows: [], rowCount: 1 };
    if (/FROM media_files/.test(s) && /\bid = \$1/.test(s)) return { rows: MEDIA.filter(m => m.id === Number(p[0]) && inScope(m, TENANT2.test(s) ? p[1] : null)) };
    if (/FROM recordings/.test(s) && /\bid = \$1/.test(s)) return { rows: RECS.filter(r => r.id === Number(p[0]) && inScope(r, TENANT2.test(s) ? p[1] : null)) };
    return { rows: [] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const { config } = await import('../../config/index.js');
const { requireAuthOrToken } = await import('../../middleware/auth.js');
const { canViewMedia } = await import('../../middleware/rbac.js');
const { serveUpload } = await import('../../middleware/uploadsAccess.js');
const { signMediaAccess } = await import('../../middleware/mediaAccess.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');
const { setSocketIO, emitMediaEvent } = await import('../../controllers/mediaLibraryController.js');
const mediaRouter = (await import('../../routes/v1/mediaLibrary.js')).default;
const recRouter = (await import('../../routes/v1/recordings.js')).default;

const app = express();
app.use(express.json());
app.use('/media-library', mediaRouter);
app.use('/recordings', recRouter);
app.use('/uploads', requireAuthOrToken, canViewMedia, serveUpload);   // exactly as server.js mounts it
app.use(errorHandler);

const tok = (c) => jwt.sign(c, config.jwt.accessSecret, { expiresIn: '15m' });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const OP10 = tok({ id: 4, role: 'OPERATOR', tenantId: 10 });
const SUP10 = tok({ id: 8, role: 'SUPERVISOR', tenantId: 10 });
const VIEW10 = tok({ id: 9, role: 'VIEWER', tenantId: 10 });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });
const ORPHAN = tok({ id: 7, role: 'ADMIN', tenantId: null });
const as = (t) => ({ Authorization: `Bearer ${t}` });
const F = (n) => path.join(UP, n);

beforeAll(() => {
  mkdirSync(UP, { recursive: true });
  for (const n of ['111_t10.wav', '221_t20.wav', '331_shared.wav', '441_gone.wav', 'rec10.wav', 'rec20.wav', '.env']) writeFileSync(F(n), `bytes-of-${n}`);
  writeFileSync(path.join(UP, '..', `mti-secret-${process.pid}.txt`), 'top secret');
});
afterAll(() => {
  rmSync(UP, { recursive: true, force: true });
  rmSync(path.join(UP, '..', `mti-secret-${process.pid}.txt`), { force: true });
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  deleteCalls.length = 0;
  MEDIA = [
    { id: 11, tenant_id: 10,   name: 'Tenant 10 prompt', path_or_uri: F('111_t10.wav'), fs_path: null, waveform_peaks: [0.1, 0.5], duration_sec: 1, is_deployed: false, uploaded_by_email: 'a@t10' },
    { id: 21, tenant_id: 20,   name: 'Tenant 20 prompt', path_or_uri: F('221_t20.wav'), fs_path: null, waveform_peaks: [0.2, 0.4], duration_sec: 1, is_deployed: false },
    { id: 31, tenant_id: null, name: 'Shared prompt',    path_or_uri: F('331_shared.wav'), fs_path: null, waveform_peaks: [0.3], duration_sec: 1, is_deployed: true },
    { id: 41, tenant_id: 10,   name: 'Deleted prompt',   path_or_uri: F('441_gone.wav'), fs_path: null, deleted_at: new Date() },
  ].map(m => ({ deleted_at: null, ...m }));
  RECS = [
    { id: 51, tenant_id: 10, recording_path: F('rec10.wav'), recording_file: 'rec10.wav', deleted_at: null, waveform_peaks: [0.1] },
    { id: 52, tenant_id: 20, recording_path: F('rec20.wav'), recording_file: 'rec20.wav', deleted_at: null, waveform_peaks: [0.1] },
  ];
});

describe('media library — tenant A can never touch tenant B media (all 404, nothing changed)', () => {
  it('read, edit, deploy, delete, sign, stream, download, waveform', async () => {
    const codes = {
      detail:   (await request(app).get('/media-library/21').set(as(A10))).status,
      edit:     (await request(app).put('/media-library/21').set(as(A10)).send({ name: 'pwned' })).status,
      deploy:   (await request(app).post('/media-library/21/deploy').set(as(A10))).status,
      delete:   (await request(app).delete('/media-library/21').set(as(A10))).status,
      access:   (await request(app).get('/media-library/21/access').set(as(A10))).status,
      stream:   (await request(app).get('/media-library/21/stream').set(as(A10))).status,
      download: (await request(app).get('/media-library/21/download').set(as(A10))).status,
      waveform: (await request(app).get('/media-library/21/waveform').set(as(A10))).status,
    };
    expect(codes).toEqual({ detail: 404, edit: 404, deploy: 404, delete: 404, access: 404, stream: 404, download: 404, waveform: 404 });
    expect(MEDIA.find(m => m.id === 21)).toMatchObject({ name: 'Tenant 20 prompt', deleted_at: null });
    expect(deleteCalls).toEqual([{ id: '21', tenantId: 10 }]);           // tenant comes from the token
  });
  it('a forged ?tenant_id cannot widen a tenant user\'s scope', async () => {
    expect((await request(app).get('/media-library/21?tenant_id=20').set(as(A10))).status).toBe(404);
    await request(app).delete('/media-library/21?tenant_id=20').set(as(A10));
    expect(deleteCalls.at(-1).tenantId).toBe(10);
  });
  it('legitimate same-tenant access works (detail, edit, sign + stream, download, waveform, delete)', async () => {
    expect((await request(app).get('/media-library/11').set(as(A10))).status).toBe(200);
    expect((await request(app).put('/media-library/11').set(as(A10)).send({ name: 'Renamed' })).status).toBe(200);
    const acc = await request(app).get('/media-library/11/access?purpose=stream').set(as(OP10));
    expect(acc.status).toBe(200);
    const st = await request(app).get(`/media-library/11/stream?sig=${acc.body.sig}`);
    expect(st.status).toBe(200);
    expect(st.text || st.body.toString()).toContain('bytes-of-111_t10.wav');
    expect((await request(app).get('/media-library/11/download').set(as(A10))).status).toBe(200);
    expect((await request(app).get('/media-library/11/waveform').set(as(SUP10))).status).toBe(200);
    expect((await request(app).delete('/media-library/11').set(as(A10))).status).toBe(204);
  });
  it('VIEWER (no media.view) cannot fetch audio by any credential, incl. a signed link carrying its role', async () => {
    expect((await request(app).get('/media-library/11/access').set(as(VIEW10))).status).toBe(403);
    expect((await request(app).get('/media-library/11/stream').set(as(VIEW10))).status).toBe(403);
    expect((await request(app).get('/media-library/11/download').set(as(VIEW10))).status).toBe(403);
    expect((await request(app).get('/media-library/11/waveform').set(as(VIEW10))).status).toBe(403);
    const sig = signMediaAccess({ user: { id: 9, role: 'VIEWER', tenantId: 10 }, resource: 'media', id: '11', purpose: 'stream' });
    expect((await request(app).get(`/media-library/11/stream?sig=${sig}`)).status).toBe(403);
  });
  it('tenant-less identity: 403 everywhere (never all-tenant access)', async () => {
    for (const [m, p] of [['get', '/media-library/21'], ['get', '/media-library/21/stream'], ['get', '/media-library'], ['get', `/media-library/21/stream?token=${ORPHAN}`]]) {
      const r = p.includes('token=') ? await request(app)[m](p) : await request(app)[m](p).set(as(ORPHAN));
      expect(r.status).toBe(403);
    }
  });
  it('SUPER_ADMIN: explicit cross-tenant access works; a malformed ?tenant_id is 400', async () => {
    expect((await request(app).get('/media-library/21').set(as(SA))).status).toBe(200);
    expect((await request(app).get('/media-library/21?tenant_id=20').set(as(SA))).status).toBe(200);
    expect((await request(app).get('/media-library/21?tenant_id=10').set(as(SA))).status).toBe(404);
    expect((await request(app).get('/media-library/21?tenant_id=abc').set(as(SA))).status).toBe(400);
  });
});

describe('recordings — byte access follows recordings.view and the tenant', () => {
  it('SUPERVISOR and VIEWER cannot stream/download/waveform; OPERATOR/ADMIN can in their tenant only', async () => {
    for (const t of [SUP10, VIEW10]) {
      expect((await request(app).get('/recordings/51/stream').set(as(t))).status).toBe(403);
      expect((await request(app).get('/recordings/51/download').set(as(t))).status).toBe(403);
      expect((await request(app).get('/recordings/51/waveform').set(as(t))).status).toBe(403);
    }
    expect((await request(app).get('/recordings/51/stream').set(as(OP10))).status).toBe(200);
    expect((await request(app).get('/recordings/52/stream').set(as(OP10))).status).toBe(404);
    expect((await request(app).get('/recordings/52/download').set(as(A10))).status).toBe(404);
    expect((await request(app).get('/recordings/52/access').set(as(A10))).status).toBe(404);
  });
});

describe('/uploads — authenticated, role- and tenant-checked (was public express.static)', () => {
  it('no credentials → 401; VIEWER → 403; tenant-less → 403', async () => {
    expect((await request(app).get('/uploads/111_t10.wav')).status).toBe(401);
    expect((await request(app).get('/uploads/111_t10.wav').set(as(VIEW10))).status).toBe(403);
    expect((await request(app).get('/uploads/111_t10.wav').set(as(ORPHAN))).status).toBe(403);
  });
  it('own tenant file and shared (tenant-less) files are served; legacy ?token= still works', async () => {
    const own = await request(app).get('/uploads/111_t10.wav').set(as(OP10));
    expect(own.status).toBe(200);
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect((await request(app).get('/uploads/331_shared.wav').set(as(OP10))).status).toBe(200);
    expect((await request(app).get(`/uploads/111_t10.wav?token=${A10}`)).status).toBe(200);
  });
  it('another tenant\'s file is a 404 even though it exists on disk (existence is not revealed)', async () => {
    const r = await request(app).get('/uploads/221_t20.wav').set(as(A10));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Not found' });
  });
  it('deleted-record files, unknown files, dotfiles and traversal attempts are 404', async () => {
    for (const p of ['/uploads/441_gone.wav', '/uploads/nope.wav', '/uploads/.env', `/uploads/%2e%2e/mti-secret-${process.pid}.txt`,
                     `/uploads/..%2fmti-secret-${process.pid}.txt`, '/uploads/', '/uploads/%00x.wav']) {
      const r = await request(app).get(p).set(as(SA));
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toMatch(/top secret|bytes-of-\.env/);
    }
  });
  it('a symlink inside the upload dir that points outside it is a 404, even with a matching DB row', async () => {
    const link = F('551_link.wav');
    try { symlinkSync(path.join(UP, '..', `mti-secret-${process.pid}.txt`), link); } catch { return; }  // no symlink privilege (Windows)
    MEDIA.push({ id: 55, tenant_id: 10, name: 'link', path_or_uri: link, fs_path: null, deleted_at: null });
    const r = await request(app).get('/uploads/551_link.wav').set(as(OP10));
    rmSync(link, { force: true });
    expect(r.status).toBe(404);
    expect(r.text).not.toMatch(/top secret/);
  });
  it('SUPER_ADMIN may fetch any tenant\'s file', async () => {
    expect((await request(app).get('/uploads/221_t20.wav').set(as(SA))).status).toBe(200);
  });
});

describe('media socket events are tenant-scoped and carry no server paths', () => {
  it('update emits only to the owning tenant room + SUPER_ADMINs, without paths/emails; never a global broadcast', async () => {
    const sent = [];
    const fakeIo = {
      emit: vi.fn(),
      to(room) { const rooms = [room]; const chain = { to(r) { rooms.push(r); return chain; }, emit: (e, d) => sent.push({ rooms, e, d }) }; return chain; },
    };
    setSocketIO(fakeIo);
    await request(app).put('/media-library/11').set(as(A10)).send({ name: 'Renamed' });
    emitMediaEvent('media.test', { x: 1 }, null);
    setSocketIO(null);
    expect(fakeIo.emit).not.toHaveBeenCalled();
    const upd = sent.find(s => s.e === 'media.updated');
    expect(upd.rooms).toEqual(['tenant:10', 'role:SUPER_ADMIN']);
    expect(Object.keys(upd.d.file).sort()).toEqual(['category', 'id', 'is_deployed', 'name', 'tenant_id']);
    expect(sent.find(s => s.e === 'media.test').rooms).toEqual(['role:SUPER_ADMIN']);
  });
});
