/**
 * Conference Recording Management routes
 * Mounted at /api/v1/recordings
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrOp } from '../../middleware/rbac.js';
import {
  listRecordings, getRecording,
  streamRecording, downloadRecording, getRecordingWaveform,
  updateRecording, archiveRecording, deleteRecording,
} from '../../controllers/recordingController.js';

const router = Router();
router.use(requireAuth);

router.get('/',                   adminOrOp, listRecordings);
router.get('/:id',                adminOrOp, getRecording);
router.get('/:id/stream',         adminOrOp, streamRecording);
router.get('/:id/download',       adminOrOp, downloadRecording);
router.get('/:id/waveform',       adminOrOp, getRecordingWaveform);
router.put('/:id',                adminOrOp, updateRecording);
router.post('/:id/archive',       adminOrOp, archiveRecording);
router.delete('/:id',             adminOrOp, deleteRecording);

export default router;
