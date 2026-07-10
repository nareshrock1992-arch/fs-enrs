import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/gatewayController.js';

const router = Router();
router.use(requireAuth);

router.get('/',              ctrl.listGateways);
router.post('/',             requireRole('ADMIN', 'SUPERVISOR'), ctrl.createGateway);
router.put('/:id',           requireRole('ADMIN', 'SUPERVISOR'), ctrl.updateGateway);
router.delete('/:id',        requireRole('ADMIN', 'SUPERVISOR'), ctrl.deleteGateway);
router.post('/:id/deploy',   requireRole('ADMIN', 'SUPERVISOR'), ctrl.deployGatewayRoute);

export default router;
