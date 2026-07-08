import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eslCommand } from '../services/eslService.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());

const ErsConfigSchema = z.object({
  organization_id:            z.number().int().positive(),
  name:                       z.string().min(1).max(128),
  pin:                        emptyToNull,
  // Multi-tier group arrays (migration 009)
  primary_group_ids:          z.array(z.number().int().positive()).default([]),
  secondary_group_ids:        z.array(z.number().int().positive()).default([]),
  // Legacy single FKs — kept for backward compat; ignored when *_group_ids provided
  primary_group_id:           z.number().int().positive().optional().nullable(),
  secondary_group_id:         z.number().int().positive().optional().nullable(),
  max_concurrent_conferences: z.number().int().min(1).max(10).default(2),
  queue_enabled:              z.boolean().default(true),
  record_conferences:         z.boolean().default(false),
  queue_hold_audio:           z.string().max(512).optional().nullable(),
  is_active:                  z.boolean().default(true),
});

// ── ERS Configurations ────────────────────────────────────────

async function syncTierGroups(configId, tier, groupIds) {
  await query(`DELETE FROM ers_tier_groups WHERE ers_configuration_id = $1 AND tier = $2`, [configId, tier]);
  for (const gid of groupIds) {
    await query(
      `INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [configId, tier, gid]
    );
  }
}

async function loadTierGroups(configId) {
  const { rows } = await query(
    `SELECT etg.tier, rg.id AS group_id, rg.name AS group_name,
            (SELECT COUNT(*) FROM responder_group_members WHERE responder_group_id = rg.id)::INT AS member_count
     FROM ers_tier_groups etg
     JOIN responder_groups rg ON rg.id = etg.group_id
     WHERE etg.ers_configuration_id = $1
     ORDER BY etg.tier, rg.name`,
    [configId]
  );
  return {
    primary_groups:   rows.filter(r => r.tier === 'primary'),
    secondary_groups: rows.filter(r => r.tier === 'secondary'),
  };
}

// B13: listConfigurations was returning a plain array with no pagination
export const listConfigurations = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const orgId  = req.query.organization_id || null;

  const { rows } = await query(
    `SELECT e.*,
       o.name AS organization_name,
       (SELECT COUNT(*) FROM ers_tier_groups WHERE ers_configuration_id = e.id AND tier = 'primary')::INT   AS primary_group_count,
       (SELECT COUNT(*) FROM ers_tier_groups WHERE ers_configuration_id = e.id AND tier = 'secondary')::INT AS secondary_group_count,
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

export const getConfiguration = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name
     FROM ers_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });

  const [tierGroups, activeResult] = await Promise.all([
    loadTierGroups(req.params.id),
    query(
      `SELECT i.*, COUNT(r.id)::INT AS responder_count
       FROM ers_incidents i
       LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
       WHERE i.ers_configuration_id = $1 AND i.status = 'ACTIVE' AND i.deleted_at IS NULL
       GROUP BY i.id ORDER BY i.started_at DESC`,
      [req.params.id]
    ),
  ]);

  res.json({
    ...rows[0],
    ...tierGroups,
    active_incidents: activeResult.rows,
  });
});

export const createConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO ers_configurations
       (organization_id, name, pin, primary_group_id, secondary_group_id,
        max_concurrent_conferences, queue_enabled, record_conferences, queue_hold_audio, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [d.organization_id, d.name, d.pin,
     d.primary_group_ids[0] ?? d.primary_group_id ?? null,
     d.secondary_group_ids[0] ?? d.secondary_group_id ?? null,
     d.max_concurrent_conferences, d.queue_enabled,
     d.record_conferences ?? false, d.queue_hold_audio ?? null, d.is_active]
  );
  const cfg = rows[0];
  await syncTierGroups(cfg.id, 'primary',   d.primary_group_ids.length   ? d.primary_group_ids   : (d.primary_group_id   ? [d.primary_group_id]   : []));
  await syncTierGroups(cfg.id, 'secondary', d.secondary_group_ids.length ? d.secondary_group_ids : (d.secondary_group_id ? [d.secondary_group_id] : []));
  const tierGroups = await loadTierGroups(cfg.id);
  res.status(201).json({ ...cfg, ...tierGroups });
});

export const updateConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE ers_configurations SET
       name                       = COALESCE($2,  name),
       pin                        = COALESCE($3,  pin),
       max_concurrent_conferences = COALESCE($4,  max_concurrent_conferences),
       queue_enabled              = COALESCE($5,  queue_enabled),
       record_conferences         = COALESCE($6,  record_conferences),
       queue_hold_audio           = COALESCE($7,  queue_hold_audio),
       is_active                  = COALESCE($8,  is_active),
       updated_at                 = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.pin,
     d.max_concurrent_conferences, d.queue_enabled,
     d.record_conferences, d.queue_hold_audio, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });

  if (d.primary_group_ids !== undefined) {
    await syncTierGroups(req.params.id, 'primary', d.primary_group_ids);
  }
  if (d.secondary_group_ids !== undefined) {
    await syncTierGroups(req.params.id, 'secondary', d.secondary_group_ids);
  }
  const tierGroups = await loadTierGroups(req.params.id);
  res.json({ ...rows[0], ...tierGroups });
});

export const deleteConfiguration = asyncHandler(async (req, res) => {
  await query(`UPDATE ers_configurations SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

export const toggleActive = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE ers_configurations SET is_active = NOT is_active, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });
  res.json(rows[0]);
});

// GET /api/v1/ers/configurations/:id/tier-groups
export const getTierGroups = asyncHandler(async (req, res) => {
  const tierGroups = await loadTierGroups(req.params.id);
  res.json(tierGroups);
});

// PUT /api/v1/ers/configurations/:id/tier-groups
// Body: { primary_group_ids: [1,2,3], secondary_group_ids: [4,5] }
export const updateTierGroups = asyncHandler(async (req, res) => {
  const { primary_group_ids = [], secondary_group_ids = [] } = req.body;
  await Promise.all([
    syncTierGroups(req.params.id, 'primary',   primary_group_ids.map(Number)),
    syncTierGroups(req.params.id, 'secondary', secondary_group_ids.map(Number)),
  ]);
  const tierGroups = await loadTierGroups(req.params.id);
  res.json(tierGroups);
});

// GET /api/v1/ers/lookup?pin=  — Lua API
export const lookupByPin = asyncHandler(async (req, res) => {
  const pin = req.query.pin;
  if (!pin) return res.status(400).json({ error: 'pin required' });

  const { rows } = await query(
    `SELECT e.id, e.name, e.pin, e.max_concurrent_conferences, e.queue_enabled,
       e.primary_group_id, e.secondary_group_id, e.organization_id
     FROM ers_configurations e
     WHERE e.pin = $1 AND e.is_active = true AND e.deleted_at IS NULL LIMIT 1`,
    [pin]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No ERS configuration for PIN' });

  // Also return current active count so Lua can decide routing
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS active_count FROM ers_incidents
     WHERE ers_configuration_id = $1 AND status = 'ACTIVE'`,
    [rows[0].id]
  );

  res.json({ ...rows[0], active_conferences: cnt[0].active_count });
});

// ── ERS Incidents ─────────────────────────────────────────────

// GET /api/v1/ers/incidents
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

// POST /api/v1/ers/incidents  — Lua calls this when emergency call arrives
//
// B7 FIX — Race condition: two simultaneous callers could both read
// active_count < max and both insert as ACTIVE.
// Fix: use SELECT … FOR UPDATE inside a transaction to serialise the
// read-then-insert. The lock on the ers_configurations row means a
// second concurrent call blocks at the SELECT until the first COMMIT.
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
    // Lock the config row for the duration of this transaction
    const { rows: cfgRows } = await tq(
      `SELECT id, max_concurrent_conferences, queue_enabled
       FROM ers_configurations
       WHERE id = $1 AND is_active = true AND deleted_at IS NULL
       FOR UPDATE`,
      [ers_configuration_id]
    );
    if (!cfgRows[0]) throw Object.assign(new Error('ERS configuration not found'), { status: 404 });

    const cfg = cfgRows[0];

    // Count active incidents while holding the row lock — no TOCTOU gap
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
      // caller_number, queued_reason added to ers_queues by migration 002 B10
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

// POST /api/v1/ers/incidents/:uuid/complete  — Lua calls after caller leaves
//
// B8 FIX — Non-atomic completion: the old code ran three separate queries
// (UPDATE incident, SELECT queue, UPDATE queue) without a transaction.
// If the process crashed between queries, the queue entry would be stuck as
// QUEUED forever while the incident was COMPLETED. Now all three are atomic.
export const completeIncident = asyncHandler(async (req, res) => {
  // Accept both integer id and UUID (Lua uses UUID)
  const idParam = req.params.id;
  const isUuid  = /^[0-9a-f-]{36}$/i.test(idParam);
  const whereClause = isUuid
    ? 'incident_uuid = $1'
    : 'id = $1';

  const { recording_file } = req.body || {};

  const result = await withTransaction(async (tq) => {
    const { rows } = await tq(
      `UPDATE ers_incidents
       SET status       = 'COMPLETED',
           ended_at     = now(),
           recording_path = COALESCE($2, recording_path)
       WHERE ${whereClause} AND deleted_at IS NULL
       RETURNING *`,
      [idParam, recording_file || null]
    );
    if (!rows[0]) throw Object.assign(new Error('Incident not found'), { status: 404 });
    const incident = rows[0];

    // Auto-dequeue — both queries in the same transaction
    const { rows: nextQ } = await tq(
      `SELECT q.id AS queue_id, q.incident_id FROM ers_queues q
       WHERE q.ers_configuration_id = $1 AND q.status = 'QUEUED'
       ORDER BY q.position ASC LIMIT 1
       FOR UPDATE`,        // -- lock the queue row too     
      [incident.ers_configuration_id]
    );

    let dequeued = null;
    if (nextQ[0]) {
      await tq(
        `UPDATE ers_incidents
         SET status = 'ACTIVE', dequeued_at = now()
         WHERE id = $1`,
        [nextQ[0].incident_id]
      );
      // dequeued_at added to ers_queues by migration 002 B10
      const { rows: dq } = await tq(
        `UPDATE ers_queues
         SET status = 'DEQUEUED', dequeued_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [nextQ[0].queue_id]
      );
      dequeued = dq[0];
    }

    return { incident, dequeued };
  });

  res.json({ ...result.incident, dequeued: result.dequeued });
});

// POST /api/v1/ers/incidents/:id/responders  — add responders to incident
export const addResponder = asyncHandler(async (req, res) => {
  const { emergency_contact_id, status = 'INVITED' } = req.body;
  const { rows } = await query(
    `INSERT INTO ers_incident_responders (ers_incident_id, emergency_contact_id, status)
     VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING *`,
    [req.params.id, emergency_contact_id, status]
  );
  res.status(201).json(rows[0] || { ok: true });
});

// GET /api/v1/ers/incidents/:id/responders
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

// GET /api/v1/ers/queue — live queue view for dashboard
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
