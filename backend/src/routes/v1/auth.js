import { Router } from 'express';
import rateLimit  from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from '../../controllers/authController.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login',           loginLimiter, ctrl.login);
router.post('/refresh',         ctrl.refresh);
router.post('/logout',          requireAuth, ctrl.logout);
router.get( '/me',              requireAuth, ctrl.me);
router.post('/change-password', requireAuth, ctrl.changePassword);

export default router;
