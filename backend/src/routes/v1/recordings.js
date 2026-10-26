/**
 * Conference Recording Management routes
 * Mounted at /api/v1/recordings
 */

import { Router } from 'express';
import { requireAuth, requireAuthOrToken } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import { requireMediaAccess, issueMediaAccess } from '../../middleware/mediaAccess.js';
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
// Deletion is admin-only: the UI never offered it to operators, and an operator
// could otherwise remove ERS/ENS evidence through the API. See docs/media-rbac.md.
router.delete('/:id',             requireAuth, adminOnly, deleteRecording);

// Stream/download accept a scoped, short-lived ?sig= (issued by GET /:id/access,
// see middleware/mediaAccess.js), a Bearer header, or the deprecated ?token=.
// The audio follows the same role rule as the list/detail (adminOrOp) for every
// credential type, so a role that cannot open a recording cannot fetch its bytes.
router.get('/:id/access',         requireAuth, adminOrOp, issueMediaAccess('recording'));
router.get('/:id/stream',         requireMediaAccess('recording', 'stream'), adminOrOp, streamRecording);
router.get('/:id/download',       requireMediaAccess('recording', 'download'), adminOrOp, downloadRecording);
router.get('/:id/waveform',       requireAuthOrToken, adminOrOp, getRecordingWaveform);

export default router;
