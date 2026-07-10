import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';

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
       RETURNING id, ers_configuration_id`,
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
      // dequeued_at added to ers_queues by migration 002 B10
      await tq(
        `UPDATE ers_queues
         SET status = 'DEQUEUED', dequeued_at = now(), updated_at = now()
         WHERE id = $1`,
        [queueEntry.id]
      );
      await tq(
        `UPDATE ers_incidents SET status = 'ACTIVE', dequeued_at = now()
         WHERE id = $1`,
        [queueEntry.incident_id]
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
    `SELECT ec.id FROM ers_configurations ec
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

  if (!cfg) return res.json({ authorized: false, reason: 'no_active_incident' });

  const { rows: [incident] } = await query(
    `SELECT id, incident_uuid, conference_room FROM ers_incidents
     WHERE ers_configuration_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [cfg.id]
  );

  if (!incident) return res.json({ authorized: false, reason: 'no_active_incident' });

  const callerLast9 = caller.replace(/\D/g, '').slice(-9);

  // Check primary responders (try ers_responders path, fall back to emergency_contacts)
  const { rows: [primaryMatch] } = await query(
    `SELECT 1
     FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_configurations ec ON ec.primary_ers_group_id = rgm.group_id
     WHERE ec.id = $1
       AND RIGHT(REGEXP_REPLACE(r.mobile_number, '[^0-9]', '', 'g'), 9) = $2
       AND r.deleted_at IS NULL
     LIMIT 1`,
    [cfg.id, callerLast9]
  ).then(async ({ rows }) => {
    if (rows[0]) return rows[0];
    // Fall back to emergency_contacts / primary_group_id
    const { rows: fb } = await query(
      `SELECT 1
       FROM emergency_contacts ec2
       JOIN responder_group_members rgm ON rgm.emergency_contact_id = ec2.id
       JOIN ers_configurations e ON e.primary_group_id = rgm.responder_group_id
       WHERE e.id = $1
         AND RIGHT(REGEXP_REPLACE(ec2.mobile_number, '[^0-9]', '', 'g'), 9) = $2
         AND ec2.deleted_at IS NULL
       LIMIT 1`,
      [cfg.id, callerLast9]
    );
    return fb[0] ?? null;
  });

  if (primaryMatch) {
    return res.json({
      authorized:      true,
      incident_uuid:   incident.incident_uuid,
      conference_room: incident.conference_room,
      role:            'primary',
    });
  }

  // Check secondary responders
  const { rows: [secondaryMatch] } = await query(
    `SELECT 1
     FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_configurations ec ON ec.secondary_ers_group_id = rgm.group_id
     WHERE ec.id = $1
       AND RIGHT(REGEXP_REPLACE(r.mobile_number, '[^0-9]', '', 'g'), 9) = $2
       AND r.deleted_at IS NULL
     LIMIT 1`,
    [cfg.id, callerLast9]
  ).then(async ({ rows }) => {
    if (rows[0]) return rows[0];
    const { rows: fb } = await query(
      `SELECT 1
       FROM emergency_contacts ec2
       JOIN responder_group_members rgm ON rgm.emergency_contact_id = ec2.id
       JOIN ers_configurations e ON e.secondary_group_id = rgm.responder_group_id
       WHERE e.id = $1
         AND RIGHT(REGEXP_REPLACE(ec2.mobile_number, '[^0-9]', '', 'g'), 9) = $2
         AND ec2.deleted_at IS NULL
       LIMIT 1`,
      [cfg.id, callerLast9]
    );
    return fb[0] ?? null;
  });

  if (secondaryMatch) {
    return res.json({
      authorized:      true,
      incident_uuid:   incident.incident_uuid,
      conference_room: incident.conference_room,
      role:            'secondary',
    });
  }

  // Check if caller was the original incident initiator
  const { rows: [initiatorMatch] } = await query(
    `SELECT id FROM ers_incidents
     WHERE id = $1
       AND RIGHT(REGEXP_REPLACE(caller_number, '[^0-9]', '', 'g'), 9) = $2`,
    [incident.id, callerLast9]
  );

  if (initiatorMatch) {
    return res.json({
      authorized:      true,
      incident_uuid:   incident.incident_uuid,
      conference_room: incident.conference_room,
      role:            'initiator',
    });
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
