import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';

// ── Validators ────────────────────────────────────────────────────────────────

const ConferenceRoomRegex = /^[a-z0-9_]{1,64}$/;

const IncidentCreateSchema = z.object({
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

const ResponderUpdateSchema = z.object({
  responder_number: z.string().min(7).max(32),
  status:           z.enum(['JOINED', 'MISSED', 'REJOINED']),
  joined_at:        z.string().datetime({ offset: true }).optional().nullable(),
  role:             z.enum(['primary', 'secondary']).optional(),
});

const ObserverSchema = z.object({
  observer_number: z.string().min(7).max(32),
  joined_via:      z.string().max(32).optional().nullable(),
  joined_at:       z.string().datetime({ offset: true }).optional().nullable(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Resolve responder mobile numbers from an ERS configuration's primary or secondary group
async function resolveResponders(configId, groupField) {
  const { rows } = await query(
    `SELECT DISTINCT r.mobile_number
     FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_responder_groups rg ON rg.id = rgm.group_id
     JOIN ers_configurations ec ON ec.${groupField} = rg.id
     WHERE ec.id = $1
       AND r.deleted_at IS NULL AND r.is_active = true
       AND rg.deleted_at IS NULL AND rg.is_active = true
     ORDER BY r.mobile_number`,
    [configId]
  );
  return rows.map(r => r.mobile_number);
}

// ── ERS Lookup ────────────────────────────────────────────────────────────────

// GET /api/v1/internal/ers/lookup?number=<dest>
export const ersLookup = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ success: false, error: 'number param required' });

  // Resolve via emergency_numbers table — tenant scoped through the number record
  const { rows: [cfg] } = await query(
    `SELECT ec.id AS configuration_id, ec.name,
            ec.retry_count, ec.max_concurrent_conferences,
            ec.queue_enabled, ec.record_conferences,
            ec.conference_room_prefix
     FROM emergency_numbers en
     JOIN ers_configurations ec
       ON ec.id = en.ers_configuration_id
      AND ec.tenant_id = en.tenant_id
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

  const [primaryResponders, secondaryResponders] = await Promise.all([
    resolveResponders(cfg.configuration_id, 'primary_ers_group_id'),
    resolveResponders(cfg.configuration_id, 'secondary_ers_group_id'),
  ]);

  res.json({
    success: true,
    data: {
      configuration_id:         cfg.configuration_id,
      name:                     cfg.name,
      primary_responders:       primaryResponders,
      secondary_responders:     secondaryResponders,
      retry_count:              cfg.retry_count,
      max_concurrent_conferences: cfg.max_concurrent_conferences,
      queue_enabled:            cfg.queue_enabled,
      record_conferences:       cfg.record_conferences,
      conference_room_prefix:   cfg.conference_room_prefix,
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

// POST /api/v1/internal/ers/incidents/:uuid/complete
export const ersCompleteIncident = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = IncidentCompleteSchema.parse(req.body);

  const { rows } = await withTransaction(async (tq) => {
    const { rows: updated } = await tq(
      `UPDATE ers_incidents
       SET status = 'COMPLETED', ended_at = now(),
           recording_path = COALESCE($2, recording_path),
           updated_at = now()
       WHERE incident_uuid = $1 AND deleted_at IS NULL
       RETURNING id, ers_configuration_id`,
      [uuid, d.recording_file]
    );

    if (!updated[0]) return { rows: [] };

    // If queue is enabled, promote the next QUEUED entry to PROCESSING
    const { rows: [queueEntry] } = await tq(
      `SELECT q.id FROM ers_queues q
       JOIN ers_configurations ec ON ec.id = q.ers_configuration_id
       WHERE q.ers_configuration_id = $1
         AND q.status = 'QUEUED'
       ORDER BY q.position ASC LIMIT 1`,
      [updated[0].ers_configuration_id]
    );

    if (queueEntry) {
      await tq(
        `UPDATE ers_queues SET status = 'PROCESSING', updated_at = now()
         WHERE id = $1`,
        [queueEntry.id]
      );
    }

    return { rows: updated };
  });

  if (!rows[0]) return res.status(404).json({ error: 'Incident not found' });

  emitInternal('enrs::ers_incident_ended', {
    incident_uuid: uuid,
    ended_at:      new Date().toISOString(),
  });

  res.json({ ok: true });
});

// ── Update Responder ──────────────────────────────────────────────────────────

// PATCH /api/v1/internal/ers/incidents/:uuid/responder
export const ersUpdateResponder = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = ResponderUpdateSchema.parse(req.body);

  const { rows: [incident] } = await query(
    `SELECT id FROM ers_incidents WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  // Resolve ers_responder_id from mobile number (best-effort)
  const { rows: [responder] } = await query(
    `SELECT id FROM ers_responders
     WHERE mobile_number = $1 AND deleted_at IS NULL LIMIT 1`,
    [d.responder_number]
  );

  await withTransaction(async (tq) => {
    const existing = await tq(
      `SELECT id, rejoin_count FROM ers_incident_responders
       WHERE ers_incident_id = $1 AND mobile_number = $2`,
      [incident.id, d.responder_number]
    );

    if (existing.rows[0]) {
      const newRejoinCount = d.status === 'REJOINED'
        ? existing.rows[0].rejoin_count + 1
        : existing.rows[0].rejoin_count;

      await tq(
        `UPDATE ers_incident_responders
         SET status = $3, joined_at = COALESCE($4, now()),
             rejoin_count = $5, updated_at = now()
         WHERE id = $1 AND ers_incident_id = $2`,
        [existing.rows[0].id, incident.id,
         d.status, d.joined_at, newRejoinCount]
      );
    } else {
      await tq(
        `INSERT INTO ers_incident_responders
           (ers_incident_id, ers_responder_id, mobile_number,
            status, joined_at, joined_via)
         VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6)`,
        [incident.id, responder?.id ?? null, d.responder_number,
         d.status, d.joined_at, d.role ?? 'direct']
      );
    }
  });

  emitInternal('enrs::ers_responder_update', {
    incident_uuid:    uuid,
    responder_number: d.responder_number,
    status:           d.status,
    joined_at:        d.joined_at,
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

  // Find ERS config by rejoin_number (emergency_numbers table OR direct column)
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

  // Find active incident for this config
  const { rows: [incident] } = await query(
    `SELECT id, incident_uuid, conference_room FROM ers_incidents
     WHERE ers_configuration_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [cfg.id]
  );

  if (!incident) return res.json({ authorized: false, reason: 'no_active_incident' });

  // Determine role: check primary group, secondary group, then original caller
  const callerLast9 = caller.replace(/\D/g, '').slice(-9);

  // Is caller a primary responder?
  const { rows: [primaryMatch] } = await query(
    `SELECT r.id FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_configurations ec ON ec.primary_ers_group_id = rgm.group_id
     WHERE ec.id = $1
       AND RIGHT(REGEXP_REPLACE(r.mobile_number, '[^0-9]', '', 'g'), 9) = $2
       AND r.deleted_at IS NULL LIMIT 1`,
    [cfg.id, callerLast9]
  );

  if (primaryMatch) {
    return res.json({
      authorized:    true,
      incident_uuid: incident.incident_uuid,
      conference_room: incident.conference_room,
      role:          'primary',
    });
  }

  // Is caller a secondary responder?
  const { rows: [secondaryMatch] } = await query(
    `SELECT r.id FROM ers_responders r
     JOIN ers_responder_group_members rgm ON rgm.responder_id = r.id
     JOIN ers_configurations ec ON ec.secondary_ers_group_id = rgm.group_id
     WHERE ec.id = $1
       AND RIGHT(REGEXP_REPLACE(r.mobile_number, '[^0-9]', '', 'g'), 9) = $2
       AND r.deleted_at IS NULL LIMIT 1`,
    [cfg.id, callerLast9]
  );

  if (secondaryMatch) {
    return res.json({
      authorized:    true,
      incident_uuid: incident.incident_uuid,
      conference_room: incident.conference_room,
      role:          'secondary',
    });
  }

  // Is caller the original incident initiator?
  const { rows: [initiatorMatch] } = await query(
    `SELECT id FROM ers_incidents
     WHERE id = $1
       AND RIGHT(REGEXP_REPLACE(caller_number, '[^0-9]', '', 'g'), 9) = $2`,
    [incident.id, callerLast9]
  );

  if (initiatorMatch) {
    return res.json({
      authorized:    true,
      incident_uuid: incident.incident_uuid,
      conference_room: incident.conference_room,
      role:          'initiator',
    });
  }

  res.json({ authorized: false, reason: 'not_a_member' });
});

// ── Open-Access Join ──────────────────────────────────────────────────────────

// GET /api/v1/internal/ers/incidents/open-join?number=<n>&caller=<number>
export const ersOpenJoin = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number param required' });

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
export const ersLogObserver = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = ObserverSchema.parse(req.body);

  const { rows: [incident] } = await query(
    `SELECT id FROM ers_incidents WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  await query(
    `INSERT INTO ers_incident_responders
       (ers_incident_id, mobile_number, status, joined_at, joined_via)
     VALUES ($1, $2, 'OBSERVER', COALESCE($3, now()), 'open_access')
     ON CONFLICT DO NOTHING`,
    [incident.id, d.observer_number, d.joined_at]
  );

  emitInternal('enrs::ers_observer_joined', {
    incident_uuid:   uuid,
    observer_number: d.observer_number,
    joined_via:      d.joined_via,
  });

  res.json({ ok: true });
});
