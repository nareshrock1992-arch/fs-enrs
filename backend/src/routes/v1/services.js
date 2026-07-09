import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/serviceController.js';

const router = Router();
router.use(requireAuth);

router.get('/',      adminOrOp, ctrl.listServices);
router.post('/',     adminOnly, ctrl.createService);
router.get('/:id',   adminOrOp, ctrl.getService);
router.put('/:id',   adminOnly, ctrl.updateServiceMeta);
router.patch('/:id', adminOnly, ctrl.updateServiceMeta);
router.delete('/:id', adminOnly, ctrl.deleteService);

export default router;
