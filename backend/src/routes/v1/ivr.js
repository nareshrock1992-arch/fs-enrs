import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrSuper } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from '../../controllers/ivrController.js';
import * as tplCtrl from '../../controllers/ivrTemplates.js';

const router = Router();

router.use(requireAuth);

// Reject non-UUID values before they reach the DB (avoids an invalid-input-syntax 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('uuid', (req, res, next, uuid) => {
  if (!UUID_RE.test(uuid)) {
    return res.status(400).json({ error: `Invalid flow UUID: "${uuid}"` });
  }
  next();
});

// ── Templates (static segment — must be before /:uuid) ────────────────────────
router.get('/templates',                          asyncHandler(tplCtrl.listTemplates));
router.post('/templates/:id/create',
            adminOrSuper,   asyncHandler(tplCtrl.createFromTemplate));

// ── Read access for VIEWER and above ─────────────────────────────────────────
router.get('/',                         ctrl.listFlows);
router.get('/:uuid',                    ctrl.getFlowById);
router.get('/:uuid/versions',           ctrl.listVersions);
router.get('/:uuid/versions/:vnum',     ctrl.getVersion);

// Validate is non-mutating but needs write context — SUPERVISOR+
router.post('/:uuid/validate',          adminOrSuper, ctrl.validateFlow);

// ── Mutating operations — ADMIN or SUPERVISOR only ────────────────────────────
router.post('/',                        adminOrSuper, ctrl.createFlow);
router.put('/:uuid',                    adminOrSuper, ctrl.updateFlow);
router.delete('/:uuid',                 adminOrSuper, ctrl.deleteFlow);
router.post('/:uuid/publish',           adminOrSuper, ctrl.publishFlow);
router.patch('/:uuid/bind',             adminOrSuper, ctrl.bindNumber);
router.patch('/:uuid/unbind',           adminOrSuper, ctrl.unbindNumber);

export default router;
