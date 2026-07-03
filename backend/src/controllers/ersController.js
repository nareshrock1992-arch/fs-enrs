import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eslCommand } from '../services/eslService.js';

const ErsConfigSchema = z.object({
  organization_id:            z.number().int().positive(),
  name:                       z.string().min(1).max(128),
  pin:                        z.string().max(32).optional().nullable(),
  primary_group_id:           z.number().int().positive().optional().nullable(),
  secondary_group_id:         z.number().int().positive().optional().nullable(),
  max_concurrent_conferences: z.number().int().min(1).max(10).default(2),
  queue_enabled:              z.boolean().default(true),
  is_active:                  z.boolean().default(true),
});

// ── ERS Configurations ────────────────────────────────────────

export const listConfigurations = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*,
       o.name AS organization_name,
       pg.name AS primary_group_name,
       sg.name AS secondary_group_name,
       (SELECT COUNT(*) FROM ers_incidents i
        WHERE i.ers_configuration_id = e.id AND i.status = 'ACTIVE')::INT AS active_incidents,
       (SELECT COUNT(*) FROM ers_queues q
        WHERE q.ers_configuration_id = e.id AND q.status = 'QUEUED')::INT AS queued_count
     FROM ers_configurations e
     LEFT JOIN organizations   o  ON o.id  = e.organization_id
     LEFT JOIN responder_groups pg ON pg.id = e.primary_group_id
     LEFT JOIN responder_groups sg ON sg.id = e.secondary_group_id
     WHERE e.deleted_at IS NULL
       AND ($1::int IS NULL OR e.organization_id = $1)
     ORDER BY e.name`,
    [req.query.organization_id || null]
  );
  res.json(rows);
});

export const getConfiguration = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name,
       pg.name AS primary_group_name, sg.name AS secondary_group_name
     FROM ers_configurations e
     LEFT JOIN organizations   o  ON o.id  = e.organization_id
     LEFT JOIN responder_groups pg ON pg.id = e.primary_group_id
     LEFT JOIN responder_groups sg ON sg.id = e.secondary_group_id
     WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });

  const { rows: active } = await query(
    `SELECT i.*, COUNT(r.id)::INT AS responder_count
     FROM ers_incidents i
     LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
     WHERE i.ers_configuration_id = $1 AND i.status = 'ACTIVE' AND i.deleted_at IS NULL
     GROUP BY i.id ORDER BY i.started_at DESC`, [req.params.id]
  );

  res.json({ ...rows[0], active_incidents: active });
});

export const createConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO ers_configurations
       (organization_id, name, pin, primary_group_id, secondary_group_id,
        max_concurrent_conferences, queue_enabled, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [d.organization_id, d.name, d.pin, d.primary_group_id, d.secondary_group_id,
     d.max_concurrent_conferences, d.queue_enabled, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateConfiguration = asyncHandler(async (req, res) => {
  const d = ErsConfigSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE ers_configurations SET
       name                       = COALESCE($2,  name),
       pin                        = COALESCE($3,  pin),
       primary_group_id           = COALESCE($4,  primary_group_id),
       secondary_group_id         = COALESCE($5,  secondary_group_id),
       max_concurrent_conferences = COALESCE($6,  max_concurrent_conferences),
       queue_enabled              = COALESCE($7,  queue_enabled),
       is_active                  = COALESCE($8,  is_active),
       updated_at                 = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.pin, d.primary_group_id, d.secondary_group_id,
     d.max_concurrent_conferences, d.queue_enabled, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ERS configuration not found' });
  res.json(rows[0]);
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
export const createIncident = asyncHandler(async (req, res) => {
  const { ers_configuration_id, emergency_call_number, conference_id } = req.body;

  // Check if we're at max concurrent conferences
  const { rows: cnt } = await query(
    `SELECT max_concurrent_conferences,
       (SELECT COUNT(*) FROM ers_incidents WHERE ers_configuration_id = $1 AND status = 'ACTIVE')::INT AS active
     FROM ers_configurations WHERE id = $1`,
    [ers_configuration_id]
  );

  const cfg = cnt[0];
  const isQueued = cfg && cfg.active >= cfg.max_concurrent_conferences;

  const { rows } = await query(
    `INSERT INTO ers_incidents
       (ers_configuration_id, emergency_call_number, conference_id, status, queued_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ers_configuration_id, emergency_call_number, conference_id,
     isQueued ? 'QUEUED' : 'ACTIVE',
     isQueued ? new Date() : null]
  );

  if (isQueued) {
    const { rows: qpos } = await query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM ers_queues
       WHERE ers_configuration_id = $1 AND status = 'QUEUED'`,
      [ers_configuration_id]
    );
    await query(
      `INSERT INTO ers_queues (ers_configuration_id, incident_id, position, status)
       VALUES ($1,$2,$3,'QUEUED')`,
      [ers_configuration_id, rows[0].id, qpos[0].next_pos]
    );
  }

  res.status(201).json({ ...rows[0], queued: isQueued });
});

// PATCH /api/v1/ers/incidents/:id/complete
export const completeIncident = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE ers_incidents SET status = 'COMPLETED', ended_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Incident not found' });

  // Auto-dequeue next waiting incident for this configuration
  const { rows: nextQ } = await query(
    `SELECT q.*, i.id AS incident_id FROM ers_queues q
     JOIN ers_incidents i ON i.id = q.incident_id
     WHERE q.ers_configuration_id = $1 AND q.status = 'QUEUED'
     ORDER BY q.position ASC LIMIT 1`,
    [rows[0].ers_configuration_id]
  );

  if (nextQ[0]) {
    await query(
      `UPDATE ers_incidents SET status = 'ACTIVE', dequeued_at = now() WHERE id = $1`,
      [nextQ[0].incident_id]
    );
    await query(
      `UPDATE ers_queues SET status = 'DEQUEUED', updated_at = now() WHERE id = $1`,
      [nextQ[0].id]
    );
  }

  res.json(rows[0]);
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
