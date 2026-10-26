/**
 * Media Library routes
 * Mounted at /api/v1/media-library
 */

import { Router } from 'express';
import { requireAuth, requireAuthOrToken } from '../../middleware/auth.js';
import { adminOnly, adminOrSuper, canViewMedia } from '../../middleware/rbac.js';
import { requireMediaAccess, issueMediaAccess } from '../../middleware/mediaAccess.js';
import {
  listMedia, listCategories, uploadMedia, uploadMiddleware,
  scanMedia, getMedia, updateMedia, deployMedia,
  streamMedia, downloadMedia, getWaveform, deleteMedia, getMediaReferences,
} from '../../controllers/mediaLibraryController.js';

const router = Router();

// Stream/download accept a scoped, short-lived ?sig= (issued by GET /:id/access,
// see middleware/mediaAccess.js), a Bearer header, or the deprecated ?token=.
// Do NOT add requireAuth here — <audio src> cannot send headers.
// The bytes follow the same role rule as the list (canViewMedia): a role that may
// not see the library may not fetch its audio either, whichever credential is used
// (a signed link carries the issuing user's role).
router.get('/:id/access',         requireAuth, canViewMedia, issueMediaAccess('media'));
router.get('/:id/stream',         requireMediaAccess('media', 'stream'), canViewMedia, streamMedia);
router.get('/:id/download',       requireMediaAccess('media', 'download'), canViewMedia, downloadMedia);
router.get('/:id/waveform',       requireAuthOrToken, canViewMedia, getWaveform);

// All other routes require a full Bearer session.
router.get('/categories',         requireAuth, canViewMedia, listCategories);
router.get('/',                   requireAuth, canViewMedia, listMedia);
router.get('/:id/references',     requireAuth, canViewMedia, getMediaReferences);   // read-only "where used"
router.get('/:id',                requireAuth, canViewMedia, getMedia);
router.post('/scan',              requireAuth, adminOnly, scanMedia);
router.post('/upload',            requireAuth, adminOrSuper, uploadMiddleware, uploadMedia);
router.put('/:id',                requireAuth, adminOnly, updateMedia);
router.post('/:id/deploy',        requireAuth, adminOnly, deployMedia);
router.delete('/:id',             requireAuth, adminOnly, deleteMedia);

export default router;
