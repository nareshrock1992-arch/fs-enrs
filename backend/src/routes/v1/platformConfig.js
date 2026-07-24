/**
 * Platform Configuration Routes
 * Base: /api/v1/platform/config
 *
 * All endpoints require ADMIN role — configuration changes have system-wide impact.
 *
 * Bootstraps the framework on first import:
 *   1. Constructs the FreeSwitchDriver (wraps existing ESL + path services)
 *   2. Registers all active providers
 *   3. Creates the ConfigurationManager singleton
 */
import { Router }    from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly }   from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

import { FreeSwitchDriver }     from '../../../platform/drivers/FreeSwitchDriver.js';
import { ProviderRegistry }     from '../../../platform/configuration/ProviderRegistry.js';
import { ConfigurationManager } from '../../../platform/configuration/ConfigurationManager.js';
import { VarsProvider }         from '../../../platform/configuration/providers/VarsProvider.js';

// ── Lazy service imports (already singletons loaded at boot) ──────────────────
// Use dynamic import to guarantee services are fully initialized before we
// build the driver. The router module is imported after server boot completes.
let _manager = null;

async function getManager() {
  if (_manager) return _manager;

  const [eslMod, pathMod] = await Promise.all([
    import('../../services/eslService.js'),
    import('../../services/freeSwitchPathService.js'),
  ]);

  const driver   = new FreeSwitchDriver(eslMod, pathMod.fsPathService);
  const registry = new ProviderRegistry();

  // ── Register providers (Phase 7.1) ─────────────────────────────────────────
  registry.register(new VarsProvider(driver));
  // Phase 7.2+: registry.register(new SwitchProvider(driver));
  // Phase 7.2+: registry.register(new EventSocketProvider(driver));

  _manager = new ConfigurationManager(registry);
  return _manager;
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

const auth = [requireAuth, adminOnly];

// GET /platform/config/providers — list all registered providers
router.get('/providers', ...auth, asyncHandler(async (req, res) => {
  const mgr = await getManager();
  res.json({ providers: mgr.listProviders() });
}));

// GET /platform/config/audit — global audit log
router.get('/audit', ...auth, asyncHandler(async (req, res) => {
  const mgr    = await getManager();
  const limit  = Math.min(Number(req.query.limit)  || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const rows   = await mgr.getAuditLog(null, { tenantId: req.user.tenantId, limit, offset });
  res.json({ audit: rows, limit, offset });
}));

// ── Provider-specific routes ──────────────────────────────────────────────────

// Validate providerId before it reaches any handler.
router.param('providerId', async (req, res, next, id) => {
  try {
    const mgr = await getManager();
    mgr.getProvider(id); // throws 404 if not registered
    req._configMgr = mgr;
    next();
  } catch (err) {
    next(err);
  }
});

// GET /platform/config/:providerId — read + parse current file
router.get('/:providerId', ...auth, asyncHandler(async (req, res) => {
  const result = await req._configMgr.read(
    req.params.providerId,
    { userId: req.user.id, tenantId: req.user.tenantId }
  );
  res.json(result);
}));

// POST /platform/config/:providerId/preview — preview changes (no write)
router.post('/:providerId/preview', ...auth, asyncHandler(async (req, res) => {
  const { changes = [] } = req.body;
  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'changes must be a non-empty array' });
  }
  const result = await req._configMgr.preview(
    req.params.providerId,
    changes,
    { userId: req.user.id, tenantId: req.user.tenantId }
  );
  res.json(result);
}));

// POST /platform/config/:providerId/deploy — full deploy pipeline
router.post('/:providerId/deploy', ...auth, asyncHandler(async (req, res) => {
  const { changes = [], reason } = req.body;
  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'changes must be a non-empty array' });
  }
  const result = await req._configMgr.deploy(
    req.params.providerId,
    changes,
    { userId: req.user.id, tenantId: req.user.tenantId, reason }
  );
  res.json(result);
}));

// POST /platform/config/:providerId/rollback/:versionId
router.post('/:providerId/rollback/:versionId', ...auth, asyncHandler(async (req, res) => {
  const versionId = Number(req.params.versionId);
  if (!Number.isInteger(versionId) || versionId < 1) {
    return res.status(400).json({ error: 'versionId must be a positive integer' });
  }
  const { reason } = req.body;
  const result = await req._configMgr.rollback(
    req.params.providerId,
    versionId,
    { userId: req.user.id, tenantId: req.user.tenantId, reason }
  );
  res.json(result);
}));

// GET /platform/config/:providerId/history
router.get('/:providerId/history', ...auth, asyncHandler(async (req, res) => {
  const limit  = Math.min(Number(req.query.limit)  || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const rows   = await req._configMgr.getHistory(
    req.params.providerId,
    { limit, offset, tenantId: req.user.tenantId }
  );
  res.json({ versions: rows, limit, offset });
}));

// GET /platform/config/:providerId/history/:v1/diff/:v2
router.get('/:providerId/history/:v1/diff/:v2', ...auth, asyncHandler(async (req, res) => {
  const v1 = Number(req.params.v1);
  const v2 = Number(req.params.v2);
  if (!Number.isInteger(v1) || !Number.isInteger(v2)) {
    return res.status(400).json({ error: 'Version IDs must be integers' });
  }
  const result = await req._configMgr.diffVersions(v1, v2, req.user.tenantId);
  res.json(result);
}));

// GET /platform/config/:providerId/audit
router.get('/:providerId/audit', ...auth, asyncHandler(async (req, res) => {
  const limit  = Math.min(Number(req.query.limit)  || 50, 500);
  const offset = Number(req.query.offset) || 0;
  const rows   = await req._configMgr.getAuditLog(req.params.providerId, { limit, offset });
  res.json({ audit: rows, limit, offset });
}));

export default router;
