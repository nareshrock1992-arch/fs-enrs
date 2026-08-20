import { Router } from 'express';
import { ivrLookup, registerIvrRecording } from '../../controllers/internal/ivrInternalController.js';

const router = Router();

// GET /api/v1/internal/ivr/lookup?number=<e164>
// Called by FreeSWITCH Lua on every inbound call.
// Auth is handled by internalAuth middleware on the parent router.
router.get('/lookup', ivrLookup);

// POST /api/v1/internal/ivr/recording/register
// Called by Lua executor after record_message node completes.
// Assigns the correct tenant_id via emergency_numbers lookup.
router.post('/recording/register', registerIvrRecording);

export default router;
