import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/ersController.js';

const router = Router();

router.use(requireAuth);

// Configurations
router.get('/configurations',               adminOrOp, ctrl.listConfigurations);
router.get('/configurations/:id',           adminOrOp, ctrl.getConfiguration);
router.post('/configurations',              adminOnly,  ctrl.createConfiguration);
router.put('/configurations/:id',           adminOnly,  ctrl.updateConfiguration);
router.patch('/configurations/:id/toggle',  adminOnly,  ctrl.toggleActive);
router.delete('/configurations/:id',        adminOnly,  ctrl.deleteConfiguration);

// Incidents
router.get('/incidents',                adminOrOp, ctrl.listIncidents);
router.get('/incidents/:id/responders', adminOrOp, ctrl.listResponders);

// Queue
router.get('/queue', adminOrOp, ctrl.getQueue);

export default router;
