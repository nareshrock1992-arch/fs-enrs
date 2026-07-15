/**
 * Media Library routes
 * Mounted at /api/v1/media-library
 */

import { Router } from 'express';
import { requireAuth, requireAuthOrToken } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import {
  listMedia, listCategories, uploadMedia, uploadMiddleware,
  scanMedia, getMedia, updateMedia, deployMedia,
  streamMedia, downloadMedia, getWaveform, deleteMedia,
} from '../../controllers/mediaLibraryController.js';

const router = Router();
router.use(requireAuth);

router.get('/categories',         adminOrOp, listCategories);
router.get('/',                   adminOrOp, listMedia);
router.get('/:id',                adminOrOp, getMedia);
router.get('/:id/stream',         requireAuthOrToken, streamMedia);
router.get('/:id/download',       requireAuthOrToken, downloadMedia);
router.get('/:id/waveform',       requireAuthOrToken, getWaveform);
router.post('/scan',              adminOnly, scanMedia);
router.post('/upload',            adminOnly, uploadMiddleware, uploadMedia);
router.put('/:id',                adminOnly, updateMedia);
router.post('/:id/deploy',        adminOnly, deployMedia);
router.delete('/:id',             adminOnly, deleteMedia);

export default router;
