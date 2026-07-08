import { Router } from 'express';
import * as ctrl from '../../controllers/internal/ersInternalController.js';

const router = Router();

// Number → config lookup (dial_911_conference.lua first call)
router.get('/lookup', ctrl.ersLookup);

// Incident lifecycle
router.post('/incidents',                  ctrl.ersCreateIncident);
router.post('/incidents/:uuid/complete',   ctrl.ersCompleteIncident);
router.patch('/incidents/:uuid/responder', ctrl.ersUpdateResponder);
router.post('/incidents/:uuid/observer',   ctrl.ersLogObserver);

// Rejoin routes — MUST be before /:uuid to avoid wildcard collision
router.get('/incidents/rejoin',            ctrl.ersRejoinLookup);
router.get('/incidents/open-join',         ctrl.ersOpenJoin);

// Queue poll — Lua calls this every ~3 s while holding caller; joins when ACTIVE
router.get('/incidents/:uuid/status',      ctrl.ersIncidentStatus);

export default router;
