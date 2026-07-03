import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { eslStatus } from '../../services/eslService.js';

const router = Router();
router.use(requireAuth, adminOnly);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM system_settings ORDER BY key`);
  res.json(rows);
}));

router.put('/:key', asyncHandler(async (req, res) => {
  const { value } = req.body;
  const { rows } = await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING *`,
    [req.params.key, String(value)]
  );
  res.json(rows[0]);
}));

router.get('/esl/status', asyncHandler(async (req, res) => {
  res.json(eslStatus());
}));

router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM feature_flags ORDER BY key`);
  res.json(rows);
}));

router.patch('/feature-flags/:key', asyncHandler(async (req, res) => {
  const { is_enabled } = req.body;
  const { rows } = await query(
    `UPDATE feature_flags SET is_enabled = $2, updated_at = now() WHERE key = $1 RETURNING *`,
    [req.params.key, Boolean(is_enabled)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Feature flag not found' });
  res.json(rows[0]);
}));

export default router;
