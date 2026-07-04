import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrOp } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';

const router = Router();
router.use(requireAuth, adminOrOp);

// GET /api/v1/reports/notifications?from=&to=&status=&org_id=
router.get('/notifications', asyncHandler(async (req, res) => {
  const { from, to, status, org_id } = req.query;
  const { rows } = await query(
    `SELECT n.*, e.name AS ens_name, o.name AS org_name, u.full_name AS triggered_by
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.deleted_at IS NULL
       AND ($1::date IS NULL OR n.created_at >= $1::date)
       AND ($2::date IS NULL OR n.created_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR n.status = $3)
       AND ($4::int  IS NULL OR o.id = $4)
     ORDER BY n.created_at DESC
     LIMIT 500`,
    [from || null, to || null, status || null, org_id || null]
  );
  res.json(rows);
}));

// GET /api/v1/reports/incidents?from=&to=&status=&org_id=
router.get('/incidents', asyncHandler(async (req, res) => {
  const { from, to, status, org_id } = req.query;
  const { rows } = await query(
    `SELECT i.*,
       e.name AS ers_name,
       o.name AS org_name,
       COUNT(r.id)::INT AS responder_count,
       EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
     WHERE i.deleted_at IS NULL
       AND ($1::date IS NULL OR i.started_at >= $1::date)
       AND ($2::date IS NULL OR i.started_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR i.status = $3)
       AND ($4::int  IS NULL OR o.id = $4)
     GROUP BY i.id, e.name, o.name
     ORDER BY i.started_at DESC
     LIMIT 500`,
    [from || null, to || null, status || null, org_id || null]
  );
  res.json(rows);
}));

// GET /api/v1/reports/contact-usage
router.get('/contact-usage', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.first_name, c.last_name, c.mobile_number, c.role,
       o.name AS organization,
       COUNT(DISTINCT ecc.ens_configuration_id)::INT AS ens_direct_configs,
       COUNT(DISTINCT ecg.ens_configuration_id)::INT AS ens_group_configs,
       COUNT(DISTINCT eir.ers_incident_id)::INT AS ers_incidents
     FROM emergency_contacts c
     JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN ens_configuration_contacts ecc ON ecc.emergency_contact_id = c.id
     LEFT JOIN responder_group_members rgm ON rgm.emergency_contact_id = c.id
     LEFT JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
     LEFT JOIN ers_incident_responders eir ON eir.emergency_contact_id = c.id
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, o.name
     ORDER BY c.last_name, c.first_name`
  );
  res.json({ contacts: rows });
}));

export default router;
