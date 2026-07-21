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
       AND e.tenant_id = $5
       AND ($1::date IS NULL OR n.created_at >= $1::date)
       AND ($2::date IS NULL OR n.created_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR n.status = $3)
       AND ($4::int  IS NULL OR o.id = $4)
     ORDER BY n.created_at DESC
     LIMIT 500`,
    [from || null, to || null, status || null, org_id || null, req.user.tenantId]
  );
  res.json({ notifications: rows });
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
       AND i.tenant_id = $5
       AND ($1::date IS NULL OR i.started_at >= $1::date)
       AND ($2::date IS NULL OR i.started_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR i.status = $3)
       AND ($4::int  IS NULL OR o.id = $4)
     GROUP BY i.id, e.name, o.name
     ORDER BY i.started_at DESC
     LIMIT 500`,
    [from || null, to || null, status || null, org_id || null, req.user.tenantId]
  );
  res.json({ incidents: rows });
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
     WHERE c.deleted_at IS NULL AND o.tenant_id = $1
     GROUP BY c.id, o.name
     ORDER BY c.last_name, c.first_name
     LIMIT 500`,
    [req.user.tenantId]
  );
  res.json({ contacts: rows });
}));

// ── Phase 5 detailed reports ──────────────────────────────────────────────────

// GET /api/v1/reports/ers-incidents?from=&to=
// Full detail: every incident + every participant's join/leave/rejoin
// timestamps and directory identity + recording link. Backed by
// ers_incident_participants (migration 016), which mod_conference's own
// add/del-member events populate — accurate regardless of which path put
// a leg in the room (ring-all, caller bridge, rejoin redial).
router.get('/ers-incidents', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { rows: incidents } = await query(
    `SELECT i.id, i.incident_uuid, i.status, i.caller_number, i.caller_name,
       i.conference_room, i.group_type, i.recording_path,
       i.started_at, i.ended_at, i.queued_at, i.dequeued_at,
       e.name AS ers_name, o.name AS org_name,
       EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE i.deleted_at IS NULL
       AND i.tenant_id = $3
       AND ($1::date IS NULL OR i.started_at >= $1::date)
       AND ($2::date IS NULL OR i.started_at <  $2::date + interval '1 day')
     ORDER BY i.started_at DESC
     LIMIT 200`,
    [from || null, to || null, req.user.tenantId]
  );

  const ids = incidents.map(i => i.id);
  let participants = [];
  if (ids.length > 0) {
    const { rows } = await query(
      `SELECT p.incident_id, p.raw_number, p.role,
         p.joined_at, p.left_at, p.rejoined_at,
         c.first_name, c.last_name, c.extension_number, c.mobile_number
       FROM ers_incident_participants p
       LEFT JOIN emergency_contacts c ON c.id = p.contact_id
       WHERE p.incident_id = ANY($1)
       ORDER BY p.joined_at`,
      [ids]
    );
    participants = rows;
  }

  const byIncident = {};
  for (const p of participants) {
    (byIncident[p.incident_id] ??= []).push({
      name:       p.first_name ? `${p.first_name} ${p.last_name}`.trim() : (p.raw_number || 'unknown'),
      number:     p.extension_number || p.mobile_number || p.raw_number,
      role:       p.role,
      joined_at:  p.joined_at,
      left_at:    p.left_at,
      rejoined_at: p.rejoined_at,
    });
  }

  res.json({
    incidents: incidents.map(i => ({ ...i, participants: byIncident[i.id] || [] })),
  });
}));

// GET /api/v1/reports/ens-broadcasts?from=&to=
// Per-notification detail: who triggered it, per-contact delivery status,
// and the playback access log (ers_playback_attempt audit entries).
router.get('/ens-broadcasts', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { rows: broadcasts } = await query(
    `SELECT n.id, n.notification_uuid, n.status, n.triggered_via,
       n.caller_number, n.recording_file, n.total_targets, n.total_answered,
       n.created_at, n.started_at, n.pin_verified_at,
       e.name AS ens_name, o.name AS org_name,
       u.full_name AS recorded_by_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.recorded_by
     WHERE n.deleted_at IS NULL
       AND e.tenant_id = $3
       AND ($1::date IS NULL OR n.created_at >= $1::date)
       AND ($2::date IS NULL OR n.created_at <  $2::date + interval '1 day')
     ORDER BY n.created_at DESC
     LIMIT 200`,
    [from || null, to || null, req.user.tenantId]
  );

  const ids = broadcasts.map(b => b.id);
  let deliveries = [];
  if (ids.length > 0) {
    const { rows } = await query(
      `SELECT d.ens_notification_id, d.contact_number, d.delivery_status,
         d.attempt_number, d.answered_at, d.hangup_cause
       FROM ens_notification_deliveries d
       WHERE d.ens_notification_id = ANY($1)
       ORDER BY d.contact_number`,
      [ids]
    );
    deliveries = rows;
  }

  const { rows: playbackLog } = await query(
    `SELECT details, created_at FROM audit_logs
     WHERE action = 'ers_playback_attempt'
       AND ($1::date IS NULL OR created_at >= $1::date)
       AND ($2::date IS NULL OR created_at <  $2::date + interval '1 day')
     ORDER BY created_at DESC LIMIT 200`,
    [from || null, to || null]
  );

  const byNotif = {};
  for (const d of deliveries) {
    (byNotif[d.ens_notification_id] ??= []).push(d);
  }

  res.json({
    broadcasts: broadcasts.map(b => ({ ...b, deliveries: byNotif[b.id] || [] })),
    playback_access_log: playbackLog,
  });
}));

// ── Unified ERS report (summary + optional detail) ────────────────────────────

// GET /api/v1/reports/ers?page=1&limit=50&from=&to=&status=&org_id=
router.get('/ers', asyncHandler(async (req, res) => {
  const { from, to, status, org_id } = req.query;
  const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::INT AS total
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     WHERE i.deleted_at IS NULL
       AND i.tenant_id = $1
       AND ($2::date IS NULL OR i.started_at >= $2::date)
       AND ($3::date IS NULL OR i.started_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR i.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)`,
    [req.user.tenantId, from || null, to || null, status || null, org_id || null]
  );

  const { rows } = await query(
    `SELECT i.id, i.incident_uuid, i.status, i.group_type,
       i.caller_number, i.caller_name, i.conference_room,
       i.recording_path, i.started_at, i.ended_at, i.queued_at, i.dequeued_at, i.cancelled_at,
       e.name AS ers_name, e.id AS ers_configuration_id,
       o.name AS org_name, o.id AS organization_id,
       COUNT(DISTINCT r.id)::INT AS responder_count,
       COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('JOINED','REJOINED'))::INT AS answered_count,
       COUNT(DISTINCT r.id) FILTER (WHERE r.status NOT IN ('JOINED','REJOINED','OBSERVER'))::INT AS no_answer_count,
       COUNT(DISTINCT p.id)::INT AS participant_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.role = 'initiator')::INT AS initiator_count,
       EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN ers_incident_responders r ON r.ers_incident_id = i.id
     LEFT JOIN ers_incident_participants p ON p.incident_id = i.id
     WHERE i.deleted_at IS NULL
       AND i.tenant_id = $1
       AND ($2::date IS NULL OR i.started_at >= $2::date)
       AND ($3::date IS NULL OR i.started_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR i.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)
     GROUP BY i.id, e.name, e.id, o.name, o.id
     ORDER BY i.started_at DESC
     LIMIT $6 OFFSET $7`,
    [req.user.tenantId, from || null, to || null, status || null, org_id || null, limit, offset]
  );

  res.json({ incidents: rows, total: countRows[0]?.total ?? 0, page, limit });
}));

// GET /api/v1/reports/ers/:incidentUuid
router.get('/ers/:incidentUuid', asyncHandler(async (req, res) => {
  const { incidentUuid } = req.params;

  const { rows: [incident] } = await query(
    `SELECT i.*, e.name AS ers_name, o.name AS org_name,
       EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE i.incident_uuid = $1 AND i.tenant_id = $2 AND i.deleted_at IS NULL`,
    [incidentUuid, req.user.tenantId]
  );
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const [{ rows: participants }, { rows: responders }, { rows: [recording] }, { rows: events }] = await Promise.all([
    // Participants: every leg that entered the conference (initiator + responders)
    // Tries migration-031 columns first; falls back to base columns if not yet applied.
    query(
      `SELECT p.id, p.raw_number, p.role, p.caller_name,
         p.joined_at, p.left_at, p.rejoined_at,
         p.disconnect_cause, p.total_talk_seconds,
         c.first_name, c.last_name, c.extension_number, c.mobile_number,
         c.role AS contact_role
       FROM ers_incident_participants p
       LEFT JOIN emergency_contacts c ON c.id = p.contact_id
       WHERE p.incident_id = $1
       ORDER BY p.joined_at`,
      [incident.id]
    ).catch(() =>
      query(
        `SELECT p.id, p.raw_number, p.role,
           p.joined_at, p.left_at, p.rejoined_at,
           c.first_name, c.last_name, c.extension_number, c.mobile_number,
           c.role AS contact_role
         FROM ers_incident_participants p
         LEFT JOIN emergency_contacts c ON c.id = p.contact_id
         WHERE p.incident_id = $1
         ORDER BY p.joined_at`,
        [incident.id]
      )
    ),
    // Responders: all contacts that were dialled (INVITED includes no-answers)
    // Tries migration-031 columns first; falls back to base columns if not yet applied.
    query(
      `SELECT r.id, r.status, r.joined_via, r.rejoin_count,
         r.join_time, r.leave_time, r.call_uuid,
         r.mobile_number AS responder_mobile,
         r.ring_start_time, r.dial_attempts, r.hangup_cause, r.tier, r.wave_number,
         c.first_name, c.last_name, c.mobile_number, c.extension_number,
         c.role AS contact_role,
         rg.name AS group_name
       FROM ers_incident_responders r
       LEFT JOIN emergency_contacts c   ON c.id = r.emergency_contact_id
       LEFT JOIN responder_group_members rgm ON rgm.emergency_contact_id = c.id
       LEFT JOIN responder_groups rg    ON rg.id = rgm.responder_group_id AND rg.deleted_at IS NULL
       WHERE r.ers_incident_id = $1
       ORDER BY r.join_time NULLS LAST, r.id`,
      [incident.id]
    ).catch(() =>
      query(
        `SELECT r.id, r.status, r.joined_via, r.rejoin_count,
           r.join_time, r.leave_time, r.call_uuid,
           r.mobile_number AS responder_mobile,
           c.first_name, c.last_name, c.mobile_number, c.extension_number,
           c.role AS contact_role
         FROM ers_incident_responders r
         LEFT JOIN emergency_contacts c ON c.id = r.emergency_contact_id
         WHERE r.ers_incident_id = $1
         ORDER BY r.join_time NULLS LAST, r.id`,
        [incident.id]
      )
    ),
    // Recording for this incident
    query(
      `SELECT id, recording_path, status, duration_sec, file_size_bytes, started_at, ended_at
       FROM recordings
       WHERE (recording_path = $1 OR conference_room = $2) AND deleted_at IS NULL
       LIMIT 1`,
      [incident.recording_path, incident.conference_room]
    ),
    // Mute/floor event history
    query(
      `SELECT e.member_id, e.raw_number, e.event_type, e.occurred_at
       FROM ers_incident_events e
       WHERE e.incident_id = $1
       ORDER BY e.occurred_at`,
      [incident.id]
    ).catch(() => ({ rows: [] })),
  ]);

  // Compute total_talk_seconds for each participant if not already stored
  // (left_at - joined_at, using rejoined_at for multi-leg participants)
  const enrichedParticipants = participants.map(p => {
    const name = p.first_name
      ? `${p.first_name} ${p.last_name}`.trim()
      : (p.caller_name || p.raw_number || 'Unknown');
    const number = p.extension_number || p.mobile_number || p.raw_number;
    const talkSec = p.total_talk_seconds ??
      (p.joined_at && p.left_at
        ? Math.round((new Date(p.left_at) - new Date(p.joined_at)) / 1000)
        : null);
    return {
      participant_id:     p.id,
      name,
      contact_name:       name,
      contact_number:     number,
      number,
      role:               p.role,
      joined_at:          p.joined_at,
      join_conference_time: p.joined_at,
      left_at:            p.left_at,
      leave_conference_time: p.left_at,
      rejoined_at:        p.rejoined_at,
      total_talk_seconds: talkSec,
      disconnect_cause:   p.disconnect_cause,
    };
  });

  const enrichedResponders = responders.map(r => {
    const name = r.first_name
      ? `${r.first_name} ${r.last_name}`.trim()
      : (r.mobile_number || r.responder_mobile || 'Unknown');
    const number = r.extension_number || r.mobile_number || r.responder_mobile;
    // Compute answer_time as the elapsed seconds from ring_start to join_time
    const answerTimeSec = (r.ring_start_time && r.join_time)
      ? Math.round((new Date(r.join_time) - new Date(r.ring_start_time)) / 1000)
      : null;
    // Map status to the enterprise response_status enum
    const responseStatus = r.status;
    return {
      responder_id:       r.id,
      name,
      contact_name:       name,
      contact_number:     number,
      number,
      contact_role:       r.contact_role,
      group:              r.group_name || null,
      escalation_level:   r.tier || null,        // primary | secondary
      tier:               r.tier || null,
      // Disposition
      response_status:    responseStatus,
      status:             responseStatus,
      // Timing
      ring_start:         r.ring_start_time,
      answer_time:        r.join_time,
      answer_time_seconds: answerTimeSec,
      join_conference_time: r.join_time,
      leave_conference_time: r.leave_time,
      // Detail
      dial_attempts:      r.dial_attempts,
      wave_number:        r.wave_number,
      hangup_cause:       r.hangup_cause,
      disconnect_cause:   r.hangup_cause,
      joined_via:         r.joined_via,
      rejoin_count:       r.rejoin_count,
      call_uuid:          r.call_uuid,
    };
  });

  res.json({
    incident: {
      ...incident,
      conference_duration_seconds: incident.duration_seconds,
      participants: enrichedParticipants,
      responders:   enrichedResponders,
      event_history: events,
      recording:    recording || null,
    },
  });
}));

// ── Unified ENS report (summary + optional detail) ────────────────────────────

// GET /api/v1/reports/ens?page=1&limit=50&from=&to=&status=&org_id=
router.get('/ens', asyncHandler(async (req, res) => {
  const { from, to, status, org_id } = req.query;
  const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::INT AS total
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     WHERE n.deleted_at IS NULL
       AND e.tenant_id = $1
       AND ($2::date IS NULL OR n.created_at >= $2::date)
       AND ($3::date IS NULL OR n.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR n.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)`,
    [req.user.tenantId, from || null, to || null, status || null, org_id || null]
  );

  const { rows } = await query(
    `SELECT n.id, n.notification_uuid, n.status, n.triggered_via,
       n.caller_number, n.recording_file,
       n.total_targets, n.total_answered, n.total_no_answer, n.total_replayed,
       n.created_at, n.started_at, n.completed_at,
       e.name AS ens_name, e.id AS ens_configuration_id,
       o.name AS org_name, o.id AS organization_id,
       u.full_name AS triggered_by_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.deleted_at IS NULL
       AND e.tenant_id = $1
       AND ($2::date IS NULL OR n.created_at >= $2::date)
       AND ($3::date IS NULL OR n.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR n.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)
     ORDER BY n.created_at DESC
     LIMIT $6 OFFSET $7`,
    [req.user.tenantId, from || null, to || null, status || null, org_id || null, limit, offset]
  );

  res.json({ notifications: rows, total: countRows[0]?.total ?? 0, page, limit });
}));

// GET /api/v1/reports/ens/:notificationUuid
router.get('/ens/:notificationUuid', asyncHandler(async (req, res) => {
  const { notificationUuid } = req.params;

  const { rows: [notification] } = await query(
    `SELECT n.*, e.name AS ens_name, o.name AS org_name, u.full_name AS triggered_by_name
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.notification_uuid = $1 AND e.tenant_id = $2 AND n.deleted_at IS NULL`,
    [notificationUuid, req.user.tenantId]
  );
  if (!notification) return res.status(404).json({ error: 'Notification not found' });

  const { rows: deliveries } = await query(
    `SELECT d.contact_number, d.delivery_status, d.attempt_number,
       d.answered_at, d.hangup_cause, d.call_uuid,
       c.first_name, c.last_name
     FROM ens_notification_deliveries d
     LEFT JOIN emergency_contacts c ON c.mobile_number = d.contact_number AND c.deleted_at IS NULL
     WHERE d.ens_notification_id = $1
     ORDER BY d.contact_number, d.attempt_number`,
    [notification.id]
  );

  res.json({
    notification: {
      ...notification,
      deliveries: deliveries.map(d => ({
        contact_number:  d.contact_number,
        name:            d.first_name ? `${d.first_name} ${d.last_name}`.trim() : null,
        delivery_status: d.delivery_status,
        attempt_number:  d.attempt_number,
        answered_at:     d.answered_at,
        hangup_cause:    d.hangup_cause,
        call_uuid:       d.call_uuid,
      })),
    },
  });
}));

export default router;
