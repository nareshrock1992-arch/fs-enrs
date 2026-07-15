/**
 * Conference Recording Management routes
 * Mounted at /api/v1/recordings
 */

import { Router } from 'express';
import { requireAuth, requireAuthOrToken } from '../../middleware/auth.js';
import { adminOrOp } from '../../middleware/rbac.js';
import {
  listRecordings, getRecording,
  streamRecording, downloadRecording, getRecordingWaveform,
  updateRecording, archiveRecording, deleteRecording,
} from '../../controllers/recordingController.js';

const router = Router();

// List/detail/mutation routes require full auth
router.get('/',                   requireAuth, adminOrOp, listRecordings);
router.get('/:id',                requireAuth, adminOrOp, getRecording);
router.put('/:id',                requireAuth, adminOrOp, updateRecording);
router.post('/:id/archive',       requireAuth, adminOrOp, archiveRecording);
router.delete('/:id',             requireAuth, adminOrOp, deleteRecording);

// Streaming routes accept ?token= for <audio src> compatibility
router.get('/:id/stream',         requireAuthOrToken, streamRecording);
router.get('/:id/download',       requireAuthOrToken, downloadRecording);
router.get('/:id/waveform',       requireAuthOrToken, getRecordingWaveform);

export default router;
