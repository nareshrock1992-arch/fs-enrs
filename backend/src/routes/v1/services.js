import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/serviceController.js';

const router = Router();
router.use(requireAuth);

router.get('/',     adminOrOp, ctrl.listServices);
router.get('/:id',  adminOrOp, ctrl.getService);
router.patch('/:id', adminOnly, ctrl.updateServiceMeta);

export default router;
