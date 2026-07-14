import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getNodeTypes } from '../../controllers/ivrController.js';
import authRoutes       from './auth.js';
import orgRoutes        from './organizations.js';
import contactRoutes    from './contacts.js';
import groupRoutes      from './groups.js';
import ensRoutes        from './ens.js';
import ersRoutes        from './ers.js';
import dashRoutes       from './dashboard.js';
import reportRoutes     from './reports.js';
import userRoutes       from './users.js';
import mediaRoutes      from './media.js';
import settingRoutes    from './settings.js';
import ivrRoutes        from './ivr.js';
import deploymentRoutes from './deployment.js';
import serviceRoutes    from './services.js';
import campaignRoutes   from './campaigns.js';
import gatewayRoutes    from './gateways.js';
import monitoringRoutes   from './monitoring.js';
import mediaLibraryRoutes from './mediaLibrary.js';
import recordingRoutes    from './recordings.js';

const router = Router();

router.use('/auth',          authRoutes);
router.use('/users',         userRoutes);
router.use('/organizations', orgRoutes);
router.use('/contacts',      contactRoutes);
router.use('/groups',        groupRoutes);
router.use('/ens',           ensRoutes);
router.use('/ers',           ersRoutes);
// Phase 3 node-type registry — single source of truth for the IVR builder's
// palette + property forms. Mounted at /ivr (not /ivr/flows) so it's not
// shadowed by ivrRoutes' internal /:uuid param matcher.
router.get('/ivr/node-types', requireAuth, asyncHandler(getNodeTypes));
router.use('/ivr/flows',     ivrRoutes);
router.use('/deployment',    deploymentRoutes);
router.use('/services',      serviceRoutes);
router.use('/campaigns',     campaignRoutes);
router.use('/dashboard',     dashRoutes);
router.use('/reports',       reportRoutes);
router.use('/media',         mediaRoutes);
router.use('/settings',      settingRoutes);
router.use('/gateways',      gatewayRoutes);
router.use('/monitoring',    monitoringRoutes);
router.use('/media-library', mediaLibraryRoutes);
router.use('/recordings',    recordingRoutes);

export default router;
