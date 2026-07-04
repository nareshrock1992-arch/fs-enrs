import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// B5: pin was NOT NULL — CLID-based design makes it optional
const EnsConfigSchema = z.object({
  organization_id:           z.number().int().positive(),
  name:                      z.string().min(1).max(128),
  destination_number:        z.string().max(32).optional().nullable(),
  blast_clid:                z.string().max(32).optional().nullable(),
  reply_clid:                z.string().max(32).optional().nullable(),
  pin:                       z.string().max(32).optional().nullable(),  // deprecated, nullable
  retry_count:               z.number().int().min(0).max(10).default(3),
  retry_delay_seconds:       z.number().int().min(0).default(60),
  recording_retention_hours: z.number().int().min(1).default(24),
  max_concurrent:            z.number().int().min(1).default(50),
  template_id:               z.number().int().positive().optional().nullable(),
  is_active:                 z.boolean().default(true),
  group_ids:                 z.array(z.number().int().positive()).default([]),
  contact_ids:               z.array(z.number().int().positive()).default([]),
});

// B12: listConfigurations returned a plain array — now paginated
export const listConfigurations = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const orgId  = req.query.organization_id || null;

  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name,
       (SELECT COUNT(*) FROM ens_configuration_groups   WHERE ens_configuration_id = e.id)::INT AS group_count,
       (SELECT COUNT(*) FROM ens_configuration_contacts WHERE ens_configuration_id = e.id)::INT AS contact_count
     FROM ens_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.deleted_at IS NULL
       AND ($1::int IS NULL OR e.organization_id = $1)
     ORDER BY e.name
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM ens_configurations
     WHERE deleted_at IS NULL AND ($1::int IS NULL OR organization_id = $1)`,
    [orgId]
  );
  res.json({ data: rows, total: cnt[0].total, page, limit });
});

// GET /api/v1/ens/configurations/:id
export const getConfiguration = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name
     FROM ens_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });

  const { rows: groups } = await query(
    `SELECT rg.id, rg.name FROM responder_groups rg
     JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rg.id
     WHERE ecg.ens_configuration_id = $1`, [req.params.id]
  );
  const { rows: contacts } = await query(
    `SELECT c.id, c.first_name, c.last_name, c.mobile_number FROM emergency_contacts c
     JOIN ens_configuration_contacts ecc ON ecc.emergency_contact_id = c.id
     WHERE ecc.ens_configuration_id = $1`, [req.params.id]
  );

  res.json({ ...rows[0], groups, contacts });
});

// POST /api/v1/ens/configurations
export const createConfiguration = asyncHandler(async (req, res) => {
  const d = EnsConfigSchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO ens_configurations
       (organization_id, name, pin, phone_number, caller_id, retry_count, template_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [d.organization_id, d.name, d.pin, d.phone_number, d.caller_id, d.retry_count, d.template_id, d.is_active]
  );
  const cfg = rows[0];

  for (const gid of d.group_ids) {
    await query(
      `INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cfg.id, gid]
    );
  }
  for (const cid of d.contact_ids) {
    await query(
      `INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cfg.id, cid]
    );
  }

  res.status(201).json(cfg);
});

// PUT /api/v1/ens/configurations/:id
export const updateConfiguration = asyncHandler(async (req, res) => {
  const d = EnsConfigSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE ens_configurations SET
       name        = COALESCE($2,  name),
       pin         = COALESCE($3,  pin),
       phone_number= COALESCE($4,  phone_number),
       caller_id   = COALESCE($5,  caller_id),
       retry_count = COALESCE($6,  retry_count),
       is_active   = COALESCE($7,  is_active),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.pin, d.phone_number, d.caller_id, d.retry_count, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });

  if (d.group_ids !== undefined) {
    await query(`DELETE FROM ens_configuration_groups WHERE ens_configuration_id = $1`, [req.params.id]);
    for (const gid of d.group_ids) {
      await query(`INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, gid]);
    }
  }
  if (d.contact_ids !== undefined) {
    await query(`DELETE FROM ens_configuration_contacts WHERE ens_configuration_id = $1`, [req.params.id]);
    for (const cid of d.contact_ids) {
      await query(`INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, cid]);
    }
  }

  res.json(rows[0]);
});

// PATCH /api/v1/ens/configurations/:id/toggle
export const toggleActive = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE ens_configurations SET is_active = NOT is_active, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/ens/configurations/:id
export const deleteConfiguration = asyncHandler(async (req, res) => {
  await query(`UPDATE ens_configurations SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// GET /api/v1/internal/ens/lookup?number=XXX  — primary Lua lookup (CLID-based)
// Returns config + full contact mobile list for the blast engine.
export const lookupByNumber = asyncHandler(async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: 'number required' });

  const { rows } = await query(
    `SELECT e.id, e.name, e.destination_number, e.blast_clid, e.reply_clid,
       e.pin, e.retry_count, e.retry_delay_seconds,
       e.recording_retention_hours, e.max_concurrent, e.organization_id
     FROM ens_configurations e
     WHERE e.destination_number = $1
       AND e.is_active = true AND e.deleted_at IS NULL LIMIT 1`,
    [number]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No ENS configuration for number' });

  const cfg = rows[0];

  // Collect all active contact mobile numbers (groups + direct)
  const { rows: contacts } = await query(
    `SELECT DISTINCT c.mobile_number
     FROM emergency_contacts c
     WHERE c.deleted_at IS NULL AND c.is_active = true
       AND (
         c.id IN (
           SELECT rgm.emergency_contact_id FROM responder_group_members rgm
           JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
           WHERE ecg.ens_configuration_id = $1
         )
         OR c.id IN (
           SELECT ecc.emergency_contact_id FROM ens_configuration_contacts ecc
           WHERE ecc.ens_configuration_id = $1
         )
       )`,
    [cfg.id]
  );

  res.json({
    success: true,
    data: {
      configuration_id:           cfg.id,
      name:                       cfg.name,
      blast_clid:                 cfg.blast_clid,
      reply_clid:                 cfg.reply_clid,
      pin:                        cfg.pin,            // null if CLID-only
      retry_count:                cfg.retry_count,
      retry_delay_seconds:        cfg.retry_delay_seconds,
      recording_retention_hours:  cfg.recording_retention_hours,
      max_concurrent:             cfg.max_concurrent,
      contacts:                   contacts.map(r => r.mobile_number),
    },
  });
});

// GET /api/v1/ens/lookup?pin=XXX  — DEPRECATED: kept for backward compat (90 days)
// Lua scripts should migrate to /internal/ens/lookup?number=
export const lookupByPin = asyncHandler(async (req, res) => {
  const pin = req.query.pin;
  if (!pin) return res.status(400).json({ error: 'pin required' });

  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Mon, 31 Aug 2026 00:00:00 GMT');

  const { rows } = await query(
    `SELECT e.id, e.name, e.pin, e.blast_clid, e.reply_clid,
       e.retry_count, e.organization_id
     FROM ens_configurations e
     WHERE e.pin = $1 AND e.is_active = true AND e.deleted_at IS NULL LIMIT 1`,
    [pin]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No ENS configuration for PIN' });
  res.json(rows[0]);
});

// ── Notifications ──────────────────────────────────────────────────────────────

// GET /api/v1/ens/notifications
export const listNotifications = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, e.name AS ens_name, u.full_name AS triggered_by
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.deleted_at IS NULL
     ORDER BY n.created_at DESC
     LIMIT $1 OFFSET $2`,
    [Number(req.query.limit) || 50, ((Number(req.query.page) || 1) - 1) * (Number(req.query.limit) || 50)]
  );
  res.json(rows);
});

// POST /api/v1/ens/notifications  — create/trigger a notification
export const createNotification = asyncHandler(async (req, res) => {
  const { ens_configuration_id, recording_reference, triggered_via = 'API' } = req.body;

  // Count targets
  const { rows: tgt } = await query(
    `SELECT COUNT(DISTINCT c.id)::INT AS total
     FROM emergency_contacts c
     WHERE c.deleted_at IS NULL AND c.is_active = true AND (
       c.id IN (SELECT ecc.emergency_contact_id FROM ens_configuration_contacts ecc WHERE ecc.ens_configuration_id = $1)
       OR c.id IN (SELECT rgm.emergency_contact_id FROM responder_group_members rgm
                   JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
                   WHERE ecg.ens_configuration_id = $1)
     )`,
    [ens_configuration_id]
  );

  const { rows } = await query(
    `INSERT INTO ens_notifications
       (ens_configuration_id, triggered_by_user_id, triggered_via, recording_reference,
        status, total_targets)
     VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING *`,
    [ens_configuration_id, req.user?.id, triggered_via, recording_reference, tgt[0].total]
  );

  res.status(201).json(rows[0]);
});

// PATCH /api/v1/ens/notifications/:uuid/status  — used by Lua to update delivery
export const updateNotificationStatus = asyncHandler(async (req, res) => {
  const { status, total_success, total_failed } = req.body;
  const { rows } = await query(
    `UPDATE ens_notifications SET status = $2, total_success = COALESCE($3, total_success),
       total_failed = COALESCE($4, total_failed),
       completed_at = CASE WHEN $2 IN ('COMPLETED','FAILED') THEN now() ELSE completed_at END
     WHERE notification_uuid = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.uuid, status, total_success, total_failed]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });
  res.json(rows[0]);
});
