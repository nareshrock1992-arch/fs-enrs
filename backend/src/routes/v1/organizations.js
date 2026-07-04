import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/organizationController.js';

const router = Router();
router.use(requireAuth);

// Locations — MUST be before /:id to prevent Express matching 'locations' as an id param
router.get('/locations',        adminOrOp, ctrl.listLocations);
router.post('/locations',       adminOnly,  ctrl.createLocation);
router.put('/locations/:id',    adminOnly,  ctrl.updateLocation);
router.delete('/locations/:id', adminOnly,  ctrl.deleteLocation);

// Departments — same reason: must precede /:id
router.get('/departments',        adminOrOp, ctrl.listDepartments);
router.post('/departments',       adminOnly,  ctrl.createDepartment);
router.put('/departments/:id',    adminOnly,  ctrl.updateDepartment);
router.delete('/departments/:id', adminOnly,  ctrl.deleteDepartment);

// Organizations — wildcard /:id last
router.get('/',         adminOrOp, ctrl.listOrganizations);
router.get('/:id',      adminOrOp, ctrl.getOrganization);
router.post('/',        adminOnly,  ctrl.createOrganization);
router.put('/:id',      adminOnly,  ctrl.updateOrganization);
router.delete('/:id',   adminOnly,  ctrl.deleteOrganization);

export default router;
