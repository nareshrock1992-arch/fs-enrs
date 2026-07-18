import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/contactController.js';

const router   = Router();
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

// Deprecated (Sunset: 2026-08-31) — was previously unauthenticated for Lua
// callers but moved to internal API. Now requires auth to prevent PIN enumeration.
router.get('/by-pin', ctrl.getByPin);
router.get('/',                adminOrOp, ctrl.listContacts);
router.get('/:id',             adminOrOp, ctrl.getContact);
router.post('/',               adminOnly,  ctrl.createContact);
router.put('/:id',             adminOnly,  ctrl.updateContact);
router.delete('/:id',          adminOnly,  ctrl.deleteContact);
router.post('/bulk-upload',    adminOnly,  upload.single('file'), ctrl.bulkUpload);

export default router;
