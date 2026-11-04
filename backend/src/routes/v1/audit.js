import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { superAdminOnly } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { parseReportQuery } from './reports.js';

// audit_logs holds platform-wide records and has no tenant column, so reading it is a
// platform action. Filters follow the report rules (malformed input is a 400).
const router = Router();
router.use(requireAuth, superAdminOnly);

const TOKEN_RE = /^[a-z0-9_:.-]{1,64}$/i;
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
function token(value, name) {
  if (value === undefined || value === '') return null;
  if (!TOKEN_RE.test(String(value))) throw badRequest(`${name} is not valid`);
  return String(value);
}
function positiveInt(value, name) {
  if (value === undefined || value === '') return null;
  if (!/^\d{1,9}$/.test(String(value)) || Number(value) < 1) throw badRequest(`${name} must be a positive integer`);
  return Number(value);
}

// GET /api/v1/audit?from=&to=&action=&entity_type=&user_id=&audit_tenant_id=&page=&limit=
router.get('/', asyncHandler(async (req, res) => {
  const { from, to, page, limit, offset } = parseReportQuery(req.query);
  const params = [from, to, token(req.query.action, 'action'), token(req.query.entity_type, 'entity_type'),
    positiveInt(req.query.user_id, 'user_id'), positiveInt(req.query.audit_tenant_id, 'audit_tenant_id')];
  const where = `($1::date IS NULL OR a.created_at >= $1::date)
       AND ($2::date IS NULL OR a.created_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR a.action = $3)
       AND ($4::text IS NULL OR a.entity_type = $4)
       AND ($5::int  IS NULL OR a.user_id = $5)
       AND ($6::text IS NULL OR a.details->>'tenant_id' = $6::text)`;
  const { rows: [count] } = await query(`SELECT COUNT(*)::INT AS total FROM audit_logs a WHERE ${where}`, params);
  const { rows } = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, a.user_id, u.email AS user_email
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $7 OFFSET $8`,
    [...params, limit, offset]
  );
  const { rows: actions } = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action LIMIT 200');
  const { rows: entityTypes } = await query('SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type LIMIT 200');
  res.json({
    entries: rows, total: count?.total ?? 0, page, limit,
    actions: actions.map((a) => a.action), entity_types: entityTypes.map((e) => e.entity_type),
  });
}));

export default router;
