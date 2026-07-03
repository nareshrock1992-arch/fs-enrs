import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/ensController.js';

const router = Router();

// Lua-accessible — lookup by PIN, no UI auth needed
router.get('/lookup',            ctrl.lookupByPin);

// Notification status updates from Lua
router.patch('/notifications/:uuid/status', ctrl.updateNotificationStatus);

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
