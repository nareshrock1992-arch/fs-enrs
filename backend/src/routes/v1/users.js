import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';

const router = Router();
router.use(requireAuth);

// B10: SUPERVISOR was missing from the role enum
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d])/;

const UserSchema = z.object({
  email:     z.string().email().max(255),
  full_name: z.string().min(2).max(128),
  role:      z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER']).default('OPERATOR'),
  password:  z.string().min(8).regex(PASSWORD_REGEX, {
    message: 'Must contain uppercase, lowercase, digit, and special character',
  }).optional(),
  is_active: z.boolean().default(true),
  tenant_id: z.number().int().positive().optional(),
});

// B12 (users): list was unpaginated and had no filtering
router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const role   = req.query.role   || null;
  const active = req.query.active != null ? req.query.active === 'true' : null;

  const { rows } = await query(
    `SELECT id, email, full_name, role, tenant_id, is_active,
            failed_login_count, locked_until, last_login_at, created_at
     FROM users
     WHERE deleted_at IS NULL
       AND ($1::text    IS NULL OR role      = $1)
       AND ($2::boolean IS NULL OR is_active = $2)
     ORDER BY full_name
     LIMIT $3 OFFSET $4`,
    [role, active, limit, offset]
  );
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM users
     WHERE deleted_at IS NULL
       AND ($1::text    IS NULL OR role      = $1)
       AND ($2::boolean IS NULL OR is_active = $2)`,
    [role, active]
  );
  res.json({ data: rows, total: cnt[0].total, page, limit });
}));

router.get('/:id', adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, full_name, role, tenant_id, is_active, last_login_at, created_at
     FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

router.post('/', adminOnly, asyncHandler(async (req, res) => {
  const d    = UserSchema.parse(req.body);
  if (!d.password) return res.status(400).json({ error: 'Password required for new users' });
  const hash = await bcrypt.hash(d.password, 12);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, role, is_active, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, role, is_active`,
    [d.email.toLowerCase(), hash, d.full_name, d.role, d.is_active, d.tenant_id]
  );
  res.status(201).json(rows[0]);
}));

router.put('/:id', adminOnly, asyncHandler(async (req, res) => {
  const d = UserSchema.partial().parse(req.body);

  // B-fix: ADMIN cannot demote themselves
  if (Number(req.params.id) === req.user.id && d.role && d.role !== 'ADMIN') {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  let hash = null;
  if (d.password) hash = await bcrypt.hash(d.password, 12);

  const { rows } = await query(
    `UPDATE users SET
       email         = COALESCE($2, email),
       full_name     = COALESCE($3, full_name),
       role          = COALESCE($4, role),
       is_active     = COALESCE($5, is_active),
       password_hash = COALESCE($6, password_hash),
       updated_at    = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, email, full_name, role, is_active`,
    [req.params.id, d.email?.toLowerCase(), d.full_name, d.role, d.is_active, hash]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  await query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
}));

export default router;
