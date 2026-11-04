import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrSuper } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/gatewayController.js';

const router = Router();
router.use(requireAuth);

router.get('/',              ctrl.listGateways);
router.post('/',             adminOrSuper, ctrl.createGateway);
router.put('/:id',           adminOrSuper, ctrl.updateGateway);
router.delete('/:id',        adminOrSuper, ctrl.deleteGateway);
router.post('/:id/deploy',   adminOrSuper, ctrl.deployGatewayRoute);

export default router;
