import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eslStatus } from '../services/eslService.js';

// GET /api/v1/dashboard/metrics
export const getMetrics = asyncHandler(async (req, res) => {
  const tid = req.user.tenantId;
  const [contacts, groups, orgs, ensConfigs, ersConfigs,
         notifications, incidents, activeConfs, queuedCalls] = await Promise.all([
    // emergency_contacts has no tenant_id — scope via organizations join
    query(
      `SELECT COUNT(ec.id)::INT AS n
       FROM emergency_contacts ec
       JOIN organizations o ON o.id = ec.organization_id
       WHERE ec.deleted_at IS NULL AND ec.is_active = true AND o.tenant_id = $1`,
      [tid]
    ),
    // responder_groups has no tenant_id — scope via organizations join
    query(
      `SELECT COUNT(rg.id)::INT AS n
       FROM responder_groups rg
       JOIN organizations o ON o.id = rg.organization_id
       WHERE rg.deleted_at IS NULL AND rg.is_active = true AND o.tenant_id = $1`,
      [tid]
    ),
    query(`SELECT COUNT(*)::INT AS n FROM organizations WHERE deleted_at IS NULL AND is_active = true AND tenant_id = $1`, [tid]),
    query(`SELECT COUNT(*)::INT AS n FROM ens_configurations WHERE deleted_at IS NULL AND is_active = true AND tenant_id = $1`, [tid]),
    query(`SELECT COUNT(*)::INT AS n FROM ers_configurations WHERE deleted_at IS NULL AND is_active = true AND tenant_id = $1`, [tid]),
    // ens_notifications has no tenant_id — scope via ens_configurations join
    query(
      `SELECT COUNT(n.id)::INT AS n
       FROM ens_notifications n
       JOIN ens_configurations ec ON ec.id = n.ens_configuration_id
       WHERE n.deleted_at IS NULL AND n.created_at >= CURRENT_DATE AND ec.tenant_id = $1`,
      [tid]
    ),
    // ers_incidents has no direct tenant_id on existing databases — scope via ers_configurations
    query(
      `SELECT COUNT(i.id)::INT AS n
       FROM ers_incidents i
       JOIN ers_configurations ec ON ec.id = i.ers_configuration_id
       WHERE i.deleted_at IS NULL AND i.started_at >= CURRENT_DATE AND ec.tenant_id = $1`,
      [tid]
    ),
    query(
      `SELECT COUNT(i.id)::INT AS n
       FROM ers_incidents i
       JOIN ers_configurations ec ON ec.id = i.ers_configuration_id
       WHERE i.status = 'ACTIVE' AND i.deleted_at IS NULL AND ec.tenant_id = $1`,
      [tid]
    ),
    // ers_queues has no tenant_id — scope via ers_configurations join
    query(
      `SELECT COUNT(q.id)::INT AS n
       FROM ers_queues q
       JOIN ers_configurations ec ON ec.id = q.ers_configuration_id
       WHERE q.status = 'QUEUED' AND ec.tenant_id = $1`,
      [tid]
    ),
  ]);

  res.json({
    contacts:           contacts.rows[0].n,
    groups:             groups.rows[0].n,
    organizations:      orgs.rows[0].n,
    ens_configurations: ensConfigs.rows[0].n,
    ers_configurations: ersConfigs.rows[0].n,
    notifications_today: notifications.rows[0].n,
    incidents_today:    incidents.rows[0].n,
    active_conferences: activeConfs.rows[0].n,
    queued_calls:       queuedCalls.rows[0].n,
    esl:                eslStatus(),
  });
});

// GET /api/v1/dashboard/active  — real-time: active conferences and queued calls
export const getActive = asyncHandler(async (req, res) => {
  const tid = req.user.tenantId;
  const { rows: incidents } = await query(
    `SELECT
       i.id, i.incident_uuid, i.conference_room, i.caller_number,
       i.group_type, i.started_at, i.status,
       e.name AS ers_name,
       EXTRACT(EPOCH FROM (now() - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     WHERE i.status = 'ACTIVE' AND i.deleted_at IS NULL AND e.tenant_id = $1
     ORDER BY i.started_at`,
    [tid]
  );

  // Attach responders to each incident
  // ers_incident_responders has no mobile_number — join emergency_contacts
  // CHECK constraint only allows: 'INVITED','JOINED','MISSED' (no 'REJOINED')
  const incidentIds = incidents.map(i => i.id);
  let responderRows = [];
  if (incidentIds.length > 0) {
    const { rows } = await query(
      `SELECT ir.ers_incident_id, ec.mobile_number AS responder_number, ir.status
       FROM ers_incident_responders ir
       JOIN emergency_contacts ec ON ec.id = ir.emergency_contact_id
       WHERE ir.ers_incident_id = ANY($1) AND ir.status = 'JOINED'`,
      [incidentIds]
    );
    responderRows = rows;
  }

  const responderMap = {};
  for (const r of responderRows) {
    (responderMap[r.ers_incident_id] ??= []).push(r);
  }

  const conferences = incidents.map(i => ({
    ...i,
    responders:    responderMap[i.id] || [],
    member_count:  (responderMap[i.id] || []).length,
  }));

  // ers_queues has no caller_number, queued_at, or tenant_id
  // caller_number comes from the linked incident; queued_at aliases created_at
  // tenant scoped via ers_configurations join
  const { rows: queued } = await query(
    `SELECT q.id, q.position, q.status,
       COALESCE(i.caller_number, '') AS caller_number,
       q.created_at AS queued_at,
       e.name AS ers_name,
       EXTRACT(EPOCH FROM (now() - q.created_at))::INT AS wait_seconds
     FROM ers_queues q
     JOIN ers_configurations e ON e.id = q.ers_configuration_id
     LEFT JOIN ers_incidents i ON i.id = q.incident_id
     WHERE q.status = 'QUEUED' AND e.tenant_id = $1
     ORDER BY q.position`,
    [tid]
  );

  // ens_notifications has no tenant_id — scope via ens_configurations join
  // column is total_answered (not total_success)
  const { rows: recent_notifs } = await query(
    `SELECT n.notification_uuid, n.status, n.total_targets, n.total_answered,
       n.created_at, e.name AS ens_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     WHERE n.deleted_at IS NULL AND e.tenant_id = $1
     ORDER BY n.created_at DESC LIMIT 5`,
    [tid]
  );

  res.json({ conferences, queued, recent_notifications: recent_notifs });
});

// GET /api/v1/dashboard/chart?period=day|week|month
export const getChartData = asyncHandler(async (req, res) => {
  const period = req.query.period || 'week';
  const intervals = { day: '24 hours', week: '7 days', month: '30 days' };
  const interval  = intervals[period] || '7 days';
  const trunc     = period === 'day' ? 'hour' : 'day';

  const tid = req.user.tenantId;
  const [notifRows, incidentRows] = await Promise.all([
    // ens_notifications has no tenant_id — scope via ens_configurations join
    query(
      `SELECT date_trunc($1, n.created_at) AS bucket, COUNT(*)::INT AS count
       FROM ens_notifications n
       JOIN ens_configurations ec ON ec.id = n.ens_configuration_id
       WHERE n.created_at >= now() - $2::interval AND n.deleted_at IS NULL AND ec.tenant_id = $3
       GROUP BY bucket ORDER BY bucket`,
      [trunc, interval, tid]
    ),
    // scope via ers_configurations — ers_incidents has no direct tenant_id on existing DBs
    query(
      `SELECT date_trunc($1, i.started_at) AS bucket, COUNT(*)::INT AS count
       FROM ers_incidents i
       JOIN ers_configurations ec ON ec.id = i.ers_configuration_id
       WHERE i.started_at >= now() - $2::interval AND i.deleted_at IS NULL AND ec.tenant_id = $3
       GROUP BY bucket ORDER BY bucket`,
      [trunc, interval, tid]
    ),
  ]);

  // Merge notification and incident counts by bucket for chart rendering
  const bucketMap = {};
  for (const r of notifRows.rows) {
    const k = r.bucket;
    bucketMap[k] = { bucket: k, notifications: r.count, incidents: 0 };
  }
  for (const r of incidentRows.rows) {
    const k = r.bucket;
    if (bucketMap[k]) bucketMap[k].incidents = r.count;
    else bucketMap[k] = { bucket: k, notifications: 0, incidents: r.count };
  }
  const data = Object.values(bucketMap).sort((a, b) => a.bucket < b.bucket ? -1 : 1);

  res.json({ data, notifications: notifRows.rows, incidents: incidentRows.rows, period });
});
