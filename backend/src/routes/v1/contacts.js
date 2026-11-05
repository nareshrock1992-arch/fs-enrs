import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import * as ctrl from '../../controllers/contactController.js';

const router   = Router();
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

// A malformed contact id is a 400, not a database error (500).
router.param('id', (req, res, next, id) => (
  ctrl.isContactId(id) ? next() : res.status(400).json({ error: 'Invalid contact id' })
));

// Deprecated (Sunset: 2026-08-31) — was previously unauthenticated for Lua
// callers but moved to internal API. Now requires auth to prevent PIN enumeration.
router.get('/by-pin', ctrl.getByPin);
router.get('/',                adminOrOp, ctrl.listContacts);
router.get('/roles',           adminOrOp, ctrl.listRoles);       // before /:id
router.get('/export',          adminOrOp, ctrl.exportContacts);  // before /:id
router.get('/:id',             adminOrOp, ctrl.getContact);
router.post('/',               adminOnly,  ctrl.createContact);
router.post('/bulk-delete',    adminOnly,  ctrl.bulkDeleteContacts);
router.put('/:id',             adminOnly,  ctrl.updateContact);
router.delete('/:id',          adminOnly,  ctrl.deleteContact);
router.post('/bulk-upload',    adminOnly,  upload.single('file'), ctrl.bulkUpload);

export default router;
