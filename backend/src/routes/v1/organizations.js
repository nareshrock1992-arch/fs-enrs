import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/organizationController.js';

const router = Router();
router.use(requireAuth);

// Organizations
router.get('/',         adminOrOp, ctrl.listOrganizations);
router.get('/:id',      adminOrOp, ctrl.getOrganization);
router.post('/',        adminOnly,  ctrl.createOrganization);
router.put('/:id',      adminOnly,  ctrl.updateOrganization);
router.delete('/:id',   adminOnly,  ctrl.deleteOrganization);

// Locations
router.get('/locations',      adminOrOp, ctrl.listLocations);
router.post('/locations',     adminOnly,  ctrl.createLocation);
router.put('/locations/:id',  adminOnly,  ctrl.updateLocation);
router.delete('/locations/:id', adminOnly, ctrl.deleteLocation);

// Departments
router.get('/departments',      adminOrOp, ctrl.listDepartments);
router.post('/departments',     adminOnly,  ctrl.createDepartment);
router.put('/departments/:id',  adminOnly,  ctrl.updateDepartment);
router.delete('/departments/:id', adminOnly, ctrl.deleteDepartment);

export default router;
