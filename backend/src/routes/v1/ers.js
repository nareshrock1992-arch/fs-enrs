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

// Tier group management (multi-group per tier)
router.get('/configurations/:id/tier-groups',  adminOrOp, ctrl.getTierGroups);
router.put('/configurations/:id/tier-groups',  adminOnly,  ctrl.updateTierGroups);

// Incidents
router.get('/incidents',                adminOrOp, ctrl.listIncidents);
router.get('/incidents/:id/responders', adminOrOp, ctrl.listResponders);

// Queue
router.get('/queue', adminOrOp, ctrl.getQueue);

// Phase 5 C3 — external-facing user-list upsert (docs/API_REFERENCE.md)
router.post('/broadcast-users', adminOnly, ctrl.upsertBroadcastUsers);

export default router;
