import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eslStatus } from '../services/eslService.js';

// GET /api/v1/dashboard/metrics
export const getMetrics = asyncHandler(async (req, res) => {
  const [contacts, groups, orgs, ensConfigs, ersConfigs,
         notifications, incidents, activeConfs, queuedCalls] = await Promise.all([
    query(`SELECT COUNT(*)::INT AS n FROM emergency_contacts WHERE deleted_at IS NULL AND is_active = true`),
    query(`SELECT COUNT(*)::INT AS n FROM responder_groups WHERE deleted_at IS NULL AND is_active = true`),
    query(`SELECT COUNT(*)::INT AS n FROM organizations WHERE deleted_at IS NULL AND is_active = true`),
    query(`SELECT COUNT(*)::INT AS n FROM ens_configurations WHERE deleted_at IS NULL AND is_active = true`),
    query(`SELECT COUNT(*)::INT AS n FROM ers_configurations WHERE deleted_at IS NULL AND is_active = true`),
    query(`SELECT COUNT(*)::INT AS n FROM ens_notifications WHERE deleted_at IS NULL AND created_at >= CURRENT_DATE`),
    query(`SELECT COUNT(*)::INT AS n FROM ers_incidents WHERE deleted_at IS NULL AND created_at >= CURRENT_DATE`),
    query(`SELECT COUNT(*)::INT AS n FROM ers_incidents WHERE status = 'ACTIVE' AND deleted_at IS NULL`),
    query(`SELECT COUNT(*)::INT AS n FROM ers_queues WHERE status = 'QUEUED'`),
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
  const { rows: conferences } = await query(
    `SELECT i.*,
       e.name AS ers_name,
       COUNT(r.id)::INT AS responder_count,
       EXTRACT(EPOCH FROM (now() - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id AND r.status = 'JOINED'
     WHERE i.status = 'ACTIVE' AND i.deleted_at IS NULL
     GROUP BY i.id, e.name
     ORDER BY i.started_at`
  );

  const { rows: queued } = await query(
    `SELECT q.*, e.name AS ers_name, i.emergency_call_number,
       EXTRACT(EPOCH FROM (now() - q.created_at))::INT AS wait_seconds
     FROM ers_queues q
     JOIN ers_configurations e ON e.id = q.ers_configuration_id
     LEFT JOIN ers_incidents  i ON i.id  = q.incident_id
     WHERE q.status = 'QUEUED'
     ORDER BY q.position`
  );

  const { rows: recent_notifs } = await query(
    `SELECT n.notification_uuid, n.status, n.total_targets, n.total_success,
       n.created_at, e.name AS ens_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     WHERE n.deleted_at IS NULL
     ORDER BY n.created_at DESC LIMIT 5`
  );

  res.json({ conferences, queued, recent_notifications: recent_notifs });
});

// GET /api/v1/dashboard/chart?period=day|week|month
export const getChartData = asyncHandler(async (req, res) => {
  const period = req.query.period || 'week';
  const intervals = { day: '24 hours', week: '7 days', month: '30 days' };
  const interval  = intervals[period] || '7 days';
  const trunc     = period === 'day' ? 'hour' : 'day';

  const [notifRows, incidentRows] = await Promise.all([
    query(
      `SELECT date_trunc($1, created_at) AS bucket, COUNT(*)::INT AS count
       FROM ens_notifications
       WHERE created_at >= now() - $2::interval AND deleted_at IS NULL
       GROUP BY bucket ORDER BY bucket`,
      [trunc, interval]
    ),
    query(
      `SELECT date_trunc($1, started_at) AS bucket, COUNT(*)::INT AS count
       FROM ers_incidents
       WHERE started_at >= now() - $2::interval AND deleted_at IS NULL
       GROUP BY bucket ORDER BY bucket`,
      [trunc, interval]
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
