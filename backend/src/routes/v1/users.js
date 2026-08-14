import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { superAdminOrAdmin } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { effectiveTenantId, validateTargetTenant } from '../../middleware/tenantScope.js';
import { query } from '../../db/pool.js';

const router = Router();
router.use(requireAuth, superAdminOrAdmin);

const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d])/;

const UserSchema = z.object({
  email:     z.string().email().max(255),
  full_name: z.string().min(2).max(128),
  // SUPER_ADMIN may assign any role; ADMIN may assign everything except SUPER_ADMIN.
  role:      z.enum(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER']).default('OPERATOR'),
  password:  z.string().min(8).regex(PASSWORD_REGEX, {
    message: 'Must contain uppercase, lowercase, digit, and special character',
  }).optional(),
  is_active: z.boolean().default(true),
  tenant_id: z.coerce.number().int().positive().optional(),
});

// Derive the target tenant for the current request.
// SUPER_ADMIN: from body.tenant_id or query.tenant_id (validated against DB).
// Tenant ADMIN: always their own tenantId.
async function resolveTenantForUser(req) {
  if (req.user.role === 'SUPER_ADMIN') {
    const tid = req.body?.tenant_id
      ? Number(req.body.tenant_id)
      : req.query?.tenant_id
        ? Number(req.query.tenant_id)
        : null;
    return tid; // null = all tenants (for list); required for create
  }
  return req.user.tenantId;
}

// GET /api/v1/users
router.get('/', asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const role   = req.query.role   || null;
  const active = req.query.active != null ? req.query.active === 'true' : null;

  // SUPER_ADMIN sees all tenants (or filters by ?tenant_id=).
  // Tenant ADMIN sees only their own tenant's users.
  const tenantId = req.user.role === 'SUPER_ADMIN'
    ? (req.query.tenant_id ? Number(req.query.tenant_id) : null)
    : req.user.tenantId;

  if (req.user.role !== 'SUPER_ADMIN' && !tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.is_active,
            u.failed_login_count, u.locked_until, u.last_login_at, u.created_at,
            t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.deleted_at IS NULL
       AND ($1::int  IS NULL OR u.tenant_id = $1)
       AND ($2::text    IS NULL OR u.role      = $2)
       AND ($3::boolean IS NULL OR u.is_active = $3)
     ORDER BY u.full_name
     LIMIT $4 OFFSET $5`,
    [tenantId, role, active, limit, offset]
  );
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM users
     WHERE deleted_at IS NULL
       AND ($1::int  IS NULL OR tenant_id = $1)
       AND ($2::text    IS NULL OR role      = $2)
       AND ($3::boolean IS NULL OR is_active = $3)`,
    [tenantId, role, active]
  );
  res.json({ users: rows, total: cnt[0].total, page, limit });
}));

// GET /api/v1/users/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const tenantId = req.user.role === 'SUPER_ADMIN' ? null : req.user.tenantId;
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.is_active,
            u.last_login_at, u.created_at, t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.deleted_at IS NULL
       AND ($2::int IS NULL OR u.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// POST /api/v1/users
router.post('/', asyncHandler(async (req, res) => {
  const d = UserSchema.parse(req.body);
  if (!d.password) return res.status(400).json({ error: 'Password required for new users' });

  let tenantId;
  if (req.user.role === 'SUPER_ADMIN') {
    if (d.role === 'SUPER_ADMIN') {
      // Platform-level accounts have no tenant; tenant_id must be absent.
      if (d.tenant_id) return res.status(400).json({ error: 'SUPER_ADMIN accounts must not have a tenant_id' });
      tenantId = null;
    } else {
      if (!d.tenant_id) return res.status(400).json({ error: 'tenant_id is required when creating a tenant user' });
      await validateTargetTenant(query, d.tenant_id);
      tenantId = d.tenant_id;
    }
  } else {
    // ADMIN: always scoped to own tenant; body tenant_id is ignored.
    if (!req.user.tenantId) return res.status(403).json({ error: 'Tenant context required' });
    tenantId = req.user.tenantId;
    // ADMIN cannot create SUPER_ADMIN accounts.
    if (d.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Insufficient permissions to assign the SUPER_ADMIN role' });
    }
  }

  const hash = await bcrypt.hash(d.password, 12);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, role, is_active, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, role, is_active, tenant_id`,
    [d.email.toLowerCase(), hash, d.full_name, d.role, d.is_active, tenantId]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/v1/users/:id
router.put('/:id', asyncHandler(async (req, res) => {
  const d = UserSchema.partial().parse(req.body);

  // Self-demotion guard
  if (Number(req.params.id) === req.user.id && d.role && d.role !== req.user.role) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  // ADMIN cannot assign SUPER_ADMIN role.
  if (req.user.role !== 'SUPER_ADMIN' && d.role === 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions to assign the SUPER_ADMIN role' });
  }

  // Tenant ownership: ADMIN can only update users in their own tenant.
  const tenantId = req.user.role === 'SUPER_ADMIN' ? null : req.user.tenantId;

  let hash = null;
  if (d.password) hash = await bcrypt.hash(d.password, 12);

  // Promoting to SUPER_ADMIN must clear tenant_id — platform accounts have no tenant.
  const promotingToSuperAdmin = d.role === 'SUPER_ADMIN';

  const { rows } = await query(
    `UPDATE users SET
       email         = COALESCE($3, email),
       full_name     = COALESCE($4, full_name),
       role          = COALESCE($5, role),
       is_active     = COALESCE($6, is_active),
       password_hash = COALESCE($7, password_hash),
       tenant_id     = CASE WHEN $8 THEN NULL ELSE tenant_id END,
       updated_at    = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING id, email, full_name, role, is_active, tenant_id`,
    [req.params.id, tenantId, d.email?.toLowerCase(), d.full_name, d.role, d.is_active, hash, promotingToSuperAdmin]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// DELETE /api/v1/users/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });

  const tenantId = req.user.role === 'SUPER_ADMIN' ? null : req.user.tenantId;

  const { rowCount } = await query(
    `UPDATE users SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
}));

export default router;
