import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { deployGateway } from '../services/gatewayDeployment.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());

const GatewaySchema = z.object({
  name:               z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric/underscore/hyphen (used as the FreeSWITCH gateway name)'),
  type:               z.enum(['avaya', 'cisco', 'generic_sip', 'other']).default('generic_sip'),
  host:               z.string().min(1).max(255),
  port:               z.number().int().min(1).max(65535).default(5060),
  username:           emptyToNull,
  password:           emptyToNull,
  register:           z.boolean().default(true),
  caller_id_in_from:  z.boolean().default(false),
  is_default_outbound: z.boolean().default(false),
  is_active:          z.boolean().default(true),
});

// GET /api/v1/gateways
export const listGateways = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, tenant_id, name, type, host, port, username, register,
            caller_id_in_from, is_default_outbound, is_active,
            last_deployed_at, last_deployment_status, created_at, updated_at
     FROM sip_gateways
     WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY name`,
    [req.user.tenantId]
  );
  res.json({ gateways: rows });
});

// POST /api/v1/gateways
export const createGateway = asyncHandler(async (req, res) => {
  const d = GatewaySchema.parse(req.body);
  const tenantId = req.user.tenantId;

  const gw = await withTransaction(async tq => {
    if (d.is_default_outbound) {
      await tq(`UPDATE sip_gateways SET is_default_outbound = false WHERE tenant_id = $1`, [tenantId]);
    }
    const { rows: [row] } = await tq(
      `INSERT INTO sip_gateways
         (tenant_id, name, type, host, port, username, password, register,
          caller_id_in_from, is_default_outbound, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, d.name, d.type, d.host, d.port, d.username, d.password,
       d.register, d.caller_id_in_from, d.is_default_outbound, d.is_active]
    );
    return row;
  });

  res.status(201).json(gw);
});

// PUT /api/v1/gateways/:id
export const updateGateway = asyncHandler(async (req, res) => {
  const d = GatewaySchema.partial().parse(req.body);
  const tenantId = req.user.tenantId;

  const gw = await withTransaction(async tq => {
    if (d.is_default_outbound) {
      await tq(`UPDATE sip_gateways SET is_default_outbound = false WHERE tenant_id = $1 AND id != $2`, [tenantId, req.params.id]);
    }
    const { rows: [row] } = await tq(
      `UPDATE sip_gateways SET
         name               = COALESCE($3, name),
         type               = COALESCE($4, type),
         host               = COALESCE($5, host),
         port               = COALESCE($6, port),
         username           = COALESCE($7, username),
         password           = COALESCE($8, password),
         register           = COALESCE($9, register),
         caller_id_in_from  = COALESCE($10, caller_id_in_from),
         is_default_outbound = COALESCE($11, is_default_outbound),
         is_active          = COALESCE($12, is_active),
         updated_at         = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [req.params.id, tenantId, d.name, d.type, d.host, d.port, d.username,
       d.password, d.register, d.caller_id_in_from, d.is_default_outbound, d.is_active]
    );
    return row;
  });

  if (!gw) return res.status(404).json({ error: 'Gateway not found' });
  res.json(gw);
});

// DELETE /api/v1/gateways/:id
export const deleteGateway = asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE sip_gateways SET deleted_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [req.params.id, req.user.tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Gateway not found' });
  res.status(204).end();
});

// POST /api/v1/gateways/:id/deploy
export const deployGatewayRoute = asyncHandler(async (req, res) => {
  const { rows: [gw] } = await query(
    `SELECT id FROM sip_gateways WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [req.params.id, req.user.tenantId]
  );
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });

  const result = await deployGateway(req.params.id);
  res.status(result.status === 'success' ? 200 : 422).json(result);
});
