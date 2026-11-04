import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrSuper, superAdminOnly } from '../../middleware/rbac.js';
import { requireConferenceAccess, requireMemberId, auditConferenceAction } from '../../middleware/conferenceAccess.js';
import {
  getConferences,
  getStatus,
  lockConference,
  unlockConference,
  startRecording,
  stopRecording,
  playAudio,
  sayText,
  inviteParticipant,
  terminateConference,
  muteMember,
  unmuteMember,
  kickMember,
  deafMember,
  undeafMember,
  setVolume,
  setEnergy,
  setFloor,
  transferMember,
  promoteMember,
  debugConfSync,
} from '../../controllers/monitoringController.js';

const router = Router();

router.use(requireAuth);

// Read-only (all authenticated users)
router.get('/conferences', getConferences);
router.get('/status', getStatus);
// Every tenant's rooms in one response: platform administrators only.
router.get('/debug/conf-sync', superAdminOnly, debugConfSync);

// Tenant ownership + input checks for every control route below.
router.use('/conferences/:room', requireConferenceAccess, auditConferenceAction);
router.use('/conferences/:room/members/:memberId', requireMemberId);

// Conference-level controls (supervisors+)
router.post('/conferences/:room/lock', adminOrSuper, lockConference);
router.post('/conferences/:room/unlock', adminOrSuper, unlockConference);
router.post('/conferences/:room/record/start', adminOrSuper, startRecording);
router.post('/conferences/:room/record/stop', adminOrSuper, stopRecording);
router.post('/conferences/:room/play', adminOrSuper, playAudio);
router.post('/conferences/:room/say', adminOrSuper, sayText);
router.post('/conferences/:room/invite', adminOrSuper, inviteParticipant);
router.delete('/conferences/:room', adminOrSuper, terminateConference);

// Member-level controls (supervisors+)
router.post('/conferences/:room/members/:memberId/mute', adminOrSuper, muteMember);
router.post('/conferences/:room/members/:memberId/unmute', adminOrSuper, unmuteMember);
router.delete('/conferences/:room/members/:memberId', adminOrSuper, kickMember);
router.post('/conferences/:room/members/:memberId/deaf', adminOrSuper, deafMember);
router.post('/conferences/:room/members/:memberId/undeaf', adminOrSuper, undeafMember);
router.post('/conferences/:room/members/:memberId/volume', adminOrSuper, setVolume);
router.post('/conferences/:room/members/:memberId/energy', adminOrSuper, setEnergy);
router.post('/conferences/:room/members/:memberId/floor', adminOrSuper, setFloor);
router.post('/conferences/:room/members/:memberId/transfer', adminOrSuper, transferMember);
router.post('/conferences/:room/members/:memberId/moderator', adminOrSuper, promoteMember);

export default router;
