/**
 * Service Registry Controller
 *
 * emergency_numbers is the single source of truth for all
 * registered service numbers (ENS, ERS, IVR, REJOIN, OPEN_ACCESS).
 * This controller handles CRUD for that table plus the unified
 * internal Lua lookup endpoint.
 */
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());

const ServiceSchema = z.object({
  number:               z.string().min(1).max(32),
  type:                 z.enum(['ENS', 'ERS', 'IVR', 'REJOIN', 'OPEN_ACCESS']),
  organization_id:      z.number().int().positive().optional().nullable(),
  ens_configuration_id: z.number().int().positive().optional().nullable(),
  ers_configuration_id: z.number().int().positive().optional().nullable(),
  ivr_flow_id:          z.number().int().positive().optional().nullable(),
  service_name:         emptyToNull,
  description:          emptyToNull,
  icon:                 z.string().max(50).default('shield-alert'),
  color:                z.string().max(20).default('red'),
  sort_order:           z.number().int().default(0),
  is_active:            z.boolean().default(true),
});

const ServicePatchSchema = ServiceSchema.partial();

// ── List all services ─────────────────────────────────────────────────────────

export const listServices = asyncHandler(async (req, res) => {
  const orgId    = req.query.organization_id || null;
  const type     = req.query.type || null;
  const tenantId = req.user.tenantId;

  const { rows } = await query(
    `SELECT
       en.id,
       en.number           AS trigger_number,
       en.type             AS service_type,
       en.service_name,
       en.description,
       en.icon,
       en.color,
       en.sort_order,
       en.is_active,
       en.organization_id,
       en.ens_configuration_id,
       en.ers_configuration_id,
       en.ivr_flow_id,
       o.name              AS organization_name,
       -- ENS
       ec.id               AS ens_config_id,
       ec.name             AS ens_config_name,
       ec.max_concurrent_calls,
       ec.calls_per_second,
       ec.retry_count,
       ec.max_attempts,
       ec.adaptive_throttling,
       ec.campaign_priority,
       (SELECT COUNT(*)::INT FROM ens_campaigns cam
        WHERE cam.ens_configuration_id = ec.id
          AND cam.status IN ('queued','running')) AS active_campaigns,
       -- ERS
       ers.id              AS ers_config_id,
       ers.name            AS ers_config_name,
       ers.max_concurrent_conferences,
       ers.queue_enabled,
       ers.primary_bridge_number,
       ers.secondary_bridge_number,
       (SELECT COUNT(*)::INT FROM ers_incidents i
        WHERE i.ers_configuration_id = ers.id AND i.status = 'ACTIVE') AS active_incidents,
       (SELECT COUNT(*)::INT FROM ers_queues q
        WHERE q.ers_configuration_id = ers.id AND q.status = 'QUEUED') AS queued_ers,
       en.created_at,
       en.updated_at
     FROM emergency_numbers en
     LEFT JOIN organizations o    ON o.id  = en.organization_id
     LEFT JOIN ens_configurations ec  ON ec.id  = en.ens_configuration_id AND ec.deleted_at IS NULL
     LEFT JOIN ers_configurations ers ON ers.id = en.ers_configuration_id AND ers.deleted_at IS NULL
     WHERE en.deleted_at IS NULL
       AND en.tenant_id = $3
       AND ($1::int  IS NULL OR en.organization_id = $1)
       AND ($2::text IS NULL OR en.type = $2)
     ORDER BY en.sort_order ASC, en.type, en.number`,
    [orgId, type, tenantId]
  );

  res.json({ services: rows, total: rows.length });
});

// ── Get single service ────────────────────────────────────────────────────────

export const getService = asyncHandler(async (req, res) => {
  const { rows: [row] } = await query(
    `SELECT en.*, o.name AS organization_name,
       ec.id AS ens_config_id, ec.name AS ens_config_name,
       ec.max_concurrent_calls, ec.calls_per_second, ec.retry_count,
       ec.max_attempts, ec.retry_interval_sec, ec.adaptive_throttling,
       ec.campaign_priority, ec.campaign_timeout_min, ec.sip_gateway, ec.sip_caller_id,
       ers.id AS ers_config_id, ers.name AS ers_config_name,
       ers.max_concurrent_conferences, ers.queue_enabled,
       ers.primary_bridge_number, ers.secondary_bridge_number, ers.conference_profile
     FROM emergency_numbers en
     LEFT JOIN organizations o    ON o.id  = en.organization_id
     LEFT JOIN ens_configurations ec  ON ec.id  = en.ens_configuration_id AND ec.deleted_at IS NULL
     LEFT JOIN ers_configurations ers ON ers.id = en.ers_configuration_id AND ers.deleted_at IS NULL
     WHERE en.id = $1 AND en.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
});

// ── Create service (emergency number) ────────────────────────────────────────

export const createService = asyncHandler(async (req, res) => {
  const d = ServiceSchema.parse(req.body);

  // Determine tenant_id from organization if provided
  let tenantId = null;
  if (d.organization_id) {
    const { rows: [org] } = await query(
      `SELECT tenant_id FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [d.organization_id]
    );
    tenantId = org?.tenant_id ?? null;
  } else if (req.user?.tenantId) {
    tenantId = req.user.tenantId;
  }

  const { rows: [row] } = await query(
    `INSERT INTO emergency_numbers (
       number, type, organization_id, tenant_id,
       ens_configuration_id, ers_configuration_id, ivr_flow_id,
       service_name, description, icon, color, sort_order, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      d.number, d.type, d.organization_id ?? null, tenantId,
      d.ens_configuration_id ?? null,
      d.ers_configuration_id ?? null,
      d.ivr_flow_id ?? null,
      d.service_name, d.description, d.icon, d.color, d.sort_order, d.is_active,
    ]
  );
  res.status(201).json(row);
});

// ── Update service ────────────────────────────────────────────────────────────

export const updateServiceMeta = asyncHandler(async (req, res) => {
  const d = ServicePatchSchema.parse(req.body);

  const { rows: [row] } = await query(
    `UPDATE emergency_numbers SET
       number                = COALESCE($2,  number),
       type                  = COALESCE($3,  type),
       organization_id       = COALESCE($4,  organization_id),
       tenant_id             = CASE
         WHEN $4::int IS NOT NULL THEN
           (SELECT o.tenant_id FROM organizations o WHERE o.id = $4 AND o.deleted_at IS NULL)
         ELSE tenant_id
       END,
       ens_configuration_id  = COALESCE($5,  ens_configuration_id),
       ers_configuration_id  = COALESCE($6,  ers_configuration_id),
       ivr_flow_id           = COALESCE($7,  ivr_flow_id),
       service_name          = COALESCE($8,  service_name),
       description           = COALESCE($9,  description),
       icon                  = COALESCE($10, icon),
       color                 = COALESCE($11, color),
       sort_order            = COALESCE($12, sort_order),
       is_active             = COALESCE($13, is_active),
       updated_at            = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [
      req.params.id,
      d.number, d.type, d.organization_id,
      d.ens_configuration_id, d.ers_configuration_id, d.ivr_flow_id,
      d.service_name, d.description, d.icon, d.color, d.sort_order, d.is_active,
    ]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
});

// ── Delete service ────────────────────────────────────────────────────────────

export const deleteService = asyncHandler(async (req, res) => {
  await query(
    `UPDATE emergency_numbers SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [req.params.id]
  );
  res.status(204).end();
});

// ── Unified Lua lookup — GET /internal/services/:number ───────────────────────
// Single endpoint Lua calls after dialing any number.
// Returns service_type + full configuration for that number.

export const internalServiceLookup = asyncHandler(async (req, res) => {
  const number = String(req.params.number || req.query.number || '').trim();
  if (!number) return res.status(400).json({ success: false, error: 'number required' });

  const { rows: [en] } = await query(
    `SELECT en.id, en.type AS service_type, en.service_name,
            en.ens_configuration_id, en.ers_configuration_id, en.ivr_flow_id,
            en.organization_id, en.is_active
     FROM emergency_numbers en
     WHERE en.number = $1 AND en.deleted_at IS NULL AND en.is_active = true
     LIMIT 1`,
    [number]
  );

  if (!en) return res.status(404).json({ success: false, error: 'Service number not found' });

  // Return lightweight routing info — Lua then calls the type-specific endpoint
  // for the full config. This avoids a mega-query for every service type.
  res.json({
    success:      true,
    service_type: en.service_type,
    service_name: en.service_name,
    number,
    ens_configuration_id: en.ens_configuration_id,
    ers_configuration_id: en.ers_configuration_id,
    ivr_flow_id:          en.ivr_flow_id,
    organization_id:      en.organization_id,
  });
});
