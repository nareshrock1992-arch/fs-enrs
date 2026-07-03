import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from '../../controllers/dashboardController.js';

const router = Router();
router.use(requireAuth);

router.get('/metrics', ctrl.getMetrics);
router.get('/active',  ctrl.getActive);
router.get('/chart',   ctrl.getChartData);

export default router;
