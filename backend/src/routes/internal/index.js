import { Router } from 'express';
import ensRoutes from './ens.js';
import ersRoutes from './ers.js';
import ivrRoutes from './ivr.js';

const router = Router();

router.use('/ens', ensRoutes);
router.use('/ers', ersRoutes);
router.use('/ivr', ivrRoutes);

// 404 fallback for unknown internal paths
router.use((req, res) => {
  res.status(404).json({ error: `Internal route not found: ${req.method} ${req.path}` });
});

export default router;
