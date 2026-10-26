/**
 * Media Library + Recordings — route-level authorization matrix.
 *
 * Drives the REAL routers and the REAL rbac.js role checks. Only the auth layer
 * (it sets req.user from the x-test-role header) and the controllers (stubs that
 * answer 200) are replaced, so this test proves exactly which role reaches
 * which handler. Keep in sync with docs/media-rbac.md and
 * frontend/src/auth/permissions.js.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth.js', () => {
  const setUser = (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!role) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: 1, role, tenantId: 1 };
    next();
  };
  return { requireAuth: setUser, requireAuthOrToken: setUser };
});
const stub = (req, res) => res.status(200).json({ reached: true });
// Signature verification / issuance are covered by mediaAccess.test.js; here the
// stream/download guards behave like the (mocked) auth layer and issuance is a stub.
vi.mock('../../middleware/mediaAccess.js', () => ({
  requireMediaAccess: () => (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!role) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: 1, role, tenantId: 1 };
    next();
  },
  issueMediaAccess: () => (req, res) => res.status(200).json({ sig: 'x' }),
}));
vi.mock('../../controllers/mediaLibraryController.js', () => ({
  listMedia: stub, listCategories: stub, uploadMedia: stub, scanMedia: stub, getMedia: stub,
  updateMedia: stub, deployMedia: stub, streamMedia: stub, downloadMedia: stub, getWaveform: stub,
  deleteMedia: stub, uploadMiddleware: (req, res, next) => next(),
}));
vi.mock('../../controllers/recordingController.js', () => ({
  listRecordings: stub, getRecording: stub, streamRecording: stub, downloadRecording: stub,
  getRecordingWaveform: stub, updateRecording: stub, archiveRecording: stub, deleteRecording: stub,
}));

const app = express();
app.use(express.json());
app.use('/media-library', (await import('../../routes/v1/mediaLibrary.js')).default);
app.use('/recordings', (await import('../../routes/v1/recordings.js')).default);

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];
const VIEW_MEDIA = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR'];
const UPLOAD     = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'];
const ADMIN      = ['SUPER_ADMIN', 'ADMIN'];
const REC_VIEW   = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'];   // unchanged (adminOrOp)

const MATRIX = [
  ['get',    '/media-library',             VIEW_MEDIA],
  ['get',    '/media-library/categories',  VIEW_MEDIA],
  ['get',    '/media-library/7',           VIEW_MEDIA],
  ['post',   '/media-library/upload',      UPLOAD],
  ['post',   '/media-library/scan',        ADMIN],
  ['put',    '/media-library/7',           ADMIN],
  ['post',   '/media-library/7/deploy',    ADMIN],
  ['delete', '/media-library/7',           ADMIN],
  ['get',    '/recordings',                REC_VIEW],
  ['get',    '/recordings/7',              REC_VIEW],
  ['put',    '/recordings/7',              REC_VIEW],
  ['post',   '/recordings/7/archive',      REC_VIEW],
  ['delete', '/recordings/7',              ADMIN],             // tightened from adminOrOp
  // Audio bytes and scoped links follow the same role rule as the list:
  // media → media.view (no VIEWER); recordings → recordings.view.
  ['get',    '/media-library/7/access',    VIEW_MEDIA],
  ['get',    '/media-library/7/stream',    VIEW_MEDIA],
  ['get',    '/recordings/7/access',       REC_VIEW],
  ['get',    '/recordings/7/stream',       REC_VIEW],
];

describe('Media Library + Recordings role matrix', () => {
  for (const [method, url, allowed] of MATRIX) {
    for (const role of ROLES) {
      const expected = allowed.includes(role) ? 200 : 403;
      it(`${method.toUpperCase()} ${url} as ${role} → ${expected}`, async () => {
        const r = await request(app)[method](url).set('x-test-role', role);
        expect(r.status).toBe(expected);
      });
    }
  }
  it('unauthenticated requests are rejected (401) before any role check', async () => {
    expect((await request(app).get('/media-library')).status).toBe(401);
    expect((await request(app).delete('/recordings/7')).status).toBe(401);
  });
  it('SUPERVISOR can now list the library it can upload to (previously 403)', async () => {
    expect((await request(app).get('/media-library').set('x-test-role', 'SUPERVISOR')).status).toBe(200);
    expect((await request(app).post('/media-library/upload').set('x-test-role', 'SUPERVISOR')).status).toBe(200);
  });
  it('OPERATOR can no longer delete recordings (previously allowed by the API, never offered by the UI)', async () => {
    expect((await request(app).delete('/recordings/7').set('x-test-role', 'OPERATOR')).status).toBe(403);
  });
});
