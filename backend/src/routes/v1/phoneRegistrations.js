import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { superAdminOrAdmin } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/registrationController.js';

// Phone registrations (read-only): platform super-admins and tenant admins (owner, 2026-11-25).
const router = Router();
router.use(requireAuth);
router.get('/', superAdminOrAdmin, ctrl.listRegistrations);

export default router;
