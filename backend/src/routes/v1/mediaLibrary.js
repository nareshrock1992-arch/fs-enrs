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

// Streaming routes accept ?token= for <audio src> compatibility — do NOT add
// requireAuth here; requireAuthOrToken handles both Bearer and ?token= forms.
router.get('/:id/stream',         requireAuthOrToken, streamMedia);
router.get('/:id/download',       requireAuthOrToken, downloadMedia);
router.get('/:id/waveform',       requireAuthOrToken, getWaveform);

// All other routes require a full Bearer session.
router.get('/categories',         requireAuth, adminOrOp, listCategories);
router.get('/',                   requireAuth, adminOrOp, listMedia);
router.get('/:id',                requireAuth, adminOrOp, getMedia);
router.post('/scan',              requireAuth, adminOnly, scanMedia);
router.post('/upload',            requireAuth, adminOnly, uploadMiddleware, uploadMedia);
router.put('/:id',                requireAuth, adminOnly, updateMedia);
router.post('/:id/deploy',        requireAuth, adminOnly, deployMedia);
router.delete('/:id',             requireAuth, adminOnly, deleteMedia);

export default router;
