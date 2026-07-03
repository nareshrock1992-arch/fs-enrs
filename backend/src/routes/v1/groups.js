import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/groupController.js';

const router = Router();
router.use(requireAuth);

router.get('/',                      adminOrOp, ctrl.listGroups);
router.get('/:id',                   adminOrOp, ctrl.getGroup);
router.post('/',                     adminOnly,  ctrl.createGroup);
router.put('/:id',                   adminOnly,  ctrl.updateGroup);
router.delete('/:id',                adminOnly,  ctrl.deleteGroup);
router.post('/:id/members',          adminOnly,  ctrl.addMembers);
router.delete('/:id/members/:contactId', adminOnly, ctrl.removeMember);

export default router;
