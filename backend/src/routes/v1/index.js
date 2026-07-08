import { Router } from 'express';
import authRoutes    from './auth.js';
import orgRoutes     from './organizations.js';
import contactRoutes from './contacts.js';
import groupRoutes   from './groups.js';
import ensRoutes     from './ens.js';
import ersRoutes     from './ers.js';
import dashRoutes    from './dashboard.js';
import reportRoutes  from './reports.js';
import userRoutes    from './users.js';
import mediaRoutes   from './media.js';
import settingRoutes from './settings.js';
import ivrRoutes     from './ivr.js';

const router = Router();

router.use('/auth',          authRoutes);
router.use('/users',         userRoutes);
router.use('/organizations', orgRoutes);
router.use('/contacts',      contactRoutes);
router.use('/groups',        groupRoutes);
router.use('/ens',           ensRoutes);
router.use('/ers',           ersRoutes);
router.use('/ivr/flows',      ivrRoutes);
router.use('/dashboard',     dashRoutes);
router.use('/reports',       reportRoutes);
router.use('/media',         mediaRoutes);
router.use('/settings',      settingRoutes);

export default router;
