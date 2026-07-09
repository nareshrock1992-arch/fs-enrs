import { Router } from 'express';
import ensRoutes from './ens.js';
import ersRoutes from './ers.js';
import ivrRoutes from './ivr.js';
import { internalServiceLookup } from '../../controllers/serviceController.js';

const router = Router();

// Unified service lookup — Lua calls this first for any dialed number
router.get('/services/:number', internalServiceLookup);
router.get('/services',         internalServiceLookup);   // ?number= fallback

router.use('/ens', ensRoutes);
router.use('/ers', ersRoutes);
router.use('/ivr', ivrRoutes);

router.use((req, res) => {
  res.status(404).json({ error: `Internal route not found: ${req.method} ${req.path}` });
});

export default router;
