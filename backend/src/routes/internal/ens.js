import { Router } from 'express';
import * as ctrl from '../../controllers/internal/ensInternalController.js';

const router = Router();

// Number → config lookup (blast_call.lua first call)
router.get('/lookup', ctrl.ensLookup);

// Blast state management
router.get('/notifications/queue-status',         ctrl.ensQueueStatus);
router.post('/notifications',                     ctrl.ensCreateNotification);
router.get('/notifications/:uuid/pending-contacts', ctrl.ensPendingContacts);
router.patch('/notifications/:uuid/delivery',     ctrl.ensUpdateDelivery);
router.post('/notifications/:uuid/complete',      ctrl.ensCompleteNotification);

// Callback replay (ENS_retry_playback.lua)
router.get('/callbacks/authorize', ctrl.ensAuthorizeCallback);
router.post('/callbacks',          ctrl.ensLogCallback);

export default router;
