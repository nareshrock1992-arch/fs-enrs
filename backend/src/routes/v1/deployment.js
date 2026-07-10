/**
 * Deployment routes
 *
 * Mounted at /api/v1/deployment
 *
 * Audio Library:
 *   GET    /deployment/audio                — list audio files
 *   GET    /deployment/audio/categories     — list categories
 *   POST   /deployment/audio/upload         — upload audio file
 *   POST   /deployment/audio/:id/deploy     — deploy file to FreeSWITCH
 *   GET    /deployment/audio/:id/stream     — authenticated preview stream
 *   DELETE /deployment/audio/:id            — soft-delete
 *
 * Flow Deployment:
 *   GET    /deployment/flows                — all flows + deployment status
 *   GET    /deployment/flows/:uuid/preview  — what would be deployed
 *   POST   /deployment/flows/:uuid/deploy   — run full deployment pipeline
 *   GET    /deployment/flows/:uuid/history  — deployment history
 *   POST   /deployment/redeploy-all         — regenerate XML + reloadxml for all
 *
 * Diagnostics:
 *   GET    /deployment/diagnostics          — run full diagnostics suite
 *   POST   /deployment/diagnostics/reloadxml — trigger reloadxml via ESL
 *   GET    /deployment/diagnostics/paths    — show configured FS paths
 *   GET    /deployment/diagnostics/esl      — ESL connectivity check
 *   POST   /deployment/diagnostics/disable-legacy-extension — comment out a
 *          conflicting legacy <extension> block flagged by the conflict scan
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import {
  listAudio, listCategories, uploadAudio, audioUploadMiddleware,
  deployAudio, streamAudio, deleteAudio,
  listFlowStatus, previewDeploy, triggerDeploy, deployHistory, triggerRedeployAll,
  getDiagnostics, triggerReloadXml, getPaths, getEslStatus, disableLegacyExtensionRoute,
} from '../../controllers/deploymentController.js';

const router = Router();
router.use(requireAuth);

// ── Audio Library ─────────────────────────────────────────────────────────────

router.get('/audio/categories',    adminOrOp, listCategories);
router.get('/audio',               adminOrOp, listAudio);
router.post('/audio/upload',       adminOnly, audioUploadMiddleware, uploadAudio);
router.post('/audio/:id/deploy',   adminOnly, deployAudio);
router.get('/audio/:id/stream',    adminOrOp, streamAudio);
router.delete('/audio/:id',        adminOnly, deleteAudio);

// ── Flow Deployment ───────────────────────────────────────────────────────────

router.get('/flows',                  adminOrOp, listFlowStatus);
router.get('/flows/:uuid/preview',    adminOrOp, previewDeploy);
router.post('/flows/:uuid/deploy',    adminOnly, triggerDeploy);
router.get('/flows/:uuid/history',    adminOrOp, deployHistory);
router.post('/redeploy-all',          adminOnly, triggerRedeployAll);

// ── Diagnostics ───────────────────────────────────────────────────────────────

router.get('/diagnostics',            adminOrOp, getDiagnostics);
router.post('/diagnostics/reloadxml', adminOnly, triggerReloadXml);
router.get('/diagnostics/paths',      adminOrOp, getPaths);
router.get('/diagnostics/esl',        adminOrOp, getEslStatus);
router.post('/diagnostics/disable-legacy-extension', adminOnly, disableLegacyExtensionRoute);

export default router;
