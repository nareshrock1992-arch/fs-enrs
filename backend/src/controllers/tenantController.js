import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const TenantSchema = z.object({
  name:      z.string().min(2).max(128),
  code:      z.string().min(1).max(32).regex(/^[A-Z0-9_-]+$/, 'Code must be uppercase letters, digits, underscores, or hyphens').optional(),
  is_active: z.boolean().default(true),
});

// GET /api/v1/tenants
export const listTenants = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.name, t.code, t.is_active, t.created_at,
       (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL)::INT AS user_count,
       (SELECT COUNT(*) FROM organizations o WHERE o.tenant_id = t.id AND o.deleted_at IS NULL)::INT AS org_count
     FROM tenants t
     WHERE t.deleted_at IS NULL
     ORDER BY t.name`
  );
  res.json({ tenants: rows });
});

// GET /api/v1/tenants/:id
export const getTenant = asyncHandler(async (req, res) => {
  const { rows: [tenant] } = await query(
    `SELECT t.id, t.name, t.code, t.is_active, t.created_at, t.updated_at
     FROM tenants t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const [{ rows: users }, { rows: orgs }] = await Promise.all([
    query(
      `SELECT id, email, full_name, role, is_active, last_login_at
       FROM users WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY full_name`,
      [tenant.id]
    ),
    query(
      `SELECT id, name, code, is_active, is_system FROM organizations
       WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [tenant.id]
    ),
  ]);

  res.json({ tenant, users, organizations: orgs });
});

// POST /api/v1/tenants
export const createTenant = asyncHandler(async (req, res) => {
  const d = TenantSchema.parse(req.body);

  const code = d.code || d.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 32);

  const { rows: [tenant] } = await query(
    `INSERT INTO tenants (name, code, is_active) VALUES ($1,$2,$3) RETURNING *`,
    [d.name, code, d.is_active]
  );

  // Optionally create a system organization for the new tenant
  if (req.body.create_default_org !== false) {
    await query(
      `INSERT INTO organizations (tenant_id, name, code, is_system, is_active)
       VALUES ($1,$2,$3,true,true) ON CONFLICT DO NOTHING`,
      [tenant.id, `${d.name} — Default`, code]
    );
  }

  res.status(201).json(tenant);
});

// PATCH /api/v1/tenants/:id
export const updateTenant = asyncHandler(async (req, res) => {
  const d = TenantSchema.partial().parse(req.body);
  const { rows: [tenant] } = await query(
    `UPDATE tenants SET
       name      = COALESCE($2, name),
       code      = COALESCE($3, code),
       is_active = COALESCE($4, is_active),
       updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [req.params.id, d.name, d.code, d.is_active]
  );
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json(tenant);
});
