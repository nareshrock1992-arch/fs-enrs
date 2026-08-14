import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { superAdminOnly } from '../../middleware/rbac.js';
import {
  listTenants, getTenant, createTenant, updateTenant,
} from '../../controllers/tenantController.js';

const router = Router();
router.use(requireAuth, superAdminOnly);

router.get('/',     listTenants);
router.post('/',    createTenant);
router.get('/:id',  getTenant);
router.patch('/:id', updateTenant);

export default router;
