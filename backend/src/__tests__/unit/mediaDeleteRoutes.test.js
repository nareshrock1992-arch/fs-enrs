/**
 * HTTP contract of both media delete routes after the dependency guard:
 *   DELETE /media-library/:id      (mediaLibraryController.deleteMedia)
 *   DELETE /deployment/audio/:id   (deploymentController.deleteAudio — legacy)
 * 204 deleted · 404 not found · 409 in use (structured) · 503 check failed (nothing deleted)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/index.js', () => ({
  config: { uploads: { dir: '/tmp/uploads', maxSizeMb: 50 }, freeswitch: {}, esl: {} },
}));
vi.mock('../../db/pool.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../services/freeSwitchPathService.js', () => ({
  // ivrTemplates.js (loaded via the real mediaDependencyService) reads the IVR
  // recording dir at import time.
  fsPathService: { getEnrsSoundDir: () => '/sounds/enrs', getIvrRecordingDir: () => '/recordings/ivr' },
}));
vi.mock('../../services/deploymentEngine.js', () => ({
  deployFlow: vi.fn(), redeployAll: vi.fn(), getDeploymentHistory: vi.fn(), previewDeployment: vi.fn(),
}));
vi.mock('../../services/diagnosticsService.js', () => ({
  runDiagnostics: vi.fn(), pingEsl: vi.fn(), reloadXml: vi.fn(), disableLegacyExtension: vi.fn(),
}));
// Real error classes and response-body helpers; only the delete itself is mocked.
vi.mock('../../services/mediaDependencyService.js', async () => {
  const actual = await vi.importActual('../../services/mediaDependencyService.js');
  return { ...actual, deleteMediaSafely: vi.fn() };
});

const { deleteMediaSafely, DependencyCheckError, DependencySchemaError } =
  await import('../../services/mediaDependencyService.js');
const { deleteMedia } = await import('../../controllers/mediaLibraryController.js');
const { deleteAudio } = await import('../../controllers/deploymentController.js');

function mockRes() {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = vi.fn((c) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b) => { res.body = b; return res; });
  res.end    = vi.fn(() => { res.ended = true; return res; });
  return res;
}
const req = (over = {}) => ({ params: { id: '7' }, headers: {}, query: {}, body: {},
  user: { role: 'ADMIN', tenantId: 1 }, ...over });

const routes = [
  ['DELETE /media-library/:id', deleteMedia, { allowSystemShared: undefined }],
  ['DELETE /deployment/audio/:id (legacy)', deleteAudio, { allowSystemShared: true }],
];

beforeEach(() => { vi.mocked(deleteMediaSafely).mockReset(); });

for (const [label, handler, expectArgs] of routes) {
  describe(label, () => {
    it('204 when deleted', async () => {
      vi.mocked(deleteMediaSafely).mockResolvedValue({ status: 'deleted', record: { id: 7 }, warnings: [], file: { action: 'quarantined' } });
      const res = mockRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.statusCode).toBe(204);
      expect(res.ended).toBe(true);
    });

    it('passes the effective tenant and route semantics to the guard', async () => {
      vi.mocked(deleteMediaSafely).mockResolvedValue({ status: 'not_found' });
      await handler(req({ headers: { 'x-request-id': 'req-1' } }), mockRes(), (e) => { throw e; });
      const args = vi.mocked(deleteMediaSafely).mock.calls[0][0];
      expect(args).toMatchObject({ id: '7', tenantId: 1, correlationId: 'req-1' });
      expect(args.allowSystemShared).toBe(expectArgs.allowSystemShared);
    });

    it('404 when not found / not visible to the tenant', async () => {
      vi.mocked(deleteMediaSafely).mockResolvedValue({ status: 'not_found' });
      const res = mockRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.statusCode).toBe(404);
    });

    it('409 with structured dependency details when in use', async () => {
      const blocking = [{ kind: 'ivr_flow_draft', blocking: true, id: '1', name: 'Main IVR', field: 'draft' }];
      vi.mocked(deleteMediaSafely).mockResolvedValue({ status: 'blocked', record: { id: 7 }, blocking, warnings: [], hiddenCount: 1 });
      const res = mockRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ error: 'MEDIA_IN_USE', dependencies: blocking, hidden_count: 1 });
    });

    it('503 (fail closed, nothing deleted) when the dependency check fails', async () => {
      vi.mocked(deleteMediaSafely).mockRejectedValue(new DependencyCheckError('db down'));
      const res = mockRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('DEPENDENCY_CHECK_FAILED');
    });

    it('503 DEPENDENCY_SCHEMA_ERROR naming the missing table when a required table is absent', async () => {
      vi.mocked(deleteMediaSafely).mockRejectedValue(new DependencySchemaError(['config_versions']));
      const res = mockRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('DEPENDENCY_SCHEMA_ERROR');
      expect(res.body.message).toMatch(/config_versions/);
      expect(res.body.message).toMatch(/Nothing was deleted/);
    });

    it('passes unexpected errors to the error handler (no false success)', async () => {
      vi.mocked(deleteMediaSafely).mockRejectedValue(new Error('unexpected'));
      const res = mockRes();
      const next = vi.fn();
      await handler(req(), res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'unexpected' }));
      expect(res.statusCode).toBe(200); // untouched — no 204 was sent
    });

    it('SUPER_ADMIN without tenant filter is unrestricted (tenantId null)', async () => {
      vi.mocked(deleteMediaSafely).mockResolvedValue({ status: 'not_found' });
      await handler(req({ user: { role: 'SUPER_ADMIN', tenantId: null } }), mockRes(), (e) => { throw e; });
      expect(vi.mocked(deleteMediaSafely).mock.calls[0][0].tenantId).toBeNull();
    });
  });
}
