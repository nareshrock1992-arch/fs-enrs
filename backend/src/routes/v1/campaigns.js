import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/campaignController.js';

const router = Router();
router.use(requireAuth);

// Engine status
router.get('/engine/stats', adminOrOp, ctrl.engineStats);

// Campaign CRUD
router.get('/',            adminOrOp, ctrl.listCampaigns);
router.get('/:id',         adminOrOp, ctrl.getCampaign);
router.get('/:id/destinations', adminOrOp, ctrl.listDestinations);
router.post('/',           adminOrOp, ctrl.triggerCampaign);

// Campaign control
router.post('/:id/pause',  adminOrOp, ctrl.pause);
router.post('/:id/resume', adminOrOp, ctrl.resume);
router.post('/:id/cancel', adminOrOp, ctrl.cancel);

export default router;
