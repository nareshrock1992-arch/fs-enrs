import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { adminOrOp } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { effectiveTenantId } from '../../middleware/tenantScope.js';
import { contentDisposition } from '../../utils/mediaHttp.js';
import { buildWorkbookAsync } from '../../utils/xlsxWriter.js';
import { logger } from '../../infrastructure/index.js';

const router = Router();
router.use(requireAuth, adminOrOp);

// ── Query validation ──────────────────────────────────────────────────────────
// Malformed filters are a 400, never a 500 (a bad ::date / ::int cast) and never
// silently "no filter".
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDate(v, name) {
  if (v === undefined || v === '') return null;
  const s = String(v);
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${name} must be a date (YYYY-MM-DD)`);
  }
  return s;
}
function parseId(v, name) {
  if (v === undefined || v === '') return null;
  if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 2147483647) throw badRequest(`${name} must be a positive integer`);
  return Number(v);
}
// from / to / status / org_id + page / limit (malformed paging falls back to defaults, as media does)
export function parseReportQuery(q = {}) {
  const from = parseDate(q.from, 'from');
  const to   = parseDate(q.to, 'to');
  if (from && to && from > to) throw badRequest('from must not be after to');
  const status = q.status === undefined || q.status === '' ? null : String(q.status);
  if (status !== null && !/^[A-Za-z_]{1,32}$/.test(status)) throw badRequest('status is not valid');
  const intOr = (v, d) => (/^\d+$/.test(String(v ?? '')) ? parseInt(v, 10) : d);
  const page  = Math.max(1, intOr(q.page, 1));
  const limit = Math.min(200, Math.max(1, intOr(q.limit, 50)));
  return { from, to, status, org_id: parseId(q.org_id, 'org_id'), page, limit, offset: (page - 1) * limit };
}
const requireUuid = (v) => { if (!UUID_RE.test(String(v))) throw badRequest('not a valid id'); return v; };

// ── ENS outcomes ──────────────────────────────────────────────────────────────
import {
  BUSY_CAUSE_LIST, NO_ANSWER_CAUSE_LIST, DESTINATION_OUTCOME_SQL, CAMPAIGN_OUTCOMES_JOIN,
} from '../../services/ensOutcomes.js';

// Re-exported: tests and callers have always imported the cause lists from here.
export { BUSY_CAUSE_LIST, NO_ANSWER_CAUSE_LIST };

// End of the window in which a bare conference-room match may belong to this incident.
// Rooms are reused, so the window must close: ended_at, else cancelled_at (a cancelled
// queued incident has no ended_at), else "now" only while the incident is ACTIVE; any
// other unfinished state (e.g. FAILED) gets just the 2-minute start slack.
export function roomWindowEnd(incident) {
  if (incident.ended_at) return incident.ended_at;
  if (incident.cancelled_at) return incident.cancelled_at;
  if (incident.status === 'ACTIVE') return new Date();
  return new Date(new Date(incident.started_at).getTime() + 2 * 60 * 1000);
}

// GET /api/v1/reports/notifications?from=&to=&status=&org_id=
router.get('/notifications', asyncHandler(async (req, res) => {
  const { from, to, status, org_id } = parseReportQuery(req.query);
  const { rows } = await query(
    `SELECT n.*, e.name AS ens_name, o.name AS org_name, u.full_name AS triggered_by
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.deleted_at IS NULL
       AND ($5::int IS NULL OR e.tenant_id = $5)
       AND ($1::date IS NULL OR n.created_at >= $1::date)
       AND ($2::date IS NULL OR n.created_at <  $2::date + interval '1 day')
       AND ($3::text IS NULL OR n.status = $3)
       AND ($4::int  IS NULL OR o.id = $4)
     ORDER BY n.created_at DESC
     LIMIT 500`,
    [from || null, to || null, status || null, org_id || null, effectiveTenantId(req)]
  );
  res.json({ notifications: rows });
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
     WHERE c.deleted_at IS NULL AND ($1::int IS NULL OR o.tenant_id = $1)
     GROUP BY c.id, o.name
     ORDER BY c.last_name, c.first_name
     LIMIT 500`,
    [effectiveTenantId(req)]
  );
  res.json({ contacts: rows });
}));

// GET /api/v1/reports/ens-broadcasts?from=&to=
// Per-notification detail: who triggered it, per-contact delivery status,
// and the playback access log (ers_playback_attempt audit entries).
router.get('/ens-broadcasts', asyncHandler(async (req, res) => {
  const { from, to } = parseReportQuery(req.query);
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
       AND ($3::int IS NULL OR e.tenant_id = $3)
       AND ($1::date IS NULL OR n.created_at >= $1::date)
       AND ($2::date IS NULL OR n.created_at <  $2::date + interval '1 day')
     ORDER BY n.created_at DESC
     LIMIT 200`,
    [from || null, to || null, effectiveTenantId(req)]
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

  // audit_logs has no tenant_id: an attempt belongs to the tenant of the ERS configuration
  // named in its details (text comparison, so a malformed value can never raise a cast error).
  const { rows: playbackLog } = await query(
    `SELECT a.details, a.created_at FROM audit_logs a
     WHERE a.action = 'ers_playback_attempt'
       AND ($3::int IS NULL OR EXISTS (
             SELECT 1 FROM ers_configurations ec
              WHERE ec.id::text = a.details->>'configuration_id' AND ec.tenant_id = $3))
       AND ($1::date IS NULL OR a.created_at >= $1::date)
       AND ($2::date IS NULL OR a.created_at <  $2::date + interval '1 day')
     ORDER BY a.created_at DESC LIMIT 200`,
    [from || null, to || null, effectiveTenantId(req)]
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
  const { from, to, status, org_id, page, limit, offset } = parseReportQuery(req.query);

  // Totals over the WHOLE filtered set (not just this page) — the page header and the
  // summary line must not change when the user pages.
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::INT AS total,
       COUNT(*) FILTER (WHERE i.status = 'ACTIVE')::INT    AS active,
       COUNT(*) FILTER (WHERE i.status = 'COMPLETED')::INT AS completed,
       COALESCE(SUM(rc.responders), 0)::INT AS responders,
       COALESCE(SUM(rc.answered), 0)::INT   AS answered
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS responders,
              COUNT(*) FILTER (WHERE r.status IN ('JOINED','REJOINED')) AS answered
         FROM ers_incident_responders r WHERE r.ers_incident_id = i.id
     ) rc ON true
     WHERE i.deleted_at IS NULL
       AND ($1::int IS NULL OR i.tenant_id = $1)
       AND ($2::date IS NULL OR i.started_at >= $2::date)
       AND ($3::date IS NULL OR i.started_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR i.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null]
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
       AND ($1::int IS NULL OR i.tenant_id = $1)
       AND ($2::date IS NULL OR i.started_at >= $2::date)
       AND ($3::date IS NULL OR i.started_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR i.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)
     GROUP BY i.id, e.name, e.id, o.name, o.id
     ORDER BY i.started_at DESC
     LIMIT $6 OFFSET $7`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null, limit, offset]
  );

  const s = countRows[0] || {};
  res.json({
    incidents: rows, total: s.total ?? 0, page, limit,
    summary: { total: s.total ?? 0, active: s.active ?? 0, completed: s.completed ?? 0,
               responders: s.responders ?? 0, responders_answered: s.answered ?? 0 },
  });
}));

// ── Excel exports ─────────────────────────────────────────────────────────────
//
// Built in memory (utils/xlsxWriter.js), so the row count is capped; a selection over
// the cap gets a 413 asking for a narrower date range. Synchronous generation is enough
// at this size (see docs/enterprise/REPORTING_STRATEGY.md).
export const EXPORT_MAX_ROWS = 50_000;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function sendWorkbook(res, filename, sheets) {
  const file = await buildWorkbookAsync(sheets);
  res.set({
    'Content-Type':        XLSX_MIME,
    'Content-Length':      String(file.length),
    'Content-Disposition': contentDisposition('attachment', filename),
    'Cache-Control':       'private, no-store',
  });
  res.end(file);
}

const tooLarge = (res) => res.status(413).json({
  error: `This selection exceeds ${EXPORT_MAX_ROWS.toLocaleString('en-US')} rows. Narrow the date range and export again.`,
  max_rows: EXPORT_MAX_ROWS,
});

// Who exported what is part of the audit trail (best effort: the file is already built).
async function auditExport(req, report, filters, rows) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'report_exported', 'report', $2, $3)`,
      [req.user?.id ?? null, report, JSON.stringify({ tenant_id: req.user?.tenantId ?? null, filters, rows })]
    );
    logger.info({ module: 'reporting', report, rows, tenantId: req.user?.tenantId ?? null }, 'Report exported');
  } catch (err) {
    logger.warn({ module: 'reporting', report, err: err.message }, 'Report export audit failed');
  }
}

const filterItems = ({ from, to, status, org_id }, timeZone) => [
  { section: 'Applied filters' },
  { label: 'From date', value: from, empty: 'Any' },
  { label: 'To date', value: to, empty: 'Any' },
  { label: 'Date filters use time zone', value: timeZone },
  { label: 'Status', value: status, empty: 'All' },
  { label: 'Organization id', value: org_id, empty: 'All' },
];
const generatedItems = (req) => [
  { label: 'Generated (UTC)', value: new Date(), type: 'datetime' },
  { label: 'Generated by', value: req.user?.email },
];
const ratio = (part, whole) => (whole > 0 ? part / whole : null);   // no recipients: unknown, not 0%
const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
const stamp = () => new Date().toISOString().slice(0, 10);
// Day boundaries come from the database session, while cell times are written in UTC.
const dbTimeZone = async () => (await query(`SELECT current_setting('TimeZone') AS tz`))?.rows?.[0]?.tz;

// GET /api/v1/reports/ens-campaigns/export?from=&to=&status=&org_id=     → .xlsx
// GET /api/v1/reports/ens-campaigns/:id/export                           → .xlsx (one campaign)
async function exportCampaigns(req, res, campaignId) {
  const filters = parseReportQuery(req.query);
  const { from, to, status, org_id } = filters;
  const tenantId = effectiveTenantId(req);
  const where = `($1::int IS NULL OR e.tenant_id = $1)
       AND ($2::date IS NULL OR c.created_at >= $2::date)
       AND ($3::date IS NULL OR c.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR c.status = $4)
       AND ($5::int  IS NULL OR c.organization_id = $5)
       AND ($6::uuid IS NULL OR c.id = $6)`;
  const params = [tenantId, from, to, status, org_id, campaignId];

  const { rows: [size] } = await query(
    `SELECT COUNT(DISTINCT c.id)::INT AS campaigns, COUNT(d.id)::INT AS recipients
       FROM ens_campaigns c
       JOIN ens_configurations e ON e.id = c.ens_configuration_id
       LEFT JOIN ens_campaign_destinations d ON d.campaign_id = c.id
      WHERE ${where}`, params
  );
  if (campaignId && !size.campaigns) return res.status(404).json({ error: 'Campaign not found' });
  if (size.campaigns + size.recipients > EXPORT_MAX_ROWS) return tooLarge(res);

  const { rows: campaigns } = await query(
    `SELECT c.id, c.status, c.triggered_via, c.trigger_number, c.created_at, c.started_at, c.completed_at,
            c.campaign_duration_sec, e.name AS ens_name, o.name AS org_name, u.full_name AS triggered_by_name,
            x.*
       FROM ens_campaigns c
       JOIN ens_configurations e ON e.id = c.ens_configuration_id
       LEFT JOIN organizations o ON o.id = c.organization_id
       LEFT JOIN users u ON u.id = c.triggered_by
       ${CAMPAIGN_OUTCOMES_JOIN}
      WHERE ${where}
      ORDER BY c.created_at DESC`, params
  );
  const { rows: recipients } = await query(
    `SELECT c.id AS campaign_id, e.name AS ens_name, d.phone_number, d.target_type, d.attempt_count, d.max_attempts,
            d.last_attempt_at, d.answered_at, d.completed_at, d.hangup_cause, d.error_message, d.status,
            COALESCE(d.contact_name, NULLIF(TRIM(ec.first_name || ' ' || ec.last_name), '')) AS contact_name,
            ${DESTINATION_OUTCOME_SQL} AS outcome
       FROM ens_campaign_destinations d
       JOIN ens_campaigns c ON c.id = d.campaign_id
       JOIN ens_configurations e ON e.id = c.ens_configuration_id
       LEFT JOIN emergency_contacts ec ON ec.id = d.contact_id
      WHERE ${where}
      ORDER BY c.created_at DESC, d.id`, params
  );

  const total = sum(campaigns, 'recipients');
  const answered = sum(campaigns, 'answered');
  const rows = campaigns.map(c => ({
    ...c,
    initiator: c.triggered_by_name || c.trigger_number,
    answered_rate: ratio(c.answered, c.recipients),
  }));
  await sendWorkbook(res, `ens-campaigns-${stamp()}.xlsx`, [
    {
      name: 'Summary',
      title: 'Emergency Notification Report',
      items: [
        ...generatedItems(req),
        ...filterItems(filters, await dbTimeZone()),
        { section: 'Totals' },
        { label: 'Campaigns', value: campaigns.length, type: 'int' },
        { label: 'Recipients', value: total, type: 'int' },
        { label: 'Answered', value: answered, type: 'int' },
        { label: 'Busy', value: sum(campaigns, 'busy'), type: 'int' },
        { label: 'No answer', value: sum(campaigns, 'no_answer'), type: 'int' },
        { label: 'Failed', value: sum(campaigns, 'failed'), type: 'int' },
        { label: 'Expired before dialling', value: sum(campaigns, 'expired'), type: 'int' },
        { label: 'Skipped', value: sum(campaigns, 'skipped'), type: 'int' },
        { label: 'Still pending', value: sum(campaigns, 'pending'), type: 'int' },
        { label: 'Answered rate', value: ratio(answered, total), type: 'percent', empty: 'No recipients' },
        { label: 'Call attempts', value: sum(campaigns, 'attempts'), type: 'int' },
        { label: 'Retries', value: sum(campaigns, 'retries'), type: 'int' },
      ],
      notes: [
        'All times are UTC. Each recipient is counted once, by final outcome, from the per-recipient call records.',
        'Time to answer is measured from the last call attempt to the answer.',
        'Acknowledgements, DTMF responses and emergency type are not stored by the system, so they are not reported.',
      ],
    },
    {
      name: 'Campaigns',
      columns: [
        { header: 'Campaign reference', key: 'id', width: 38 },
        { header: 'ENS configuration', key: 'ens_name', width: 26 },
        { header: 'Organization', key: 'org_name', width: 22 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Triggered via', key: 'triggered_via', width: 13 },
        { header: 'Initiator', key: 'initiator', width: 22 },
        { header: 'Created (UTC)', key: 'created_at', type: 'datetime', width: 20 },
        { header: 'Started (UTC)', key: 'started_at', type: 'datetime', width: 20, empty: 'Not started' },
        { header: 'Completed (UTC)', key: 'completed_at', type: 'datetime', width: 20, empty: 'Not completed' },
        { header: 'Duration', key: 'campaign_duration_sec', type: 'duration', width: 11, empty: 'Not completed' },
        { header: 'Recipients', key: 'recipients', type: 'int', width: 11 },
        { header: 'Answered', key: 'answered', type: 'int', width: 10 },
        { header: 'Answered rate', key: 'answered_rate', type: 'percent', width: 10, empty: 'No recipients' },
        { header: 'Busy', key: 'busy', type: 'int', width: 8 },
        { header: 'No answer', key: 'no_answer', type: 'int', width: 10 },
        { header: 'Failed', key: 'failed', type: 'int', width: 8 },
        { header: 'Expired', key: 'expired', type: 'int', width: 8 },
        { header: 'Skipped', key: 'skipped', type: 'int', width: 8 },
        { header: 'Pending', key: 'pending', type: 'int', width: 8 },
        { header: 'Call attempts', key: 'attempts', type: 'int', width: 9 },
        { header: 'Retries', key: 'retries', type: 'int', width: 8 },
        { header: 'Average time to answer', key: 'avg_answer_sec', type: 'duration', width: 12, empty: 'No answers' },
      ],
      rows,
    },
    {
      name: 'Recipients',
      columns: [
        { header: 'Campaign reference', key: 'campaign_id', width: 38 },
        { header: 'ENS configuration', key: 'ens_name', width: 26 },
        { header: 'Recipient', key: 'contact_name', width: 26 },
        { header: 'Number', key: 'phone_number', width: 16 },
        { header: 'Type', key: 'target_type', width: 11 },
        { header: 'Outcome', key: 'outcome', width: 11 },
        { header: 'Attempts', key: 'attempt_count', type: 'int', width: 9 },
        { header: 'Max attempts', key: 'max_attempts', type: 'int', width: 9 },
        { header: 'Last attempt (UTC)', key: 'last_attempt_at', type: 'datetime', width: 20, empty: 'Not dialled' },
        { header: 'Answered (UTC)', key: 'answered_at', type: 'datetime', width: 20, empty: 'Not answered' },
        { header: 'Completed (UTC)', key: 'completed_at', type: 'datetime', width: 20, empty: 'Not completed' },
        { header: 'Hang-up cause', key: 'hangup_cause', width: 24, empty: 'None' },
        { header: 'Error', key: 'error_message', width: 30, empty: 'None' },
      ],
      rows: recipients,
    },
  ]);
  await auditExport(req, campaignId ? `ens-campaign:${campaignId}` : 'ens-campaigns', { from, to, status, org_id }, recipients.length);
}

router.get('/ens-campaigns/export', asyncHandler((req, res) => exportCampaigns(req, res, null)));
router.get('/ens-campaigns/:id/export', asyncHandler((req, res) => exportCampaigns(req, res, requireUuid(req.params.id))));

// GET /api/v1/reports/ers/export?from=&to=&status=&org_id=     → .xlsx
router.get('/ers/export', asyncHandler(async (req, res) => {
  const filters = parseReportQuery(req.query);
  const { from, to, status, org_id } = filters;
  const where = `i.deleted_at IS NULL
       AND ($1::int IS NULL OR i.tenant_id = $1)
       AND ($2::date IS NULL OR i.started_at >= $2::date)
       AND ($3::date IS NULL OR i.started_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR i.status = $4)
       AND ($5::int  IS NULL OR e.organization_id = $5)`;
  const params = [effectiveTenantId(req), from, to, status, org_id];

  const { rows: [size] } = await query(
    `SELECT COUNT(*)::INT AS incidents,
            COALESCE(SUM((SELECT COUNT(*) FROM ers_incident_responders r WHERE r.ers_incident_id = i.id)
                       + (SELECT COUNT(*) FROM ers_incident_participants p WHERE p.incident_id = i.id)), 0)::INT AS details
       FROM ers_incidents i JOIN ers_configurations e ON e.id = i.ers_configuration_id
      WHERE ${where}`, params
  );
  if (size.incidents + size.details > EXPORT_MAX_ROWS) return tooLarge(res);

  const { rows: incidents } = await query(
    `SELECT i.incident_uuid, i.status, i.group_type, i.caller_number, i.caller_name, i.conference_room,
            i.started_at, i.ended_at, i.cancelled_at, e.name AS ers_name, o.name AS org_name,
            CASE WHEN i.ended_at IS NOT NULL THEN EXTRACT(EPOCH FROM (i.ended_at - i.started_at))::INT END AS duration_sec,
            regexp_replace(COALESCE(rec.recording_path, i.recording_path), '^.*/', '') AS recording_file,
            x.invited, x.joined, x.not_joined, x.observers, y.participants
       FROM ers_incidents i
       JOIN ers_configurations e ON e.id = i.ers_configuration_id
       LEFT JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE r.status <> 'OBSERVER')::INT AS invited,
                COUNT(*) FILTER (WHERE r.status IN ('JOINED','REJOINED'))::INT AS joined,
                COUNT(*) FILTER (WHERE r.status NOT IN ('JOINED','REJOINED','OBSERVER'))::INT AS not_joined,
                COUNT(*) FILTER (WHERE r.status = 'OBSERVER')::INT AS observers
           FROM ers_incident_responders r WHERE r.ers_incident_id = i.id
       ) x ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::INT AS participants FROM ers_incident_participants p WHERE p.incident_id = i.id
       ) y ON true
       LEFT JOIN LATERAL (
         SELECT r2.recording_path FROM recordings r2
          WHERE r2.incident_uuid = i.incident_uuid AND r2.deleted_at IS NULL
            AND (i.tenant_id IS NULL OR r2.tenant_id = i.tenant_id)
          ORDER BY r2.started_at DESC NULLS LAST LIMIT 1
       ) rec ON true
      WHERE ${where}
      ORDER BY i.started_at DESC`, params
  );
  const { rows: responders } = await query(
    `SELECT i.incident_uuid, e.name AS ers_name, r.status, r.tier, r.wave_number, r.dial_attempts, r.hangup_cause,
            r.ring_start_time, r.join_time, r.leave_time, r.rejoin_count,
            NULLIF(TRIM(c.first_name || ' ' || c.last_name), '') AS contact_name,
            COALESCE(r.mobile_number, c.mobile_number, c.extension_number) AS number
       FROM ers_incident_responders r
       JOIN ers_incidents i ON i.id = r.ers_incident_id
       JOIN ers_configurations e ON e.id = i.ers_configuration_id
       LEFT JOIN emergency_contacts c ON c.id = r.emergency_contact_id
      WHERE ${where}
      ORDER BY i.started_at DESC, r.id`, params
  );
  const { rows: participants } = await query(
    `SELECT i.incident_uuid, p.raw_number, p.role, p.joined_at, p.left_at, p.disconnect_cause,
            COALESCE(p.total_talk_seconds, CASE WHEN p.left_at IS NOT NULL AND p.joined_at IS NOT NULL
                       THEN EXTRACT(EPOCH FROM (p.left_at - p.joined_at))::INT END) AS talk_seconds,
            COALESCE(NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), p.caller_name) AS name
       FROM ers_incident_participants p
       JOIN ers_incidents i ON i.id = p.incident_id
       JOIN ers_configurations e ON e.id = i.ers_configuration_id
       LEFT JOIN emergency_contacts c ON c.id = p.contact_id
      WHERE ${where}
      ORDER BY i.started_at DESC, p.joined_at`, params
  );

  const invited = sum(incidents, 'invited');
  const joined = sum(incidents, 'joined');
  const byStatus = (s) => incidents.filter(i => i.status === s).length;
  await sendWorkbook(res, `ers-incidents-${stamp()}.xlsx`, [
    {
      name: 'Summary',
      title: 'Emergency Response Report',
      items: [
        ...generatedItems(req),
        ...filterItems(filters, await dbTimeZone()),
        { section: 'Totals' },
        { label: 'Incidents', value: incidents.length, type: 'int' },
        { label: 'Completed', value: byStatus('COMPLETED'), type: 'int' },
        { label: 'Active', value: byStatus('ACTIVE'), type: 'int' },
        { label: 'Queued', value: byStatus('QUEUED'), type: 'int' },
        { label: 'Cancelled', value: byStatus('CANCELLED'), type: 'int' },
        { label: 'Failed', value: byStatus('FAILED'), type: 'int' },
        { label: 'Responders invited', value: invited, type: 'int' },
        { label: 'Responders joined', value: joined, type: 'int' },
        { label: 'Responder join rate', value: ratio(joined, invited), type: 'percent', empty: 'No responders invited' },
      ],
      notes: ['All times are UTC. "Not joined" counts responders who were invited and never joined, including any still ringing on an active incident.'],
    },
    {
      name: 'Incidents',
      columns: [
        { header: 'Incident reference', key: 'incident_uuid', width: 38 },
        { header: 'ERS configuration', key: 'ers_name', width: 26 },
        { header: 'Organization', key: 'org_name', width: 22 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Tier', key: 'group_type', width: 11 },
        { header: 'Caller number', key: 'caller_number', width: 16 },
        { header: 'Caller name', key: 'caller_name', width: 22 },
        { header: 'Conference room', key: 'conference_room', width: 18, empty: 'None' },
        { header: 'Started (UTC)', key: 'started_at', type: 'datetime', width: 20 },
        { header: 'Ended (UTC)', key: 'ended_at', type: 'datetime', width: 20, empty: 'Not ended' },
        { header: 'Cancelled (UTC)', key: 'cancelled_at', type: 'datetime', width: 20, empty: 'Not cancelled' },
        { header: 'Duration', key: 'duration_sec', type: 'duration', width: 11, empty: 'Not ended' },
        { header: 'Responders invited', key: 'invited', type: 'int', width: 11 },
        { header: 'Joined', key: 'joined', type: 'int', width: 9 },
        { header: 'Not joined', key: 'not_joined', type: 'int', width: 9 },
        { header: 'Observers', key: 'observers', type: 'int', width: 10 },
        { header: 'Participants', key: 'participants', type: 'int', width: 12 },
        { header: 'Recording file', key: 'recording_file', width: 34, empty: 'No recording' },
      ],
      rows: incidents,
    },
    {
      name: 'Responders',
      columns: [
        { header: 'Incident reference', key: 'incident_uuid', width: 38 },
        { header: 'ERS configuration', key: 'ers_name', width: 26 },
        { header: 'Responder', key: 'contact_name', width: 26 },
        { header: 'Number', key: 'number', width: 16 },
        { header: 'Tier', key: 'tier', width: 11 },
        { header: 'Wave', key: 'wave_number', type: 'int', width: 7 },
        { header: 'Status', key: 'status', width: 11 },
        { header: 'Dial attempts', key: 'dial_attempts', type: 'int', width: 9 },
        { header: 'Rang (UTC)', key: 'ring_start_time', type: 'datetime', width: 20 },
        { header: 'Joined (UTC)', key: 'join_time', type: 'datetime', width: 20, empty: 'Not joined' },
        { header: 'Left (UTC)', key: 'leave_time', type: 'datetime', width: 20, empty: 'Not recorded' },
        { header: 'Rejoins', key: 'rejoin_count', type: 'int', width: 8 },
        { header: 'Hang-up cause', key: 'hangup_cause', width: 24, empty: 'None' },
      ],
      rows: responders,
    },
    {
      name: 'Participants',
      columns: [
        { header: 'Incident reference', key: 'incident_uuid', width: 38 },
        { header: 'Name', key: 'name', width: 26 },
        { header: 'Number', key: 'raw_number', width: 16 },
        { header: 'Role', key: 'role', width: 11 },
        { header: 'Joined (UTC)', key: 'joined_at', type: 'datetime', width: 20 },
        { header: 'Left (UTC)', key: 'left_at', type: 'datetime', width: 20, empty: 'Not recorded' },
        { header: 'Time in conference', key: 'talk_seconds', type: 'duration', width: 12 },
        { header: 'Disconnect cause', key: 'disconnect_cause', width: 24 },
      ],
      rows: participants,
    },
  ]);
  await auditExport(req, 'ers-incidents', { from, to, status, org_id }, incidents.length);
}));

// GET /api/v1/reports/ers/:incidentUuid
router.get('/ers/:incidentUuid', asyncHandler(async (req, res) => {
  const incidentUuid = requireUuid(req.params.incidentUuid);

  const { rows: [incident] } = await query(
    `SELECT i.*, e.name AS ers_name, o.name AS org_name,
       EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::INT AS duration_seconds
     FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE i.incident_uuid = $1 AND ($2::int IS NULL OR i.tenant_id = $2) AND i.deleted_at IS NULL`,
    [incidentUuid, effectiveTenantId(req)]
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
         g.group_name
       FROM ers_incident_responders r
       LEFT JOIN emergency_contacts c   ON c.id = r.emergency_contact_id
       -- one row per responder: a contact in several groups used to repeat the responder
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT rg.name, ', ' ORDER BY rg.name) AS group_name
           FROM responder_group_members rgm
           JOIN responder_groups rg ON rg.id = rgm.responder_group_id AND rg.deleted_at IS NULL
          WHERE rgm.emergency_contact_id = c.id
       ) g ON true
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
    // Recording for this incident: by incident_uuid, else the exact recording path; a bare
    // conference-room match only within this incident's time window (rooms are reused across
    // incidents — an unbounded room match returned another incident's recording). Same tenant.
    query(
      `SELECT id, recording_path, status, duration_sec, file_size_bytes, started_at, ended_at
       FROM recordings
       WHERE deleted_at IS NULL
         AND ($6::int IS NULL OR tenant_id = $6)
         AND (incident_uuid = $3::uuid
              OR ($1::text IS NOT NULL AND recording_path = $1)
              OR ($2::text IS NOT NULL AND conference_room = $2
                  AND started_at >= $4::timestamptz - interval '2 minutes'
                  AND started_at <= $5::timestamptz))
       ORDER BY (incident_uuid = $3::uuid) DESC NULLS LAST, started_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [incident.recording_path, incident.conference_room, incident.incident_uuid,
       incident.started_at, roomWindowEnd(incident), effectiveTenantId(req)]
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
  const { from, to, status, org_id, page, limit, offset } = parseReportQuery(req.query);

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::INT AS total
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     JOIN organizations o ON o.id = e.organization_id
     WHERE n.deleted_at IS NULL
       AND ($1::int IS NULL OR e.tenant_id = $1)
       AND ($2::date IS NULL OR n.created_at >= $2::date)
       AND ($3::date IS NULL OR n.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR n.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null]
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
       AND ($1::int IS NULL OR e.tenant_id = $1)
       AND ($2::date IS NULL OR n.created_at >= $2::date)
       AND ($3::date IS NULL OR n.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR n.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)
     ORDER BY n.created_at DESC
     LIMIT $6 OFFSET $7`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null, limit, offset]
  );

  res.json({ notifications: rows, total: countRows[0]?.total ?? 0, page, limit });
}));

// GET /api/v1/reports/ens/:notificationUuid
router.get('/ens/:notificationUuid', asyncHandler(async (req, res) => {
  const notificationUuid = requireUuid(req.params.notificationUuid);

  const { rows: [notification] } = await query(
    `SELECT n.*, e.name AS ens_name, o.name AS org_name, u.full_name AS triggered_by_name,
       e.tenant_id AS config_tenant_id
     FROM ens_notifications n
     JOIN ens_configurations e ON e.id = n.ens_configuration_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN users u ON u.id = n.triggered_by_user_id
     WHERE n.notification_uuid = $1 AND ($2::int IS NULL OR e.tenant_id = $2) AND n.deleted_at IS NULL`,
    [notificationUuid, effectiveTenantId(req)]
  );
  if (!notification) return res.status(404).json({ error: 'Notification not found' });

  const { rows: deliveries } = await query(
    `SELECT d.contact_number, d.delivery_status, d.attempt_number,
       d.answered_at, d.hangup_cause, d.call_uuid,
       c.first_name, c.last_name
     FROM ens_notification_deliveries d
     -- name lookup by number: only the notification's own tenant, at most one contact
     -- (an unscoped join showed other tenants' contact names and duplicated rows)
     LEFT JOIN LATERAL (
       SELECT ec.first_name, ec.last_name
         FROM emergency_contacts ec
         JOIN organizations o ON o.id = ec.organization_id
        WHERE ec.mobile_number = d.contact_number AND ec.deleted_at IS NULL
          AND o.tenant_id IS NOT DISTINCT FROM $2::int
        ORDER BY ec.id LIMIT 1
     ) c ON true
     WHERE d.ens_notification_id = $1
     ORDER BY d.contact_number, d.attempt_number`,
    [notification.id, notification.config_tenant_id]
  );
  delete notification.config_tenant_id;

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

// ── ENS Campaign report (backed by ens_campaigns + ens_campaign_destinations) ──
// The campaign engine never writes to ens_notifications — it uses its own tables.
// This endpoint provides the canonical ENS delivery report for campaigns.

// GET /api/v1/reports/ens-campaigns?page=&limit=&from=&to=&status=&org_id=
router.get('/ens-campaigns', asyncHandler(async (req, res) => {
  const { from, to, status, org_id, page, limit, offset } = parseReportQuery(req.query);

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::INT AS total,
       COUNT(*) FILTER (WHERE c.status = 'running')::INT   AS running,
       COUNT(*) FILTER (WHERE c.status = 'completed')::INT AS completed,
       COALESCE(SUM(x.recipients), 0)::INT AS destinations,
       COALESCE(SUM(x.answered), 0)::INT   AS answered
     FROM ens_campaigns c
     JOIN ens_configurations e ON e.id = c.ens_configuration_id
     JOIN organizations o ON o.id = c.organization_id
     ${CAMPAIGN_OUTCOMES_JOIN}
     WHERE ($1::int IS NULL OR e.tenant_id = $1)
       AND ($2::date IS NULL OR c.created_at >= $2::date)
       AND ($3::date IS NULL OR c.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR c.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null]
  );

  const { rows } = await query(
    `SELECT c.id, c.status, c.triggered_via, c.trigger_number,
       c.recording_file, c.message_text,
       c.total_destinations, c.answered_count, c.failed_count,
       c.completed_count, c.retried_count, c.campaign_duration_sec,
       c.created_at, c.started_at, c.completed_at,
       e.name AS ens_name, e.id AS ens_configuration_id,
       o.name AS org_name, o.id AS organization_id,
       u.full_name AS triggered_by_name,
       to_jsonb(x) AS outcomes
     FROM ens_campaigns c
     JOIN ens_configurations e ON e.id = c.ens_configuration_id
     JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN users u ON u.id = c.triggered_by
     ${CAMPAIGN_OUTCOMES_JOIN}
     WHERE ($1::int IS NULL OR e.tenant_id = $1)
       AND ($2::date IS NULL OR c.created_at >= $2::date)
       AND ($3::date IS NULL OR c.created_at <  $3::date + interval '1 day')
       AND ($4::text IS NULL OR c.status = $4)
       AND ($5::int  IS NULL OR o.id = $5)
     ORDER BY c.created_at DESC
     LIMIT $6 OFFSET $7`,
    [effectiveTenantId(req), from || null, to || null, status || null, org_id || null, limit, offset]
  );

  const s = countRows[0] || {};
  res.json({
    campaigns: rows, total: s.total ?? 0, page, limit,
    summary: { total: s.total ?? 0, running: s.running ?? 0, completed: s.completed ?? 0,
               destinations: s.destinations ?? 0, destinations_answered: s.answered ?? 0 },
  });
}));

// GET /api/v1/reports/ens-campaigns/:id
router.get('/ens-campaigns/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);                // ens_campaigns.id is a UUID (008_campaign_engine.sql)

  const { rows: [campaign] } = await query(
    `SELECT c.*,
       e.name AS ens_name, e.id AS ens_configuration_id,
       o.name AS org_name,
       u.full_name AS triggered_by_name
     FROM ens_campaigns c
     JOIN ens_configurations e ON e.id = c.ens_configuration_id
     LEFT JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN users u ON u.id = c.triggered_by
     WHERE c.id = $1 AND ($2::int IS NULL OR e.tenant_id = $2)`,
    [id, effectiveTenantId(req)]
  );
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { rows: destinations } = await query(
    `SELECT d.id, d.phone_number, d.contact_name, d.status,
       d.target_type, d.routing_mode_used, d.gateway_name,
       d.original_number, d.attempt_count, d.max_attempts,
       d.hangup_cause, d.error_message,
       d.last_attempt_at, d.answered_at, d.completed_at, d.next_attempt_at,
       d.call_uuid,
       ec.first_name, ec.last_name, ec.extension_number, ec.mobile_number
     FROM ens_campaign_destinations d
     LEFT JOIN emergency_contacts ec ON ec.id = d.contact_id
     WHERE d.campaign_id = $1
     ORDER BY d.id ASC`,
    [id]
  );

  res.json({
    campaign: {
      ...campaign,
      destinations: destinations.map(d => ({
        id:               d.id,
        phone_number:     d.phone_number,
        contact_name:     d.contact_name || (d.first_name ? `${d.first_name} ${d.last_name}`.trim() : null),
        extension_number: d.extension_number,
        mobile_number:    d.mobile_number,
        status:           d.status,
        target_type:      d.target_type,
        routing_mode:     d.routing_mode_used,
        gateway:          d.gateway_name,
        call_uuid:        d.call_uuid,
        attempt_count:    d.attempt_count,
        max_attempts:     d.max_attempts,
        hangup_cause:     d.hangup_cause,
        error_message:    d.error_message,
        last_attempt_at:  d.last_attempt_at,
        answered_at:      d.answered_at,
        completed_at:     d.completed_at,
        next_attempt_at:  d.next_attempt_at,
      })),
    },
  });
}));

export default router;
