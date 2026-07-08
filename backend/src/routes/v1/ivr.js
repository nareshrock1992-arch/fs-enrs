import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from '../../controllers/ivrController.js';
import * as tplCtrl from '../../controllers/ivrTemplates.js';

const router = Router();

router.use(requireAuth);

// ── Templates (static segment — must be before /:uuid) ────────────────────────
router.get('/templates',                          asyncHandler(tplCtrl.listTemplates));
router.post('/templates/:id/create',
            requireRole('ADMIN', 'SUPERVISOR'),   asyncHandler(tplCtrl.createFromTemplate));

// ── Read access for VIEWER and above ─────────────────────────────────────────
router.get('/',                         ctrl.listFlows);
router.get('/:uuid',                    ctrl.getFlowById);
router.get('/:uuid/versions',           ctrl.listVersions);
router.get('/:uuid/versions/:vnum',     ctrl.getVersion);

// Validate is non-mutating but needs write context — SUPERVISOR+
router.post('/:uuid/validate',          requireRole('ADMIN', 'SUPERVISOR'), ctrl.validateFlow);

// ── Mutating operations — ADMIN or SUPERVISOR only ────────────────────────────
router.post('/',                        requireRole('ADMIN', 'SUPERVISOR'), ctrl.createFlow);
router.put('/:uuid',                    requireRole('ADMIN', 'SUPERVISOR'), ctrl.updateFlow);
router.delete('/:uuid',                 requireRole('ADMIN', 'SUPERVISOR'), ctrl.deleteFlow);
router.post('/:uuid/publish',           requireRole('ADMIN', 'SUPERVISOR'), ctrl.publishFlow);
router.patch('/:uuid/bind',             requireRole('ADMIN', 'SUPERVISOR'), ctrl.bindNumber);
router.patch('/:uuid/unbind',           requireRole('ADMIN', 'SUPERVISOR'), ctrl.unbindNumber);

export default router;
