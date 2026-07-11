import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';
import { getConferenceMemberCount } from '../../services/eslService.js';
import { startRingAll, lookupCallerIdentity } from '../../services/ersRingService.js';

// ── Validators ────────────────────────────────────────────────────────────────

const ConferenceRoomRegex = /^[a-z0-9_]{1,64}$/;

// Exported so scripts/verify-api-contracts.js can statically cross-check
// every field name the generated Lua sends against what this endpoint
// actually accepts, without needing a live server.
export const IncidentCreateSchema = z.object({
  configuration_id: z.number().int().positive(),
  caller_number:    z.string().min(7).max(32),
  caller_name:      z.string().max(128).optional().nullable(),
  conference_room:  z.string().regex(ConferenceRoomRegex, 'Invalid conference_room format'),
  group_type:       z.enum(['primary', 'secondary']),
  recording_path:   z.string().max(512).optional().nullable(),
  status:           z.enum(['ACTIVE', 'QUEUED']).default('ACTIVE'),
});

const IncidentCompleteSchema = z.object({
  recording_file: z.string().max(512).optional().nullable(),
});

// migration 002 B9 expanded CHECK to include REJOINED and OBSERVER
const ResponderUpdateSchema = z.object({
  responder_number: z.string().min(7).max(32),
  status:           z.enum(['JOINED', 'MISSED', 'REJOINED']),
  joined_at:        z.string().datetime({ offset: true }).optional().nullable(),
  joined_via:       z.string().max(32).optional().nullable(),
  role:             z.enum(['primary', 'secondary']).optional(),
});

const ObserverSchema = z.object({
  observer_number: z.string().min(7).max(32),
  joined_via:      z.string().max(32).optional().nullable(),
  joined_at:       z.string().datetime({ offset: true }).optional().nullable(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Resolve responder mobile numbers for a given ERS configuration tier.
//
// Sources (all merged — numbers are deduplicated):
//   1. ers_tier_contacts (migration 010) — individual contacts per tier
//   2. ers_tier_groups   (migration 009) — group memberships per tier
//   3. Legacy ERS-responder paths (backwards compat for old configs)
async function resolveResponders(configId, tier) {
  if (tier !== 'primary' && tier !== 'secondary') return [];

  // Source 1: individual contacts (migration 010)
  const { rows: contactRows } = await query(
    `SELECT ec.mobile_number
     FROM emergency_contacts ec
     JOIN ers_tier_contacts etc ON etc.contact_id = ec.id
     WHERE etc.ers_configuration_id = $1
       AND etc.tier = $2
       AND ec.deleted_at IS NULL AND ec.is_active = true
       AND ec.mobile_number IS NOT NULL`,
    [configId, tier]
  );

  // Source 2: group members (migration 009)
  const { rows: groupRows } = await query(
    `SELECT ec.mobile_number
     FROM emergency_contacts ec
     JOIN responder_group_members rgm ON rgm.emergency_contact_id = ec.id
     JOIN ers_tier_groups etg ON etg.group_id = rgm.responder_group_id
     WHERE etg.ers_configuration_id = $1
       AND etg.tier = $2
       AND ec.deleted_at IS NULL AND ec.is_active = true
       AND ec.mobile_number IS NOT NULL`,
    [configId, tier]
  );

  const merged = new Set([
    ...contactRows.map(r => r.mobile_number),
    ...groupRows.map(r => r.mobile_number),
  ]);

  if (merged.size > 0) return [...merged].sort();

  // Legacy fallback — old configs that used direct group FK columns
  const ersGroupCol  = `${tier}_ers_group_id`;
  const origGroupCol = `${tier}_group_id`;

  const { rows: legacyErs } = await query(
    `SELECT DISTINCT r.mobile_number
     FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_configurations ec ON ec.${ersGroupCol} = rgm.group_id
     WHERE ec.id = $1 AND r.deleted_at IS NULL AND r.is_active = true
     ORDER BY r.mobile_number`,
    [configId]
  ).catch(() => ({ rows: [] }));

  if (legacyErs.length > 0) return legacyErs.map(r => r.mobile_number);

  const { rows: legacyContacts } = await query(
    `SELECT DISTINCT ec.mobile_number
     FROM emergency_contacts ec
     JOIN responder_group_members rgm ON rgm.emergency_contact_id = ec.id
     JOIN ers_configurations e ON e.${origGroupCol} = rgm.responder_group_id
     WHERE e.id = $1 AND ec.deleted_at IS NULL AND ec.is_active = true
     ORDER BY ec.mobile_number`,
    [configId]
  ).catch(() => ({ rows: [] }));

  return legacyContacts.map(r => r.mobile_number);
}

// Resolve emergency_contact_id from a mobile number (last-9-digit fuzzy match).
// emergency_contact_id is NOT NULL on ers_incident_responders so every INSERT
// must supply it. Returns null if no matching active contact found.
async function resolveContactId(mobileNumber) {
  const last9 = String(mobileNumber).replace(/\D/g, '').slice(-9);
  const { rows: [contact] } = await query(
    `SELECT id FROM emergency_contacts
     WHERE RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $1
       AND deleted_at IS NULL AND is_active = true
     LIMIT 1`,
    [last9]
  );
  return contact?.id ?? null;
}

// Resolve ers_responder_id from a mobile number (migration 002 B15 — nullable).
// Returns null if no matching active ERS responder found.
async function resolveResponderId(mobileNumber) {
  const last9 = String(mobileNumber).replace(/\D/g, '').slice(-9);
  const { rows: [responder] } = await query(
    `SELECT id FROM ers_responders
     WHERE RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $1
       AND deleted_at IS NULL AND is_active = true
     LIMIT 1`,
    [last9]
  );
  return responder?.id ?? null;
}

// ── ERS Lookup ────────────────────────────────────────────────────────────────

// GET /api/v1/internal/ers/lookup?number=<dest>
// Returns everything Lua needs to manage a conference incident.
export const ersLookup = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ success: false, error: 'number param required' });

  const { rows: [cfg] } = await query(
    `SELECT
       ec.id AS configuration_id,
       ec.name,
       ec.description,
       ec.max_concurrent_conferences,
       ec.queue_enabled,
       ec.record_conferences,
       ec.conference_room_prefix,
       ec.conference_profile,
       ec.primary_bridge_number,
       ec.secondary_bridge_number,
       ec.queue_hold_audio,
       ec.queue_announcement_audio,
       ec.queue_music_path,
       ec.queue_timeout_sec,
       ec.queue_priority,
       ec.recording_directory,
       ec.retry_ring_count,
       ec.retry_ring_interval,
       ec.allow_rejoin,
       ec.cli_authentication,
       ec.max_conference_duration_min,
       ec.primary_retry_count,
       ec.primary_retry_interval_sec,
       ec.secondary_retry_count,
       ec.secondary_retry_interval_sec,
       ec.pin,
       en.service_name,
       en.organization_id
     FROM emergency_numbers en
     JOIN ers_configurations ec
       ON ec.id = en.ers_configuration_id
      AND ec.deleted_at IS NULL
      AND ec.is_active = true
     WHERE en.number = $1
       AND en.type = 'ERS'
       AND en.deleted_at IS NULL
       AND en.is_active = true
     LIMIT 1`,
    [number]
  );

  if (!cfg) return res.status(404).json({ success: false, error: 'ERS number not found' });

  const [primaryResponders, secondaryResponders, activeResult] = await Promise.all([
    resolveResponders(cfg.configuration_id, 'primary'),
    resolveResponders(cfg.configuration_id, 'secondary'),
    query(
      `SELECT COUNT(*)::INT AS active_count
       FROM ers_incidents
       WHERE ers_configuration_id = $1
         AND status = 'ACTIVE'
         AND deleted_at IS NULL`,
      [cfg.configuration_id]
    ),
  ]);

  const activeConferences = activeResult.rows[0]?.active_count ?? 0;
  const slot              = activeConferences + 1;
  const groupType         = activeConferences === 0 ? 'primary' : 'secondary';
  const canAccept         = activeConferences < cfg.max_concurrent_conferences;

  res.json({
    success: true,
    data: {
      configuration_id:            cfg.configuration_id,
      name:                        cfg.name,
      service_name:                cfg.service_name,
      // Bridge config
      primary_bridge_number:       cfg.primary_bridge_number,
      secondary_bridge_number:     cfg.secondary_bridge_number,
      conference_profile:          cfg.conference_profile || 'default',
      conference_room_prefix:      cfg.conference_room_prefix || 'ers',
      max_concurrent_conferences:  cfg.max_concurrent_conferences,
      max_conference_duration_min: cfg.max_conference_duration_min ?? 0,
      // Responders
      primary_responders:          primaryResponders,
      secondary_responders:        secondaryResponders,
      primary_retry_count:         cfg.primary_retry_count ?? 3,
      primary_retry_interval_sec:  cfg.primary_retry_interval_sec ?? 30,
      secondary_retry_count:       cfg.secondary_retry_count ?? 3,
      secondary_retry_interval_sec: cfg.secondary_retry_interval_sec ?? 30,
      retry_ring_count:            cfg.retry_ring_count ?? 3,
      retry_ring_interval:         cfg.retry_ring_interval ?? 30,
      // Queue
      queue_enabled:               cfg.queue_enabled,
      queue_announcement_audio:    cfg.queue_announcement_audio,
      queue_music_path:            cfg.queue_music_path,
      queue_hold_audio:            cfg.queue_hold_audio,
      queue_timeout_sec:           cfg.queue_timeout_sec ?? 0,
      // Recording
      record_conferences:          cfg.record_conferences,
      recording_directory:         cfg.recording_directory,
      // Auth
      pin_required:                Boolean(cfg.pin),
      allow_rejoin:                cfg.allow_rejoin ?? true,
      cli_authentication:          cfg.cli_authentication ?? false,
      // Slot assignment — Lua uses these directly
      active_conferences:          activeConferences,
      slot,
      group_type:                  groupType,
      can_accept:                  canAccept,
    },
  });
});

// ── Create Incident ───────────────────────────────────────────────────────────

// POST /api/v1/internal/ers/incidents
export const ersCreateIncident = asyncHandler(async (req, res) => {
  const d = IncidentCreateSchema.parse(req.body);

  const { rows: [cfg] } = await query(
    `SELECT id FROM ers_configurations
     WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [d.configuration_id]
  );
  if (!cfg) return res.status(404).json({ error: 'ERS configuration not found' });

  const incidentUuid = uuidv4();

  const { rows: [incident] } = await query(
    `INSERT INTO ers_incidents
       (incident_uuid, ers_configuration_id, status,
        caller_number, caller_name, conference_room,
        group_type, recording_path, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING id, incident_uuid`,
    [incidentUuid, d.configuration_id, d.status,
     d.caller_number, d.caller_name, d.conference_room,
     d.group_type, d.recording_path]
  );

  emitInternal('enrs::ers_incident_created', {
    incident_uuid:    incident.incident_uuid,
    incident_id:      incident.id,
    configuration_id: d.configuration_id,
    caller_number:    d.caller_number,
    conference_room:  d.conference_room,
    group_type:       d.group_type,
    status:           d.status,
  });

  res.status(201).json({
    incident_id:   incident.id,
    incident_uuid: incident.incident_uuid,
  });
});

// ── Complete Incident ─────────────────────────────────────────────────────────

// Shared core used by both the HTTP endpoint (POST .../complete, called by
// exec_ers right after a leg leaves the conference) and the ESL
// conference-destroy reconciliation listener in eslService.js (catches
// orphans from an unclean restart where the per-leg call never ran). Do
// not duplicate the queue-promotion logic anywhere else — always go
// through this function.
export async function completeIncidentCore(incidentUuid, recordingFile) {
  const result = await withTransaction(async (tq) => {
    const { rows: updated } = await tq(
      `UPDATE ers_incidents
       SET status = 'COMPLETED', ended_at = now(),
           recording_path = COALESCE($2, recording_path)
       WHERE incident_uuid = $1 AND deleted_at IS NULL AND status != 'COMPLETED'
       RETURNING id, ers_configuration_id, group_type`,
      [incidentUuid, recordingFile]
    );

    if (!updated[0]) return null;

    // Promote next queued entry — lock the row first to prevent races
    const { rows: [queueEntry] } = await tq(
      `SELECT q.id, q.incident_id FROM ers_queues q
       WHERE q.ers_configuration_id = $1 AND q.status = 'QUEUED'
       ORDER BY q.position ASC LIMIT 1
       FOR UPDATE`,
      [updated[0].ers_configuration_id]
    );

    if (queueEntry) {
      // Assign the freed tier's deterministic room to the promoted incident.
      // The CHECK constraint (migration 019) requires conference_room IS NOT NULL
      // for ACTIVE rows — we must set it here, not just flip the status.
      const freedTier = updated[0].group_type || 'primary';
      const promotedRoom = deterministicRoom(updated[0].ers_configuration_id, freedTier);

      await tq(
        `UPDATE ers_queues
         SET status = 'DEQUEUED', dequeued_at = now(), updated_at = now()
         WHERE id = $1`,
        [queueEntry.id]
      );
      await tq(
        `UPDATE ers_incidents
         SET status = 'ACTIVE', dequeued_at = now(),
             group_type = $2, conference_room = $3
         WHERE id = $1`,
        [queueEntry.incident_id, freedTier, promotedRoom]
      );
    }

    return updated[0];
  });

  if (!result) return null;

  emitInternal('enrs::ers_incident_ended', {
    incident_uuid: incidentUuid,
    ended_at:      new Date().toISOString(),
  });

  return result;
}

// POST /api/v1/internal/ers/incidents/:uuid/complete
export const ersCompleteIncident = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = IncidentCompleteSchema.parse(req.body);

  const result = await completeIncidentCore(uuid, d.recording_file);
  if (!result) return res.status(404).json({ error: 'Incident not found' });

  res.json({ ok: true });
});

// ── Update Responder ──────────────────────────────────────────────────────────

// PATCH /api/v1/internal/ers/incidents/:uuid/responder
//
// migration 002 B9 added REJOINED / OBSERVER statuses and joined_via / rejoin_count
// columns to ers_incident_responders. Use them directly — no mapping needed.
export const ersUpdateResponder = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = ResponderUpdateSchema.parse(req.body);

  const { rows: [incident] } = await query(
    `SELECT id FROM ers_incidents WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  // Resolve both IDs: emergency_contact_id (NOT NULL) and ers_responder_id (nullable)
  const [contactId, responderId] = await Promise.all([
    resolveContactId(d.responder_number),
    resolveResponderId(d.responder_number),
  ]);

  if (!contactId) {
    console.warn(
      `[ersUpdateResponder] No emergency_contact for mobile ${d.responder_number}` +
      ` on incident ${uuid} — responder record skipped`
    );
    return res.json({ ok: true, skipped: true });
  }

  // migration 003 B1-3 adds mobile_number + UNIQUE (ers_incident_id, mobile_number)
  // Use ON CONFLICT upsert so concurrent calls from the same responder are idempotent.
  await query(
    `INSERT INTO ers_incident_responders
       (ers_incident_id, emergency_contact_id, ers_responder_id,
        mobile_number, status, join_time, joined_via)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     ON CONFLICT (ers_incident_id, mobile_number) DO UPDATE SET
       status           = EXCLUDED.status,
       join_time        = COALESCE(EXCLUDED.join_time, ers_incident_responders.join_time),
       joined_via       = COALESCE(EXCLUDED.joined_via, ers_incident_responders.joined_via),
       rejoin_count     = CASE WHEN EXCLUDED.status = 'REJOINED'
                               THEN ers_incident_responders.rejoin_count + 1
                               ELSE ers_incident_responders.rejoin_count END,
       ers_responder_id = COALESCE(EXCLUDED.ers_responder_id, ers_incident_responders.ers_responder_id)`,
    [
      incident.id,
      contactId,
      responderId,
      d.responder_number,
      d.status,
      d.joined_at ?? null,
      d.joined_via ?? null,
    ]
  );

  emitInternal('enrs::ers_responder_update', {
    incident_uuid:    uuid,
    responder_number: d.responder_number,
    status:           d.status,
    joined_at:        d.joined_at,
    joined_via:       d.joined_via,
    role:             d.role,
  });

  res.json({ ok: true });
});

// ── Rejoin Lookup ─────────────────────────────────────────────────────────────

// GET /api/v1/internal/ers/incidents/rejoin?rejoin_number=<n>&caller=<number>
export const ersRejoinLookup = asyncHandler(async (req, res) => {
  const rejoinNumber = String(req.query.rejoin_number || '').trim();
  const caller       = String(req.query.caller        || '').trim();

  if (!rejoinNumber || !caller) {
    return res.status(400).json({ error: 'rejoin_number and caller params required' });
  }

  // rejoin_number is a direct column on ers_configurations (migration 002 B7).
  // Also check emergency_numbers with type='REJOIN' (migration 002 B14) as fallback.
  const { rows: [cfg] } = await query(
    `SELECT ec.id, ec.rejoin_open_access FROM ers_configurations ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND (
         ec.rejoin_number = $1
         OR ec.id IN (
           SELECT ers_configuration_id FROM emergency_numbers
           WHERE number = $1 AND type = 'REJOIN'
             AND deleted_at IS NULL AND is_active = true
         )
       )
     LIMIT 1`,
    [rejoinNumber]
  );

  if (!cfg) return res.json({ authorized: false, reason: 'no_config' });

  // Use deterministic room name — if the room has live members, there is
  // an active conference. Do NOT rely on incident status column.
  // Check primary tier first, then secondary.
  let activeRoom = null;
  let activeTier = null;
  for (const tier of ['primary', 'secondary']) {
    const room = deterministicRoom(cfg.id, tier);
    const { rows: [inc] } = await query(
      `SELECT incident_uuid FROM ers_incidents
       WHERE ers_configuration_id = $1 AND group_type = $2
         AND deleted_at IS NULL
         AND started_at > now() - interval '24 hours'
       ORDER BY started_at DESC LIMIT 1`,
      [cfg.id, tier]
    );
    if (inc) {
      const members = await getConferenceMemberCount(room);
      if (members > 0) { activeRoom = room; activeTier = tier; break; }
    }
  }

  if (!activeRoom) return res.json({ authorized: false, reason: 'no_active_incident' });

  // rejoin_open_access: when true, any caller may rejoin — used for
  // designated observer lines. Default is secure: only configured tier contacts.
  if (cfg.rejoin_open_access) {
    return res.json({ authorized: true, conference_room: activeRoom, role: 'observer' });
  }

  const callerLast9 = caller.replace(/\D/g, '').slice(-9);

  // Check membership via new tier tables first (ers_tier_contacts, ers_tier_groups),
  // then fall back to legacy group FK columns for old configs.
  const { rows: [tierMatch] } = await query(
    `SELECT 1
     FROM emergency_contacts ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND RIGHT(REGEXP_REPLACE(COALESCE(ec.mobile_number, ec.extension_number, ''), '[^0-9]', '', 'g'), 9) = $1
       AND (
         ec.id IN (
           SELECT contact_id FROM ers_tier_contacts
           WHERE ers_configuration_id = $2
         )
         OR ec.id IN (
           SELECT rgm.emergency_contact_id
           FROM responder_group_members rgm
           JOIN ers_tier_groups etg ON etg.group_id = rgm.responder_group_id
           WHERE etg.ers_configuration_id = $2
         )
       )
     LIMIT 1`,
    [callerLast9, cfg.id]
  );

  if (tierMatch) {
    return res.json({ authorized: true, conference_room: activeRoom, role: activeTier });
  }

  // Check if caller was the original incident initiator (fallback)
  const { rows: [initiatorMatch] } = await query(
    `SELECT 1 FROM ers_incidents
     WHERE ers_configuration_id = $1
       AND RIGHT(REGEXP_REPLACE(caller_number, '[^0-9]', '', 'g'), 9) = $2
       AND started_at > now() - interval '24 hours'
       AND deleted_at IS NULL
     LIMIT 1`,
    [cfg.id, callerLast9]
  );

  if (initiatorMatch) {
    return res.json({ authorized: true, conference_room: activeRoom, role: 'initiator' });
  }

  res.json({ authorized: false, reason: 'not_a_member' });
});

// ── Open-Access Join ──────────────────────────────────────────────────────────

// GET /api/v1/internal/ers/incidents/open-join?number=<n>
export const ersOpenJoin = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number param required' });

  // open_access_number is a direct column on ers_configurations (migration 002 B7).
  // Also check emergency_numbers with type='OPEN_ACCESS' (migration 002 B14) as fallback.
  const { rows: [cfg] } = await query(
    `SELECT ec.id FROM ers_configurations ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND (
         ec.open_access_number = $1
         OR ec.id IN (
           SELECT ers_configuration_id FROM emergency_numbers
           WHERE number = $1 AND type = 'OPEN_ACCESS'
             AND deleted_at IS NULL AND is_active = true
         )
       )
     LIMIT 1`,
    [number]
  );

  if (!cfg) {
    return res.status(404).json({ conference_room: null, reason: 'no_active_incident' });
  }

  const { rows: [incident] } = await query(
    `SELECT incident_uuid, conference_room FROM ers_incidents
     WHERE ers_configuration_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [cfg.id]
  );

  if (!incident) {
    return res.status(404).json({ conference_room: null, reason: 'no_active_incident' });
  }

  res.json({
    incident_uuid:   incident.incident_uuid,
    conference_room: incident.conference_room,
  });
});

// ── Log Observer ──────────────────────────────────────────────────────────────

// POST /api/v1/internal/ers/incidents/:uuid/observer
//
// migration 002 B9 added OBSERVER as a valid status — use it directly.
// joined_via column also added by B9.
export const ersLogObserver = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = ObserverSchema.parse(req.body);

  const { rows: [incident] } = await query(
    `SELECT id FROM ers_incidents WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const [contactId, responderId] = await Promise.all([
    resolveContactId(d.observer_number),
    resolveResponderId(d.observer_number),
  ]);

  if (contactId) {
    // ON CONFLICT on (ers_incident_id, mobile_number) — idempotent if observer calls twice
    await query(
      `INSERT INTO ers_incident_responders
         (ers_incident_id, emergency_contact_id, ers_responder_id,
          mobile_number, status, join_time, joined_via)
       VALUES ($1, $2, $3, $4, 'OBSERVER', COALESCE($5, now()), $6)
       ON CONFLICT (ers_incident_id, mobile_number) DO NOTHING`,
      [incident.id, contactId, responderId, d.observer_number, d.joined_at, d.joined_via]
    );
  } else {
    console.warn(
      `[ersLogObserver] No emergency_contact for mobile ${d.observer_number}` +
      ` on incident ${uuid} — observer record skipped`
    );
  }

  emitInternal('enrs::ers_observer_joined', {
    incident_uuid:   uuid,
    observer_number: d.observer_number,
    joined_via:      d.joined_via,
  });

  res.json({ ok: true });
});

// ── Incident Status (queue poll) ──────────────────────────────────────────────

// GET /api/v1/internal/ers/incidents/:uuid/status
// Lua calls this every ~3 s while holding a queued caller.
// When status flips from QUEUED → ACTIVE, Lua joins the conference room.
export const ersIncidentStatus = asyncHandler(async (req, res) => {
  const { uuid } = req.params;

  const { rows: [incident] } = await query(
    `SELECT status, conference_room, group_type, started_at, dequeued_at
     FROM ers_incidents
     WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );

  if (!incident) return res.status(404).json({ success: false, error: 'Incident not found' });

  res.json({
    success:         true,
    status:          incident.status,   // QUEUED | ACTIVE | COMPLETED
    conference_room: incident.conference_room,
    group_type:      incident.group_type,
    dequeued_at:     incident.dequeued_at,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — 3-scenario emergency flow endpoints
// ═══════════════════════════════════════════════════════════════════════════

// Deterministic conference room name — stable across backend restarts and
// calls. Replaces the prior timestamp-based name which made rejoin impossible
// and caused tierLiveStatus to scan DB rows for the room name.
// Format: ers_cfg<configId>_primary | ers_cfg<configId>_secondary
export function deterministicRoom(configId, tier) {
  return `ers_cfg${configId}_${tier}`;
}

// Strict tier occupancy: a tier is FREE only when LIVE FreeSWITCH member
// count == 0. Never infers from ers_incidents.status — the DB row only
// reflects the most recent /complete call, not real room state (a room can
// have live members while its row says COMPLETED, and a room can be empty
// while its row says ACTIVE after a crash). With deterministic room names
// we can check the room directly without needing the DB row at all.
async function tierLiveStatus(configId, tier) {
  const room = deterministicRoom(configId, tier);
  const liveMembers = await getConferenceMemberCount(room);

  if (liveMembers === 0) {
    return { tier, occupied: false, live_members: 0, incident_uuid: null, conference_room: room };
  }

  // Room has live members — look up the incident for its UUID (needed by
  // the ring-all rejoin path to populate incident_participants and return
  // a UUID to Lua). Status column is irrelevant here; only member_count matters.
  const { rows: [incident] } = await query(
    `SELECT incident_uuid FROM ers_incidents
     WHERE ers_configuration_id = $1 AND group_type = $2
       AND deleted_at IS NULL
       AND started_at > now() - interval '24 hours'
     ORDER BY started_at DESC LIMIT 1`,
    [configId, tier]
  );

  return {
    tier,
    occupied:        true,
    live_members:    liveMembers,
    incident_uuid:   incident?.incident_uuid ?? null,
    conference_room: room,
  };
}

// GET /api/v1/internal/ers/tier-status?configuration_id=X
export const ersTierStatus = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  if (!configId) return res.status(400).json({ success: false, error: 'configuration_id required' });

  const [primary, secondary] = await Promise.all([
    tierLiveStatus(configId, 'primary'),
    tierLiveStatus(configId, 'secondary'),
  ]);

  res.json({ success: true, primary, secondary });
});

// POST /api/v1/internal/ers/ring-all
// Called by the ers_ring_all Lua node. Behavior:
//   - If this tier already has a LIVE-occupied room (member count > 0),
//     do NOT re-ring everyone — return the existing room so the caller
//     bridges straight in (the rejoin path: a dropped responder or the
//     initiator redialing joins the SAME still-active conference).
//   - Otherwise create a fresh incident + room and start the background
//     ring-all loop (simultaneous bgapi originates, continuous re-ring,
//     recording on first join, caller identity passthrough).
// Exported for scripts/verify-api-contracts.js (same as IncidentCreateSchema).
export const RingAllSchema = z.object({
  configuration_id: z.number().int().positive(),
  tier:             z.enum(['primary', 'secondary']),
  caller_number:    z.string().min(7).max(32),
  caller_name:      z.string().max(128).optional().nullable(),
});

export const ersRingAll = asyncHandler(async (req, res) => {
  const d = RingAllSchema.parse(req.body);

  const { rows: [cfg] } = await query(
    `SELECT id, tenant_id, ring_timeout_seconds FROM ers_configurations
     WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [d.configuration_id]
  );
  if (!cfg) return res.status(404).json({ success: false, error: 'ERS configuration not found' });

  // Rejoin path — live occupancy check, never status alone.
  const live = await tierLiveStatus(d.configuration_id, d.tier);
  if (live.occupied) {
    const identity = await lookupCallerIdentity(d.caller_number);
    if (live.incident_uuid) {
      await query(
        `INSERT INTO ers_incident_participants (incident_id, contact_id, raw_number, role, joined_at)
         SELECT i.id, NULL, $2, 'responder', now()
         FROM ers_incidents i WHERE i.incident_uuid = $1`,
        [live.incident_uuid, d.caller_number]
      ).catch(() => {});
    }
    return res.json({
      success:         true,
      rejoin:          true,
      incident_uuid:   live.incident_uuid,
      conference_room: live.conference_room,
      caller_name:     identity.name,
    });
  }

  // Pre-flight: verify at least one responder is configured before creating
  // an incident. Zero responders means the caller would join a silent empty
  // conference — instead return a clear error so the Lua node plays a
  // fallback announcement and doesn't fail silently.
  const { rows: [responderCount] } = await query(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT 1 FROM emergency_contacts ec
       JOIN ers_tier_contacts etc ON etc.contact_id = ec.id
       WHERE etc.ers_configuration_id = $1 AND etc.tier = $2
         AND ec.deleted_at IS NULL AND ec.is_active = true
       UNION ALL
       SELECT 1 FROM emergency_contacts ec
       JOIN responder_group_members rgm ON rgm.emergency_contact_id = ec.id
       JOIN ers_tier_groups etg ON etg.group_id = rgm.responder_group_id
       WHERE etg.ers_configuration_id = $1 AND etg.tier = $2
         AND ec.deleted_at IS NULL AND ec.is_active = true
     ) sub`,
    [d.configuration_id, d.tier]
  );

  if (parseInt(responderCount.cnt, 10) === 0) {
    console.error(
      `[ers-ring-all] ERR: no responders found for config=${d.configuration_id} tier=${d.tier}` +
      ` — refusing to create conference`
    );
    return res.status(422).json({
      success: false,
      error:   'No responders configured for this tier',
      reason:  'no_responders',
    });
  }

  // Fresh incident — deterministic room name (stable across restarts)
  const incidentUuid = uuidv4();
  const room = deterministicRoom(d.configuration_id, d.tier);

  const { rows: [tierGroup] } = await query(
    `SELECT id FROM ers_tier_groups WHERE ers_configuration_id = $1 AND tier = $2 LIMIT 1`,
    [d.configuration_id, d.tier]
  );

  const { rows: [incident] } = await query(
    `INSERT INTO ers_incidents
       (incident_uuid, ers_configuration_id, tier_group_id, status,
        caller_number, caller_name, conference_room, group_type, started_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, now())
     RETURNING id, incident_uuid`,
    [incidentUuid, d.configuration_id, tierGroup?.id ?? null,
     d.caller_number, d.caller_name ?? null, room, d.tier]
  );

  await query(
    `INSERT INTO ers_incident_participants (incident_id, raw_number, role, joined_at)
     VALUES ($1, $2, 'initiator', now())`,
    [incident.id, d.caller_number]
  ).catch(() => {});

  startRingAll({
    incidentId:         incident.id,
    incidentUuid:       incident.incident_uuid,
    configId:           d.configuration_id,
    tier:               d.tier,
    room,
    tenantId:           cfg.tenant_id,
    callerNumber:       d.caller_number,
    ringTimeoutSeconds: cfg.ring_timeout_seconds,
  });

  emitInternal('enrs::ers_incident_created', {
    incident_uuid:    incident.incident_uuid,
    incident_id:      incident.id,
    configuration_id: d.configuration_id,
    caller_number:    d.caller_number,
    conference_room:  room,
    group_type:       d.tier,
    status:           'ACTIVE',
  });

  res.status(201).json({
    success:         true,
    rejoin:          false,
    incident_uuid:   incident.incident_uuid,
    conference_room: room,
  });
});

// GET /api/v1/internal/ers/playback/authorize?configuration_id=X&caller=N
// The UUUU authorized-playback line (ens_playback_gate node). Message is
// valid for 24h from its recording START (per spec). Every attempt —
// allowed or rejected — is logged to audit_logs for the report.
export const ersPlaybackAuthorize = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  const caller   = String(req.query.caller || '').trim();
  if (!configId || !caller) {
    return res.status(400).json({ success: false, error: 'configuration_id and caller required' });
  }

  async function logAttempt(outcome, detail) {
    await query(
      `INSERT INTO audit_logs (action, entity_type, details)
       VALUES ('ers_playback_attempt', 'ers_playback_line', $1)`,
      [JSON.stringify({ configuration_id: configId, caller, outcome, detail })]
    ).catch(() => {});
  }

  const { rows: [line] } = await query(
    `SELECT * FROM ers_playback_lines
     WHERE ers_configuration_id = $1 AND is_active = true AND deleted_at IS NULL
     LIMIT 1`,
    [configId]
  );
  if (!line) {
    await logAttempt('rejected', 'no playback line configured');
    return res.json({ authorized: false, reason: 'not_configured' });
  }

  const callerLast9 = caller.replace(/\D/g, '').slice(-9);
  const allowed = (line.authorized_callers || []).some(n =>
    String(n).replace(/\D/g, '').slice(-9) === callerLast9
  );
  if (!allowed) {
    await logAttempt('rejected', 'caller not in authorized list');
    return res.json({ authorized: false, reason: 'not_authorized' });
  }

  // Message source: the explicitly-set line recording if fresh, otherwise
  // the newest ERS incident recording for this config within the window.
  const WINDOW = "interval '24 hours'";
  let recording = null;
  if (line.message_recording_path && line.message_started_at) {
    const { rows: [fresh] } = await query(
      `SELECT (message_started_at > now() - ${WINDOW}) AS fresh
       FROM ers_playback_lines WHERE id = $1`,
      [line.id]
    );
    if (fresh?.fresh) recording = line.message_recording_path;
  }
  if (!recording) {
    const { rows: [inc] } = await query(
      `SELECT recording_path FROM ers_incidents
       WHERE ers_configuration_id = $1 AND recording_path IS NOT NULL
         AND started_at > now() - ${WINDOW} AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [configId]
    );
    recording = inc?.recording_path || null;
  }

  if (!recording) {
    await logAttempt('no_message', 'authorized but no recording within 24h window');
    return res.json({ authorized: true, reason: 'no_active_message', recording_file: null });
  }

  await logAttempt('played', recording);
  res.json({ authorized: true, recording_file: recording });
});

// POST /api/v1/internal/ers/overflow/enqueue
// Caller C's path: both tiers live-occupied. Creates a QUEUED incident +
// ers_queues row (position = end of queue) and returns queue_id for the
// Lua poll loop.
// Exported for scripts/verify-api-contracts.js (same as IncidentCreateSchema).
export const OverflowEnqueueSchema = z.object({
  configuration_id:   z.number().int().positive(),
  caller_number:      z.string().min(7).max(32),
  caller_name:        z.string().max(128).optional().nullable(),
  destination_number: z.string().max(32).optional().nullable(),
});

export const ersOverflowEnqueue = asyncHandler(async (req, res) => {
  const d = OverflowEnqueueSchema.parse(req.body);

  const result = await withTransaction(async tq => {
    const incidentUuid = uuidv4();
    const { rows: [incident] } = await tq(
      `INSERT INTO ers_incidents
         (incident_uuid, ers_configuration_id, status, caller_number, caller_name,
          group_type, started_at, queued_at)
       VALUES ($1, $2, 'QUEUED', $3, $4, 'primary', now(), now())
       RETURNING id, incident_uuid`,
      [incidentUuid, d.configuration_id, d.caller_number, d.caller_name ?? null]
    );

    const { rows: [{ next_pos }] } = await tq(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
       FROM ers_queues WHERE ers_configuration_id = $1 AND status = 'QUEUED'`,
      [d.configuration_id]
    );

    const { rows: [queueRow] } = await tq(
      `INSERT INTO ers_queues
         (ers_configuration_id, incident_id, position, status,
          caller_number, caller_name, destination_number)
       VALUES ($1, $2, $3, 'QUEUED', $4, $5, $6)
       RETURNING id, position`,
      [d.configuration_id, incident.id, next_pos,
       d.caller_number, d.caller_name ?? null, d.destination_number ?? null]
    );

    return { incident, queueRow };
  });

  emitInternal('enrs::ers_queue_changed', {
    configuration_id: d.configuration_id,
    action:           'enqueued',
    queue_id:         result.queueRow.id,
    position:         result.queueRow.position,
  });

  res.status(201).json({
    success:       true,
    queue_id:      result.queueRow.id,
    position:      result.queueRow.position,
    incident_uuid: result.incident.incident_uuid,
  });
});

// POST /api/v1/internal/ers/overflow/cancel
// Lua overflow_wait loop calls this on session hangup so the queue row is
// cleared immediately — without this, the row stays QUEUED until the 2-hour
// safety sweep, and the dashboard shows a phantom queue entry.
export const ersOverflowCancel = asyncHandler(async (req, res) => {
  const queueId = parseInt(req.body.queue_id, 10);
  if (!queueId) return res.status(400).json({ success: false, error: 'queue_id required' });

  await withTransaction(async tq => {
    const { rows: [entry] } = await tq(
      `SELECT id, incident_id, status FROM ers_queues WHERE id = $1 FOR UPDATE`,
      [queueId]
    );
    if (!entry || entry.status !== 'QUEUED') return; // already dequeued/cancelled — idempotent

    await tq(
      `UPDATE ers_queues SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [entry.id]
    );
    // Mark the linked incident COMPLETED so it doesn't linger as QUEUED
    await tq(
      `UPDATE ers_incidents SET status = 'COMPLETED', ended_at = now()
       WHERE id = $1 AND status = 'QUEUED'`,
      [entry.incident_id]
    );
  });

  emitInternal('enrs::ers_queue_changed', { action: 'cancelled', queue_id: queueId });
  res.json({ success: true });
});

// GET /api/v1/internal/ers/overflow/poll?queue_id=X
// Lua polls this every few seconds while playing hold music. When a tier's
// LIVE member count reaches zero (Level 1 checked first — priority on
// simultaneous free-up), the head-of-queue caller is promoted: its queue
// row is dequeued, its incident flips ACTIVE with a fresh room, and the
// ring-all loop starts for the freed tier. Non-head callers just get
// their current position back.
export const ersOverflowPoll = asyncHandler(async (req, res) => {
  const queueId = parseInt(req.query.queue_id, 10);
  if (!queueId) return res.status(400).json({ success: false, error: 'queue_id required' });

  const { rows: [entry] } = await query(
    `SELECT q.*, i.incident_uuid
     FROM ers_queues q
     JOIN ers_incidents i ON i.id = q.incident_id
     WHERE q.id = $1`,
    [queueId]
  );
  if (!entry) return res.status(404).json({ success: false, error: 'Queue entry not found' });

  if (entry.status === 'DEQUEUED') {
    // Already promoted (possibly by a competing poll) — hand back the room.
    const { rows: [inc] } = await query(
      `SELECT incident_uuid, conference_room FROM ers_incidents WHERE id = $1`,
      [entry.incident_id]
    );
    return res.json({ success: true, ready: true, conference_room: inc.conference_room, incident_uuid: inc.incident_uuid });
  }
  if (entry.status === 'CANCELLED') {
    return res.json({ success: true, ready: false, cancelled: true });
  }

  // Only the head of the queue may be promoted.
  const { rows: [head] } = await query(
    `SELECT id FROM ers_queues
     WHERE ers_configuration_id = $1 AND status = 'QUEUED'
     ORDER BY position ASC LIMIT 1`,
    [entry.ers_configuration_id]
  );
  if (!head || head.id !== entry.id) {
    return res.json({ success: true, ready: false, position: entry.position });
  }

  // Level 1 first (priority on simultaneous free-up), then Level 2 —
  // judged by LIVE member count, never incident status.
  const [primary, secondary] = await Promise.all([
    tierLiveStatus(entry.ers_configuration_id, 'primary'),
    tierLiveStatus(entry.ers_configuration_id, 'secondary'),
  ]);
  const freedTier = !primary.occupied ? 'primary' : (!secondary.occupied ? 'secondary' : null);

  if (!freedTier) {
    return res.json({ success: true, ready: false, position: entry.position });
  }

  // Promote — transactional, FOR UPDATE guard against a concurrent poll
  // promoting the same entry twice.
  const { rows: [cfg] } = await query(
    `SELECT tenant_id, ring_timeout_seconds FROM ers_configurations WHERE id = $1`,
    [entry.ers_configuration_id]
  );

  const room = deterministicRoom(entry.ers_configuration_id, freedTier);

  const promoted = await withTransaction(async tq => {
    const { rows: [locked] } = await tq(
      `SELECT id, status FROM ers_queues WHERE id = $1 FOR UPDATE`,
      [entry.id]
    );
    if (!locked || locked.status !== 'QUEUED') return null;

    await tq(
      `UPDATE ers_queues SET status = 'DEQUEUED', dequeued_at = now(), updated_at = now() WHERE id = $1`,
      [entry.id]
    );
    const { rows: [inc] } = await tq(
      `UPDATE ers_incidents
       SET status = 'ACTIVE', group_type = $2, conference_room = $3, dequeued_at = now()
       WHERE id = $1
       RETURNING id, incident_uuid`,
      [entry.incident_id, freedTier, room]
    );
    return inc;
  });

  if (!promoted) {
    return res.json({ success: true, ready: false, position: entry.position });
  }

  startRingAll({
    incidentId:         promoted.id,
    incidentUuid:       promoted.incident_uuid,
    configId:           entry.ers_configuration_id,
    tier:               freedTier,
    room,
    tenantId:           cfg.tenant_id,
    callerNumber:       entry.caller_number,
    ringTimeoutSeconds: cfg.ring_timeout_seconds,
  });

  emitInternal('enrs::ers_queue_changed', {
    configuration_id: entry.ers_configuration_id,
    action:           'promoted',
    queue_id:         entry.id,
    tier:             freedTier,
  });

  res.json({
    success:         true,
    ready:           true,
    tier:            freedTier,
    conference_room: room,
    incident_uuid:   promoted.incident_uuid,
  });
});
