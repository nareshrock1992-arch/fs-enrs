import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const str    = (max) => z.string().max(max).optional().nullable();
const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const boolDef = (def) => z.boolean().default(def);
const intDef  = (def, min = 0, max = 9999) => z.number().int().min(min).max(max).default(def);

const ErsConfigSchema = z.object({
  organization_id:              z.number().int().positive(),
  name:                         z.string().min(1).max(128),
  description:                  emptyToNull,

  // Bridge numbers (FreeSWITCH conference bridge extensions)
  primary_bridge_number:        emptyToNull,
  secondary_bridge_number:      emptyToNull,
  conference_profile:           z.string().max(64).default('default'),

  // Concurrency / duration
  max_concurrent_conferences:   intDef(2, 1, 10),
  max_conference_duration_min:  intDef(0),              // 0 = unlimited

  // Queue
  queue_enabled:                boolDef(true),
  queue_announcement_audio:     emptyToNull,
  queue_music_path:             emptyToNull,
  queue_timeout_sec:            intDef(0),              // 0 = unlimited
  queue_priority:               intDef(5, 1, 10),
  queue_hold_audio:             emptyToNull,            // legacy compat

  // Recording
  record_conferences:           boolDef(false),
  recording_directory:          emptyToNull,

  // Retry
  retry_ring_count:             intDef(3),
  retry_ring_interval:          intDef(30),

  // Auth / access
  pin:                          emptyToNull,
  allow_rejoin:                 boolDef(true),
  cli_authentication:           boolDef(false),

  // Tier-level retry settings
  primary_retry_count:          intDef(3),
  primary_retry_interval_sec:   intDef(30),
  secondary_retry_count:        intDef(3),
  secondary_retry_interval_sec: intDef(30),

  // Tier group / contact IDs (multi-select)
  primary_group_ids:            z.array(z.number().int().positive()).default([]),
  secondary_group_ids:          z.array(z.number().int().positive()).default([]),
  primary_contact_ids:          z.array(z.number().int().positive()).default([]),
  secondary_contact_ids:        z.array(z.number().int().positive()).default([]),

  is_active: boolDef(true),
});

// ── Tier group helpers ────────────────────────────────────────────────────────

async function syncTierGroups(configId, tier, groupIds) {
  await query(`DELETE FROM ers_tier_groups WHERE ers_configuration_id = $1 AND tier = $2`, [configId, tier]);
  for (const gid of groupIds) {
    await query(
      `INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [configId, tier, gid]
    );
  }
}

async function syncTierContacts(configId, tier, contactIds) {
  await query(`DELETE FROM ers_tier_contacts WHERE ers_configuration_id = $1 AND tier = $2`, [configId, tier]);
  for (const cid of contactIds) {
    await query(
      `INSERT INTO ers_tier_contacts (ers_configuration_id, tier, contact_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [configId, tier, cid]
    );
  }
}

async function loadTierData(configId) {
  const [{ rows: gRows }, { rows: cRows }] = await Promise.all([
    query(
      `SELECT etg.tier, rg.id AS group_id, rg.name AS group_name,
              (SELECT COUNT(*) FROM responder_group_members
               WHERE responder_group_id = rg.id)::INT AS member_count
       FROM ers_tier_groups etg
       JOIN responder_groups rg ON rg.id = etg.group_id
       WHERE etg.ers_configuration_id = $1
       ORDER BY etg.tier, rg.name`,
      [configId]
    ),
    query(
      `SELECT etc.tier, c.id AS contact_id,
              c.first_name, c.last_name, c.mobile_number, c.role,
              etc.priority
       FROM ers_tier_contacts etc
       JOIN emergency_contacts c ON c.id = etc.contact_id
       WHERE etc.ers_configuration_id = $1
       ORDER BY etc.tier, etc.priority, c.last_name`,
      [configId]
    ),
  ]);

  return {
    primary_groups:    gRows.filter(r => r.tier === 'primary'),
    secondary_groups:  gRows.filter(r => r.tier === 'secondary'),
    primary_contacts:  cRows.filter(r => r.tier === 'primary'),
    secondary_contacts: cRows.filter(r => r.tier === 'secondary'),
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

export const listConfigurations = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const orgId  = req.query.organization_id || null;

  const { rows } = await query(
    `SELECT e.*,
       o.name AS organization_name,
       (SELECT COUNT(*) FROM ers_tier_groups
        WHERE ers_configuration_id = e.id AND tier = 'primary')::INT   AS primary_group_count,
       (SELECT COUNT(*) FROM ers_tier_groups
        WHERE ers_configuration_id = e.id AND tier = 'secondary')::INT AS secondary_group_count,
       (SELECT COUNT(*) FROM ers_tier_contacts
        WHERE ers_configuration_id = e.id AND tier = 'primary')::INT   AS primary_contact_count,
       (SELECT COUNT(*) FROM ers_tier_contacts
        WHERE ers_configuration_id = e.id AND tier = 'secondary')::INT AS secondary_contact_count,
       (SELECT COUNT(*) FROM ers_incidents i
        WHERE i.ers_configuration_id = e.id AND i.status = 'ACTIVE')::INT AS active_incidents,
       (SELECT COUNT(*) FROM ers_queues q
        WHERE q.ers_configuration_id = e.id AND q.status = 'QUEUED')::INT AS queued_count
     FROM ers_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.deleted_at IS NULL
       AND ($1::int IS NULL OR e.organization_id = $1)
     ORDER BY e.name
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM ers_configurations
     WHERE deleted_at IS NULL AND ($1::int IS NULL OR organization_id = $1)`,
    [orgId]
  );
  res.json({ configurations: rows, total: cnt[0].total, page, limit });
});

// ── Get ──────────────────────────────────────────────────────────────────────

export const getConfiguration = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name
     FROM ers_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });

  const [tierData, activeResult] = await Promise.all([
    loadTierData(req.params.id),
    query(
      `SELECT i.*, COUNT(r.id)::INT AS responder_count
       FROM ers_incidents i
       LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
       WHERE i.ers_configuration_id = $1 AND i.status = 'ACTIVE' AND i.deleted_at IS NULL
       GROUP BY i.id ORDER BY i.started_at DESC`,
      [req.params.id]
    ),
  ]);

  res.json({ ...rows[0], ...tierData, active_incidents: activeResult.rows });
});

// ── Create ───────────────────────────────────────────────────────────────────

export const createConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO ers_configurations (
       organization_id, name, description,
       primary_bridge_number, secondary_bridge_number, conference_profile,
       max_concurrent_conferences, max_conference_duration_min,
       queue_enabled, queue_announcement_audio, queue_music_path,
       queue_timeout_sec, queue_priority, queue_hold_audio,
       record_conferences, recording_directory,
       retry_ring_count, retry_ring_interval,
       pin, allow_rejoin, cli_authentication,
       primary_retry_count, primary_retry_interval_sec,
       secondary_retry_count, secondary_retry_interval_sec,
       is_active
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
     ) RETURNING *`,
    [
      d.organization_id, d.name, d.description,
      d.primary_bridge_number, d.secondary_bridge_number, d.conference_profile,
      d.max_concurrent_conferences, d.max_conference_duration_min,
      d.queue_enabled, d.queue_announcement_audio, d.queue_music_path,
      d.queue_timeout_sec, d.queue_priority, d.queue_hold_audio ?? null,
      d.record_conferences, d.recording_directory,
      d.retry_ring_count, d.retry_ring_interval,
      d.pin, d.allow_rejoin, d.cli_authentication,
      d.primary_retry_count, d.primary_retry_interval_sec,
      d.secondary_retry_count, d.secondary_retry_interval_sec,
      d.is_active,
    ]
  );
  const cfg = rows[0];

  await Promise.all([
    syncTierGroups(cfg.id, 'primary',   d.primary_group_ids),
    syncTierGroups(cfg.id, 'secondary', d.secondary_group_ids),
    syncTierContacts(cfg.id, 'primary',   d.primary_contact_ids),
    syncTierContacts(cfg.id, 'secondary', d.secondary_contact_ids),
  ]);

  const tierData = await loadTierData(cfg.id);
  res.status(201).json({ ...cfg, ...tierData });
});

// ── Update ───────────────────────────────────────────────────────────────────

export const updateConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.partial().parse(req.body);

  const { rows } = await query(
    `UPDATE ers_configurations SET
       name                         = COALESCE($2,  name),
       description                  = COALESCE($3,  description),
       primary_bridge_number        = COALESCE($4,  primary_bridge_number),
       secondary_bridge_number      = COALESCE($5,  secondary_bridge_number),
       conference_profile           = COALESCE($6,  conference_profile),
       max_concurrent_conferences   = COALESCE($7,  max_concurrent_conferences),
       max_conference_duration_min  = COALESCE($8,  max_conference_duration_min),
       queue_enabled                = COALESCE($9,  queue_enabled),
       queue_announcement_audio     = COALESCE($10, queue_announcement_audio),
       queue_music_path             = COALESCE($11, queue_music_path),
       queue_timeout_sec            = COALESCE($12, queue_timeout_sec),
       queue_priority               = COALESCE($13, queue_priority),
       queue_hold_audio             = COALESCE($14, queue_hold_audio),
       record_conferences           = COALESCE($15, record_conferences),
       recording_directory          = COALESCE($16, recording_directory),
       retry_ring_count             = COALESCE($17, retry_ring_count),
       retry_ring_interval          = COALESCE($18, retry_ring_interval),
       pin                          = COALESCE($19, pin),
       allow_rejoin                 = COALESCE($20, allow_rejoin),
       cli_authentication           = COALESCE($21, cli_authentication),
       primary_retry_count          = COALESCE($22, primary_retry_count),
       primary_retry_interval_sec   = COALESCE($23, primary_retry_interval_sec),
       secondary_retry_count        = COALESCE($24, secondary_retry_count),
       secondary_retry_interval_sec = COALESCE($25, secondary_retry_interval_sec),
       is_active                    = COALESCE($26, is_active),
       updated_at                   = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [
      req.params.id,
      d.name, d.description,
      d.primary_bridge_number, d.secondary_bridge_number, d.conference_profile,
      d.max_concurrent_conferences, d.max_conference_duration_min,
      d.queue_enabled, d.queue_announcement_audio, d.queue_music_path,
      d.queue_timeout_sec, d.queue_priority, d.queue_hold_audio,
      d.record_conferences, d.recording_directory,
      d.retry_ring_count, d.retry_ring_interval,
      d.pin, d.allow_rejoin, d.cli_authentication,
      d.primary_retry_count, d.primary_retry_interval_sec,
      d.secondary_retry_count, d.secondary_retry_interval_sec,
      d.is_active,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });

  const updates = [];
  if (d.primary_group_ids   !== undefined) updates.push(syncTierGroups(req.params.id,   'primary',   d.primary_group_ids));
  if (d.secondary_group_ids !== undefined) updates.push(syncTierGroups(req.params.id,   'secondary', d.secondary_group_ids));
  if (d.primary_contact_ids   !== undefined) updates.push(syncTierContacts(req.params.id, 'primary',   d.primary_contact_ids));
  if (d.secondary_contact_ids !== undefined) updates.push(syncTierContacts(req.params.id, 'secondary', d.secondary_contact_ids));
  await Promise.all(updates);

  const tierData = await loadTierData(req.params.id);
  res.json({ ...rows[0], ...tierData });
});

// ── Delete ───────────────────────────────────────────────────────────────────

export const deleteConfiguration = asyncHandler(async (req, res) => {
  await query(`UPDATE ers_configurations SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// ── Toggle ───────────────────────────────────────────────────────────────────

export const toggleActive = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE ers_configurations SET is_active = NOT is_active, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });
  res.json(rows[0]);
});

// ── Tier groups endpoint (GET / PUT) ─────────────────────────────────────────

export const getTierGroups = asyncHandler(async (req, res) => {
  const tierData = await loadTierData(req.params.id);
  res.json(tierData);
});

export const updateTierGroups = asyncHandler(async (req, res) => {
  const {
    primary_group_ids    = [],
    secondary_group_ids  = [],
    primary_contact_ids  = [],
    secondary_contact_ids = [],
  } = req.body;

  await Promise.all([
    syncTierGroups(req.params.id,   'primary',   primary_group_ids.map(Number)),
    syncTierGroups(req.params.id,   'secondary', secondary_group_ids.map(Number)),
    syncTierContacts(req.params.id, 'primary',   primary_contact_ids.map(Number)),
    syncTierContacts(req.params.id, 'secondary', secondary_contact_ids.map(Number)),
  ]);

  const tierData = await loadTierData(req.params.id);
  res.json(tierData);
});

// ── ERS Incidents ─────────────────────────────────────────────────────────────

export const listIncidents = asyncHandler(async (req, res) => {
  const status = req.query.status || null;
  const { rows } = await query(
    `SELECT i.*,
       e.name AS ers_name,
       COUNT(r.id)::INT AS responder_count
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
     WHERE i.deleted_at IS NULL
       AND ($1::text IS NULL OR i.status = $1)
     GROUP BY i.id, e.name
     ORDER BY i.started_at DESC
     LIMIT $2`,
    [status, Number(req.query.limit) || 50]
  );
  res.json(rows);
});

export const createIncident = asyncHandler(async (req, res) => {
  const {
    ers_configuration_id,
    caller_number,
    caller_name,
    conference_room,
    group_type,
    recording_path,
  } = req.body;

  const incident = await withTransaction(async (tq) => {
    const { rows: cfgRows } = await tq(
      `SELECT id, max_concurrent_conferences, queue_enabled
       FROM ers_configurations
       WHERE id = $1 AND is_active = true AND deleted_at IS NULL
       FOR UPDATE`,
      [ers_configuration_id]
    );
    if (!cfgRows[0]) throw Object.assign(new Error('ERS configuration not found'), { status: 404 });
    const cfg = cfgRows[0];

    const { rows: cntRows } = await tq(
      `SELECT COUNT(*)::INT AS active FROM ers_incidents
       WHERE ers_configuration_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [ers_configuration_id]
    );
    const isQueued = cntRows[0].active >= cfg.max_concurrent_conferences;

    if (isQueued && !cfg.queue_enabled) {
      throw Object.assign(new Error('All conferences active and queue is disabled'), { status: 409 });
    }

    const { rows: incRows } = await tq(
      `INSERT INTO ers_incidents
         (ers_configuration_id, caller_number, caller_name, conference_room,
          group_type, recording_path, status, queued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        ers_configuration_id,
        caller_number, caller_name, conference_room, group_type, recording_path,
        isQueued ? 'QUEUED' : 'ACTIVE',
        isQueued ? new Date() : null,
      ]
    );

    if (isQueued) {
      const { rows: qRows } = await tq(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
         FROM ers_queues WHERE ers_configuration_id = $1 AND status = 'QUEUED'`,
        [ers_configuration_id]
      );
      await tq(
        `INSERT INTO ers_queues
           (ers_configuration_id, incident_id, position, status, caller_number, queued_reason)
         VALUES ($1,$2,$3,'QUEUED',$4,'max_concurrent_reached')`,
        [ers_configuration_id, incRows[0].id, qRows[0].next_pos, caller_number]
      );
    }

    return { ...incRows[0], queued: isQueued };
  });

  res.status(201).json(incident);
});

export const completeIncident = asyncHandler(async (req, res) => {
  const idParam = req.params.id;
  const isUuid  = /^[0-9a-f-]{36}$/i.test(idParam);
  const where   = isUuid ? 'incident_uuid = $1' : 'id = $1';
  const { recording_file } = req.body || {};

  const result = await withTransaction(async (tq) => {
    const { rows } = await tq(
      `UPDATE ers_incidents
       SET status = 'COMPLETED', ended_at = now(),
           recording_path = COALESCE($2, recording_path)
       WHERE ${where} AND deleted_at IS NULL
       RETURNING *`,
      [idParam, recording_file || null]
    );
    if (!rows[0]) throw Object.assign(new Error('Incident not found'), { status: 404 });
    const incident = rows[0];

    const { rows: nextQ } = await tq(
      `SELECT q.id AS queue_id, q.incident_id FROM ers_queues q
       WHERE q.ers_configuration_id = $1 AND q.status = 'QUEUED'
       ORDER BY q.position ASC LIMIT 1
       FOR UPDATE`,
      [incident.ers_configuration_id]
    );

    let dequeued = null;
    if (nextQ[0]) {
      await tq(
        `UPDATE ers_incidents SET status = 'ACTIVE', dequeued_at = now() WHERE id = $1`,
        [nextQ[0].incident_id]
      );
      const { rows: dq } = await tq(
        `UPDATE ers_queues SET status = 'DEQUEUED', dequeued_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [nextQ[0].queue_id]
      );
      dequeued = dq[0];
    }

    return { incident, dequeued };
  });

  res.json({ ...result.incident, dequeued: result.dequeued });
});

export const addResponder = asyncHandler(async (req, res) => {
  const { emergency_contact_id, status = 'INVITED' } = req.body;
  const { rows } = await query(
    `INSERT INTO ers_incident_responders (ers_incident_id, emergency_contact_id, status)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
    [req.params.id, emergency_contact_id, status]
  );
  res.status(201).json(rows[0] || { ok: true });
});

export const listResponders = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.first_name, c.last_name, c.mobile_number, c.role
     FROM ers_incident_responders r
     JOIN emergency_contacts c ON c.id = r.emergency_contact_id
     WHERE r.ers_incident_id = $1
     ORDER BY r.join_time NULLS LAST`,
    [req.params.id]
  );
  res.json(rows);
});

export const getQueue = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT q.*, e.name AS ers_name, i.emergency_call_number, i.started_at
     FROM ers_queues q
     JOIN ers_configurations e ON e.id = q.ers_configuration_id
     LEFT JOIN ers_incidents  i ON i.id = q.incident_id
     WHERE q.status = 'QUEUED'
     ORDER BY q.ers_configuration_id, q.position`
  );
  res.json(rows);
});
