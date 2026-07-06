import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/ivrController.js';

const router = Router();

router.use(requireAuth);

// Read access for VIEWER and above
router.get('/',                         ctrl.listFlows);
router.get('/:uuid',                    ctrl.getFlowById);
router.get('/:uuid/versions',           ctrl.listVersions);
router.get('/:uuid/versions/:vnum',     ctrl.getVersion);

// Validate is non-mutating but needs write context — SUPERVISOR+
router.post('/:uuid/validate',          requireRole('ADMIN', 'SUPERVISOR'), ctrl.validateFlow);

// Mutating operations — ADMIN or SUPERVISOR only
router.post('/',                        requireRole('ADMIN', 'SUPERVISOR'), ctrl.createFlow);
router.put('/:uuid',                    requireRole('ADMIN', 'SUPERVISOR'), ctrl.updateFlow);
router.delete('/:uuid',                 requireRole('ADMIN', 'SUPERVISOR'), ctrl.deleteFlow);
router.post('/:uuid/publish',           requireRole('ADMIN', 'SUPERVISOR'), ctrl.publishFlow);
router.patch('/:uuid/bind',             requireRole('ADMIN', 'SUPERVISOR'), ctrl.bindNumber);
router.patch('/:uuid/unbind',           requireRole('ADMIN', 'SUPERVISOR'), ctrl.unbindNumber);

export default router;
