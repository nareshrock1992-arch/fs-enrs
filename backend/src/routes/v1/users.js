import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';

const router = Router();
router.use(requireAuth);

const UserSchema = z.object({
  email:     z.string().email(),
  full_name: z.string().min(1).max(128),
  role:      z.enum(['ADMIN', 'OPERATOR', 'VIEWER']).default('OPERATOR'),
  password:  z.string().min(8).optional(),
  is_active: z.boolean().default(true),
  tenant_id: z.number().int().positive().optional(),
});

router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, full_name, role, tenant_id, is_active, last_login_at, created_at
     FROM users WHERE deleted_at IS NULL ORDER BY full_name`
  );
  res.json(rows);
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
