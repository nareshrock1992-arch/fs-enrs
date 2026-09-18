import { Router } from 'express';
import { ivrLookup, registerIvrRecording } from '../../controllers/internal/ivrInternalController.js';
import { restCall } from '../../controllers/internal/ivrRestController.js';

const router = Router();

// GET /api/v1/internal/ivr/lookup?number=<e164>
// Called by FreeSWITCH Lua on every inbound call.
// Auth is handled by internalAuth middleware on the parent router.
router.get('/lookup', ivrLookup);

// POST /api/v1/internal/ivr/recording/register
// Called by Lua executor after record_message node completes.
// Assigns the correct tenant_id via emergency_numbers lookup.
router.post('/recording/register', registerIvrRecording);

// POST /api/v1/internal/ivr/rest-call
// Backend proxy for the rest_api node: resolves credentials, applies pluggable
// auth (incl. OAuth2 client-credentials), performs the external call under a
// hard timeout, parses + maps the response. Secrets never reach Lua/flow JSON.
router.post('/rest-call', restCall);

export default router;
