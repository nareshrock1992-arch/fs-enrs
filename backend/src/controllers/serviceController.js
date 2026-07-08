/**
 * Service Registry Controller
 *
 * Provides a unified read-only view of all emergency services
 * (both ERS and ENS) across all trigger numbers.
 * The source of truth is emergency_numbers joined to their configs.
 */
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// GET /api/v1/services
// Returns all active emergency trigger numbers with their linked config summaries
export const listServices = asyncHandler(async (req, res) => {
  const orgId = req.query.organization_id || null;

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
       o.name              AS organization_name,

       -- ENS config summary
       ec.id               AS ens_config_id,
       ec.name             AS ens_config_name,
       ec.max_concurrent   AS ens_max_concurrent,
       ec.max_concurrent_calls,
       ec.calls_per_second,
       ec.retry_count,
       ec.max_attempts,
       ec.adaptive_throttling,
       ec.campaign_priority,

       -- ENS live stats: active campaign count
       (SELECT COUNT(*)::INT FROM ens_campaigns cam
        WHERE cam.ens_configuration_id = ec.id
          AND cam.status IN ('queued','running')) AS active_campaigns,

       -- ERS config summary
       ers.id              AS ers_config_id,
       ers.name            AS ers_config_name,
       ers.max_concurrent_conferences,
       ers.queue_enabled,

       -- ERS live stats
       (SELECT COUNT(*)::INT FROM ers_incidents i
        WHERE i.ers_configuration_id = ers.id
          AND i.status = 'ACTIVE') AS active_incidents,
       (SELECT COUNT(*)::INT FROM ers_queues q
        WHERE q.ers_configuration_id = ers.id
          AND q.status = 'QUEUED') AS queued_ers,

       en.created_at,
       en.updated_at
     FROM emergency_numbers en
     LEFT JOIN organizations o   ON o.id  = en.organization_id
     LEFT JOIN ens_configurations ec  ON ec.id  = en.ens_configuration_id AND ec.deleted_at IS NULL
     LEFT JOIN ers_configurations ers ON ers.id = en.ers_configuration_id AND ers.deleted_at IS NULL
     WHERE en.deleted_at IS NULL
       AND en.type IN ('ENS','ERS')
       AND ($1::int IS NULL OR en.organization_id = $1)
     ORDER BY en.sort_order ASC, en.type, en.number`,
    [orgId]
  );

  res.json({ services: rows, total: rows.length });
});

// GET /api/v1/services/:id
export const getService = asyncHandler(async (req, res) => {
  const { rows: [row] } = await query(
    `SELECT
       en.*,
       o.name AS organization_name,
       ec.id AS ens_config_id, ec.name AS ens_config_name,
       ec.max_concurrent_calls, ec.calls_per_second, ec.retry_count,
       ec.max_attempts, ec.retry_interval_sec, ec.adaptive_throttling,
       ec.campaign_priority, ec.campaign_timeout_min, ec.sip_gateway, ec.sip_caller_id,
       ers.id AS ers_config_id, ers.name AS ers_config_name,
       ers.max_concurrent_conferences, ers.queue_enabled
     FROM emergency_numbers en
     LEFT JOIN organizations o   ON o.id  = en.organization_id
     LEFT JOIN ens_configurations ec  ON ec.id  = en.ens_configuration_id AND ec.deleted_at IS NULL
     LEFT JOIN ers_configurations ers ON ers.id = en.ers_configuration_id AND ers.deleted_at IS NULL
     WHERE en.id = $1 AND en.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
});

// PATCH /api/v1/services/:id  — update display metadata only
const ServicePatchSchema = z.object({
  service_name: z.string().max(100).optional(),
  description:  z.string().optional(),
  icon:         z.string().max(50).optional(),
  color:        z.string().max(20).optional(),
  sort_order:   z.number().int().optional(),
  is_active:    z.boolean().optional(),
});

export const updateServiceMeta = asyncHandler(async (req, res) => {
  const d = ServicePatchSchema.parse(req.body);
  const { rows: [row] } = await query(
    `UPDATE emergency_numbers SET
       service_name = COALESCE($2, service_name),
       description  = COALESCE($3, description),
       icon         = COALESCE($4, icon),
       color        = COALESCE($5, color),
       sort_order   = COALESCE($6, sort_order),
       is_active    = COALESCE($7, is_active),
       updated_at   = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [req.params.id, d.service_name, d.description, d.icon, d.color, d.sort_order, d.is_active]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
});
