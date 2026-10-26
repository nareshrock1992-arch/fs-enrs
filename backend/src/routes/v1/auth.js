import { Router } from 'express';
import rateLimit  from 'express-rate-limit';
import { requireAuth, requireAuthSelf } from '../../middleware/auth.js';
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
// Logout only clears the caller's own refresh token, so it stays available to an
// account without a tenant (least privilege: /me and change-password do not).
router.post('/logout',          requireAuthSelf, ctrl.logout);
router.get( '/me',              requireAuth, ctrl.me);
router.post('/change-password', requireAuth, ctrl.changePassword);

export default router;
