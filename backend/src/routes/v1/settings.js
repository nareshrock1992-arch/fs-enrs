import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrSuper, superAdminOnly } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { eslStatus } from '../../services/eslService.js';
import { effectiveTenantId } from '../../middleware/tenantScope.js';
import { logger } from '../../infrastructure/index.js';

const router = Router();
router.use(requireAuth);

router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM system_settings ORDER BY key`);
  res.json(rows);
}));

// Available to every authenticated role — the "TEST MODE ACTIVE" banner must
// be visible to anyone who could place a test call, not just admins who can
// see the full settings list.
router.get('/test-mode', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT key, value FROM system_settings WHERE key IN ('test_mode_enabled', 'test_mode_caller_id')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    enabled:   map.test_mode_enabled === 'true',
    caller_id: map.test_mode_caller_id || '',
  });
}));

// Available to ADMIN and SUPERVISOR — consumed by BindNumbersModal in IVR Builder
router.get('/emergency-numbers', adminOrSuper, asyncHandler(async (req, res) => {
  const { rows: numbers } = await query(
    `SELECT id, number, type, description, is_active, tenant_id
     FROM emergency_numbers
     WHERE ($1::int IS NULL OR tenant_id = $1) AND deleted_at IS NULL AND is_active = true
     ORDER BY number`,
    [effectiveTenantId(req)]
  );
  res.json({ numbers });
}));

// system_settings and feature_flags have no tenant: one row applies to every tenant, so
// changing them is a platform action. Tenant ADMINs keep read access.
async function auditGlobalChange(req, action, key) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'global_setting', $3, $4)`,
      [req.user.id, action, key, JSON.stringify({ role: req.user.role })]
    );
  } catch (err) {
    logger.error({ module: 'platform', key, err: err.message }, 'Global setting audit failed');
  }
}

router.put('/:key', superAdminOnly, asyncHandler(async (req, res) => {
  const { value } = req.body;
  if (!/^[a-z0-9_.-]{1,100}$/i.test(req.params.key) || value === undefined || value === null) {
    return res.status(400).json({ error: 'A valid key and a value are required' });
  }
  const { rows } = await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING *`,
    [req.params.key, String(value)]
  );
  await auditGlobalChange(req, 'global_setting_changed', req.params.key);
  res.json(rows[0]);
}));

router.get('/esl/status', adminOnly, asyncHandler(async (req, res) => {
  res.json(eslStatus());
}));

router.get('/feature-flags', adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM feature_flags ORDER BY key`);
  res.json(rows);
}));

router.patch('/feature-flags/:key', superAdminOnly, asyncHandler(async (req, res) => {
  const { is_enabled } = req.body;
  const { rows } = await query(
    `UPDATE feature_flags SET is_enabled = $2, updated_at = now() WHERE key = $1 RETURNING *`,
    [req.params.key, Boolean(is_enabled)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Feature flag not found' });
  await auditGlobalChange(req, 'feature_flag_changed', req.params.key);
  res.json(rows[0]);
}));

export default router;
