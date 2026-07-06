import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/ensController.js';

const router = Router();

// All ENS routes require JWT authentication.
// Lua script endpoints have been moved to /api/v1/internal/ens/* (X-Internal-Key auth).
router.use(requireAuth);

// Configurations
router.get('/configurations',         adminOrOp, ctrl.listConfigurations);
router.get('/configurations/:id',     adminOrOp, ctrl.getConfiguration);
router.post('/configurations',        adminOnly,  ctrl.createConfiguration);
router.put('/configurations/:id',     adminOnly,  ctrl.updateConfiguration);
router.patch('/configurations/:id/toggle', adminOnly, ctrl.toggleActive);
router.delete('/configurations/:id',  adminOnly,  ctrl.deleteConfiguration);

// Notifications
router.get('/notifications',  adminOrOp, ctrl.listNotifications);
router.post('/notifications', adminOrOp, ctrl.createNotification);

export default router;
