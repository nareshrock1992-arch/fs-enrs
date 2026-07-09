import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const intDef = (def, min = 0, max = 9999) => z.number().int().min(min).max(max).default(def);
const numDef = (def) => z.number().min(0).default(def);

const EnsConfigSchema = z.object({
  organization_id:           z.number().int().positive(),
  name:                      z.string().min(1).max(128),
  description:               emptyToNull,

  // Auth
  pin:                       emptyToNull,
  blast_clid:                emptyToNull,
  reply_clid:                emptyToNull,

  // Campaign engine settings
  max_concurrent:            intDef(30, 1),        // max concurrent blast calls
  max_concurrent_calls:      intDef(30, 1),        // alias used by campaign engine
  calls_per_second:          numDef(2.0),
  batch_size:                intDef(30, 1),
  retry_count:               intDef(3, 0, 10),
  retry_delay_seconds:       intDef(300, 0),
  retry_interval_sec:        intDef(300, 0),
  max_attempts:              intDef(4, 1, 10),
  campaign_timeout_min:      intDef(60, 1),
  recording_retention_hours: intDef(24, 1),
  retry_failed_only:         z.boolean().default(true),
  adaptive_throttling:       z.boolean().default(true),
  campaign_priority:         intDef(5, 1, 10),
  max_active_campaigns:      intDef(1, 1),

  // Gateway
  sip_gateway:               emptyToNull,
  sip_caller_id:             emptyToNull,

  // Messages
  no_pending_msg:            emptyToNull,
  expiry_announcement:       emptyToNull,

  // Destinations (junction references)
  group_ids:                 z.array(z.number().int().positive()).default([]),
  contact_ids:               z.array(z.number().int().positive()).default([]),

  is_active: z.boolean().default(true),
});

// ── Sync helpers ──────────────────────────────────────────────────────────────

async function syncGroups(configId, groupIds) {
  await query(`DELETE FROM ens_configuration_groups WHERE ens_configuration_id = $1`, [configId]);
  for (const gid of groupIds) {
    await query(
      `INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [configId, gid]
    );
  }
}

async function syncContacts(configId, contactIds) {
  await query(`DELETE FROM ens_configuration_contacts WHERE ens_configuration_id = $1`, [configId]);
  for (const cid of contactIds) {
    await query(
      `INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [configId, cid]
    );
  }
}

async function loadMappings(configId) {
  const [{ rows: groups }, { rows: contacts }] = await Promise.all([
    query(
      `SELECT rg.id, rg.name, rg.organization_id,
              COUNT(m.id)::INT AS member_count
       FROM responder_groups rg
       JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rg.id
       LEFT JOIN responder_group_members m ON m.responder_group_id = rg.id
       WHERE ecg.ens_configuration_id = $1
       GROUP BY rg.id
       ORDER BY rg.name`,
      [configId]
    ),
    query(
      `SELECT c.id, c.first_name, c.last_name, c.mobile_number, c.role
       FROM emergency_contacts c
       JOIN ens_configuration_contacts ecc ON ecc.emergency_contact_id = c.id
       WHERE ecc.ens_configuration_id = $1
       ORDER BY c.last_name, c.first_name`,
      [configId]
    ),
  ]);
  return { groups, contacts };
}

// ── List ─────────────────────────────────────────────────────────────────────

export const listConfigurations = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const orgId  = req.query.organization_id || null;

  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name,
       (SELECT COUNT(*) FROM ens_configuration_groups   WHERE ens_configuration_id = e.id)::INT AS group_count,
       (SELECT COUNT(*) FROM ens_configuration_contacts WHERE ens_configuration_id = e.id)::INT AS contact_count,
       (SELECT COUNT(*) FROM ens_campaigns c
        WHERE c.ens_configuration_id = e.id AND c.status IN ('queued','running'))::INT AS active_campaigns
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
  res.json({ configurations: rows, total: cnt[0].total, page, limit });
});

// ── Get ──────────────────────────────────────────────────────────────────────

export const getConfiguration = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, o.name AS organization_name
     FROM ens_configurations e
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });

  const mappings = await loadMappings(req.params.id);
  res.json({ ...rows[0], ...mappings });
});

// ── Create ───────────────────────────────────────────────────────────────────

export const createConfiguration = asyncHandler(async (req, res) => {
  const d = EnsConfigSchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO ens_configurations (
       organization_id, tenant_id, name, description,
       blast_clid, reply_clid, pin,
       max_concurrent, max_concurrent_calls, calls_per_second,
       batch_size, retry_count, retry_delay_seconds, retry_interval_sec,
       max_attempts, campaign_timeout_min, recording_retention_hours,
       retry_failed_only, adaptive_throttling, campaign_priority, max_active_campaigns,
       sip_gateway, sip_caller_id,
       no_pending_msg, expiry_announcement,
       is_active
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       $18,$19,$20,$21,$22,$23,$24,$25,$26
     ) RETURNING *`,
    [
      d.organization_id, req.user.tenantId, d.name, d.description,
      d.blast_clid, d.reply_clid, d.pin,
      d.max_concurrent, d.max_concurrent_calls ?? d.max_concurrent,
      d.calls_per_second,
      d.batch_size, d.retry_count, d.retry_delay_seconds,
      d.retry_interval_sec ?? d.retry_delay_seconds,
      d.max_attempts, d.campaign_timeout_min, d.recording_retention_hours,
      d.retry_failed_only, d.adaptive_throttling, d.campaign_priority, d.max_active_campaigns,
      d.sip_gateway, d.sip_caller_id,
      d.no_pending_msg, d.expiry_announcement,
      d.is_active,
    ]
  );
  const cfg = rows[0];

  await Promise.all([
    syncGroups(cfg.id, d.group_ids),
    syncContacts(cfg.id, d.contact_ids),
  ]);

  const mappings = await loadMappings(cfg.id);
  res.status(201).json({ ...cfg, ...mappings });
});

// ── Update ───────────────────────────────────────────────────────────────────

export const updateConfiguration = asyncHandler(async (req, res) => {
  const d = EnsConfigSchema.partial().parse(req.body);

  const { rows } = await query(
    `UPDATE ens_configurations SET
       name                      = COALESCE($2,  name),
       description               = COALESCE($3,  description),
       blast_clid                = COALESCE($4,  blast_clid),
       reply_clid                = COALESCE($5,  reply_clid),
       pin                       = COALESCE($6,  pin),
       max_concurrent            = COALESCE($7,  max_concurrent),
       max_concurrent_calls      = COALESCE($8,  max_concurrent_calls),
       calls_per_second          = COALESCE($9,  calls_per_second),
       batch_size                = COALESCE($10, batch_size),
       retry_count               = COALESCE($11, retry_count),
       retry_delay_seconds       = COALESCE($12, retry_delay_seconds),
       retry_interval_sec        = COALESCE($13, retry_interval_sec),
       max_attempts              = COALESCE($14, max_attempts),
       campaign_timeout_min      = COALESCE($15, campaign_timeout_min),
       recording_retention_hours = COALESCE($16, recording_retention_hours),
       retry_failed_only         = COALESCE($17, retry_failed_only),
       adaptive_throttling       = COALESCE($18, adaptive_throttling),
       campaign_priority         = COALESCE($19, campaign_priority),
       max_active_campaigns      = COALESCE($20, max_active_campaigns),
       sip_gateway               = COALESCE($21, sip_gateway),
       sip_caller_id             = COALESCE($22, sip_caller_id),
       no_pending_msg            = COALESCE($23, no_pending_msg),
       expiry_announcement       = COALESCE($24, expiry_announcement),
       is_active                 = COALESCE($25, is_active),
       tenant_id                 = COALESCE(tenant_id, $26),
       updated_at                = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [
      req.params.id,
      d.name, d.description,
      d.blast_clid, d.reply_clid, d.pin,
      d.max_concurrent,
      d.max_concurrent_calls ?? d.max_concurrent,
      d.calls_per_second,
      d.batch_size, d.retry_count, d.retry_delay_seconds,
      d.retry_interval_sec ?? d.retry_delay_seconds,
      d.max_attempts, d.campaign_timeout_min, d.recording_retention_hours,
      d.retry_failed_only, d.adaptive_throttling, d.campaign_priority, d.max_active_campaigns,
      d.sip_gateway, d.sip_caller_id,
      d.no_pending_msg, d.expiry_announcement,
      d.is_active,
      req.user.tenantId,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });

  const updates = [];
  if (d.group_ids   !== undefined) updates.push(syncGroups(req.params.id, d.group_ids));
  if (d.contact_ids !== undefined) updates.push(syncContacts(req.params.id, d.contact_ids));
  await Promise.all(updates);

  const mappings = await loadMappings(req.params.id);
  res.json({ ...rows[0], ...mappings });
});

// ── Toggle / Delete ───────────────────────────────────────────────────────────

export const toggleActive = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE ens_configurations SET is_active = NOT is_active, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ENS configuration not found' });
  res.json(rows[0]);
});

export const deleteConfiguration = asyncHandler(async (req, res) => {
  await query(`UPDATE ens_configurations SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// ── Notifications (legacy) ─────────────────────────────────────────────────

export const listNotifications = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, e.name AS ens_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     WHERE n.deleted_at IS NULL
     ORDER BY n.created_at DESC
     LIMIT $1 OFFSET $2`,
    [
      Number(req.query.limit) || 50,
      ((Number(req.query.page) || 1) - 1) * (Number(req.query.limit) || 50),
    ]
  );
  res.json(rows);
});

export const createNotification = asyncHandler(async (req, res) => {
  const { ens_configuration_id, recording_reference, triggered_via = 'API' } = req.body;

  const { rows: tgt } = await query(
    `SELECT COUNT(DISTINCT c.id)::INT AS total
     FROM emergency_contacts c
     WHERE c.deleted_at IS NULL AND c.is_active = true AND (
       c.id IN (SELECT emergency_contact_id FROM ens_configuration_contacts WHERE ens_configuration_id = $1)
       OR c.id IN (
         SELECT rgm.emergency_contact_id FROM responder_group_members rgm
         JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
         WHERE ecg.ens_configuration_id = $1
       )
     )`,
    [ens_configuration_id]
  );

  const { rows } = await query(
    `INSERT INTO ens_notifications
       (ens_configuration_id, triggered_by_user_id, triggered_via,
        recording_reference, status, total_targets)
     VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING *`,
    [ens_configuration_id, req.user?.id, triggered_via, recording_reference, tgt[0].total]
  );

  res.status(201).json(rows[0]);
});
