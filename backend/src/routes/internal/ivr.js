import { Router } from 'express';
import { ivrLookup } from '../../controllers/internal/ivrInternalController.js';

const router = Router();

// GET /api/v1/internal/ivr/lookup?number=<e164>
// Called by FreeSWITCH Lua on every inbound call.
// Auth is handled by internalAuth middleware on the parent router.
router.get('/lookup', ivrLookup);

export default router;
