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

// Row scope for reads/updates/deletes. SUPER_ADMIN → null (all users; an explicit,
// valid ?tenant_id narrows the list). Everyone else → their own tenant, or 403 via
// effectiveTenantId — never "all tenants".
const scopeOf = (req) => effectiveTenantId(req);
// Tenant admins may never read or change SUPER_ADMIN accounts — even if a
// SUPER_ADMIN row ever carried a tenant_id (data drift). $2 is the tenant scope.
const NOT_SUPER_ADMIN_FOR_TENANT_ADMINS = `AND ($2::int IS NULL OR role <> 'SUPER_ADMIN')`;

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

  // SUPER_ADMIN sees all tenants (or filters by a valid ?tenant_id=; malformed → 400).
  // Tenant ADMIN sees only their own tenant's users (no tenant → 403).
  const tenantId = scopeOf(req);
  const hideSA = req.user.role === 'SUPER_ADMIN' ? null : true;

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
       AND ($6::boolean IS NULL OR u.role <> 'SUPER_ADMIN')
     ORDER BY u.full_name
     LIMIT $4 OFFSET $5`,
    [tenantId, role, active, limit, offset, hideSA]
  );
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM users
     WHERE deleted_at IS NULL
       AND ($1::int  IS NULL OR tenant_id = $1)
       AND ($2::text    IS NULL OR role      = $2)
       AND ($3::boolean IS NULL OR is_active = $3)
       AND ($4::boolean IS NULL OR role <> 'SUPER_ADMIN')`,
    [tenantId, role, active, hideSA]
  );
  res.json({ users: rows, total: cnt[0].total, page, limit });
}));

// GET /api/v1/users/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const tenantId = req.user.role === 'SUPER_ADMIN' ? null : scopeOf(req);
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.is_active,
            u.last_login_at, u.created_at, t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.deleted_at IS NULL
       AND ($2::int IS NULL OR u.tenant_id = $2)
       AND ($2::int IS NULL OR u.role <> 'SUPER_ADMIN')`,
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

  // Tenant ownership: ADMIN can only update non-SUPER_ADMIN users in their own tenant.
  const isSA = req.user.role === 'SUPER_ADMIN';
  const tenantId = isSA ? null : scopeOf(req);

  // Promoting to SUPER_ADMIN must clear tenant_id — platform accounts have no tenant.
  const promotingToSuperAdmin = d.role === 'SUPER_ADMIN';

  // Tenant assignment (SUPER_ADMIN only; body tenant_id is ignored for tenant admins).
  // Any account that is not SUPER_ADMIN must end up with a tenant: demoting a
  // SUPER_ADMIN requires one, and a SUPER_ADMIN may repair an account that has none.
  let assignTenant = null;
  if (isSA) {
    const { rows: [target] } = await query(
      `SELECT id, role, tenant_id, is_active FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const finalRole   = d.role || target.role;
    const finalActive = d.is_active ?? target.is_active;
    if (d.tenant_id) {
      if (finalRole === 'SUPER_ADMIN') return res.status(400).json({ error: 'SUPER_ADMIN accounts must not have a tenant_id' });
      await validateTargetTenant(query, d.tenant_id);
      assignTenant = d.tenant_id;
    } else if (finalRole !== 'SUPER_ADMIN' && !target.tenant_id && finalActive !== false) {
      // (deactivating a tenant-less account is always allowed)
      return res.status(400).json({
        error: 'tenant_id is required: this account would have no tenant (e.g. demoting a SUPER_ADMIN)',
        code:  'TENANT_REQUIRED',
      });
    }
  }

  let hash = null;
  if (d.password) hash = await bcrypt.hash(d.password, 12);

  const { rows } = await query(
    `UPDATE users SET
       email              = COALESCE($3, email),
       full_name          = COALESCE($4, full_name),
       role               = COALESCE($5, role),
       is_active          = COALESCE($6, is_active),
       password_hash      = COALESCE($7, password_hash),
       tenant_id          = CASE WHEN $8 THEN NULL WHEN $9::int IS NOT NULL THEN $9::int ELSE tenant_id END,
       -- a password reset revokes the user's existing refresh session
       refresh_token_hash = CASE WHEN $7::text IS NOT NULL THEN NULL ELSE refresh_token_hash END,
       updated_at         = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
       ${NOT_SUPER_ADMIN_FOR_TENANT_ADMINS}
     RETURNING id, email, full_name, role, is_active, tenant_id`,
    [req.params.id, tenantId, d.email?.toLowerCase(), d.full_name, d.role, d.is_active, hash, promotingToSuperAdmin, assignTenant]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// DELETE /api/v1/users/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });

  const tenantId = req.user.role === 'SUPER_ADMIN' ? null : scopeOf(req);

  const { rowCount } = await query(
    `UPDATE users SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
       ${NOT_SUPER_ADMIN_FOR_TENANT_ADMINS}`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
}));

export default router;
