import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';

// ── Validators ────────────────────────────────────────────────────────────────

const PhoneRegex = /^[0-9+\-\s()]{7,20}$/;

function validatePhone(n) {
  return PhoneRegex.test(String(n || '').trim());
}

const DeliverySchema = z.object({
  contact_number: z.string().min(7).max(20),
  status:         z.enum(['ANSWERED', 'NO_ANSWER', 'FAILED', 'CANCELLED']),
  call_uuid:      z.string().optional().nullable(),
  hangup_cause:   z.string().optional().nullable(),
  answered_at:    z.string().datetime({ offset: true }).optional().nullable(),
});

const NotificationCreateSchema = z.object({
  configuration_id: z.number().int().positive(),
  triggered_via:    z.enum(['PHONE', 'UI', 'API']).default('PHONE'),
  caller_number:    z.string().min(7).max(20).optional().nullable(),
  recording_file:   z.string().max(512).optional().nullable(),
});

const CallbackLogSchema = z.object({
  notification_uuid: z.string().uuid(),
  caller_number:     z.string().min(7).max(20),
  reply_clid:        z.string().min(1).max(32),
  delivery_id:       z.number().int().positive(),
  replayed_at:       z.string().datetime({ offset: true }).optional().nullable(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Resolve all contact mobile numbers for an ENS config (groups + direct contacts)
async function resolveEnsContacts(configId) {
  const { rows } = await query(
    `SELECT DISTINCT ec.mobile_number
     FROM ens_contacts ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND (
         ec.id IN (
           SELECT ens_contact_id FROM ens_configuration_contacts
           WHERE ens_configuration_id = $1 AND ens_contact_id IS NOT NULL
         )
         OR ec.id IN (
           SELECT egm.contact_id
           FROM ens_group_members egm
           JOIN ens_configuration_groups ecg ON ecg.ens_group_id = egm.group_id
           WHERE ecg.ens_configuration_id = $1 AND ecg.ens_group_id IS NOT NULL
         )
       )
     ORDER BY ec.mobile_number`,
    [configId]
  );
  return rows.map(r => r.mobile_number);
}

// ── ENS Lookup ────────────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/lookup?number=<dest>
export const ensLookup = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ success: false, error: 'number param required' });

  // Resolve via emergency_numbers table — tenant scoped through the number record
  const { rows } = await query(
    `SELECT ec.id AS configuration_id, ec.name,
            ec.blast_clid, ec.reply_clid, ec.pin,
            ec.retry_count, ec.retry_delay_seconds,
            ec.max_concurrent, ec.recording_retention_hours
     FROM emergency_numbers en
     JOIN ens_configurations ec
       ON ec.id = en.ens_configuration_id
      AND ec.tenant_id = en.tenant_id
      AND ec.deleted_at IS NULL
      AND ec.is_active = true
     WHERE en.number = $1
       AND en.type = 'ENS'
       AND en.deleted_at IS NULL
       AND en.is_active = true
     LIMIT 1`,
    [number]
  );

  if (!rows[0]) {
    return res.status(404).json({ success: false, error: 'ENS number not found' });
  }

  const cfg = rows[0];
  const contacts = await resolveEnsContacts(cfg.configuration_id);

  res.json({
    success: true,
    data: {
      configuration_id:          cfg.configuration_id,
      name:                      cfg.name,
      blast_clid:                cfg.blast_clid,
      reply_clid:                cfg.reply_clid,
      pin:                       cfg.pin,
      retry_count:               cfg.retry_count,
      retry_delay_seconds:       cfg.retry_delay_seconds,
      max_concurrent:            cfg.max_concurrent,
      recording_retention_hours: cfg.recording_retention_hours,
      contacts,
    },
  });
});

// ── Queue Status ──────────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/notifications/queue-status?configuration_id=<id>
export const ensQueueStatus = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  if (!configId) return res.status(400).json({ error: 'configuration_id required' });

  const { rows } = await query(
    `SELECT notification_uuid FROM ens_notifications
     WHERE ens_configuration_id = $1
       AND status = 'IN_PROGRESS'
       AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [configId]
  );

  if (rows[0]) {
    return res.json({ can_proceed: false, active_uuid: rows[0].notification_uuid });
  }
  res.json({ can_proceed: true, active_uuid: null });
});

// ── Create Notification ───────────────────────────────────────────────────────

// POST /api/v1/internal/ens/notifications
export const ensCreateNotification = asyncHandler(async (req, res) => {
  const d = NotificationCreateSchema.parse(req.body);

  // Verify config exists
  const { rows: [cfg] } = await query(
    `SELECT id FROM ens_configurations
     WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [d.configuration_id]
  );
  if (!cfg) return res.status(404).json({ error: 'ENS configuration not found' });

  const contacts = await resolveEnsContacts(d.configuration_id);
  const notifUuid = uuidv4();

  const { rows: [notif] } = await withTransaction(async (tq) => {
    // Insert notification
    const { rows } = await tq(
      `INSERT INTO ens_notifications
         (notification_uuid, ens_configuration_id, status, triggered_via,
          caller_number, recording_file, total_targets, started_at)
       VALUES ($1, $2, 'IN_PROGRESS', $3, $4, $5, $6, now())
       RETURNING id, notification_uuid`,
      [notifUuid, d.configuration_id, d.triggered_via,
       d.caller_number, d.recording_file, contacts.length]
    );

    const notifId = rows[0].id;

    // Pre-create PENDING delivery rows for each contact
    for (const mobile of contacts) {
      await tq(
        `INSERT INTO ens_notification_deliveries
           (ens_notification_id, contact_number, delivery_status, attempt_number)
         VALUES ($1, $2, 'PENDING', 1)
         ON CONFLICT DO NOTHING`,
        [notifId, mobile]
      );
    }

    return { rows };
  });

  emitInternal('enrs::ens_started', {
    notification_uuid: notif.notification_uuid,
    notification_id:   notif.id,
    configuration_id:  d.configuration_id,
    total_targets:     contacts.length,
  });

  res.status(201).json({
    notification_uuid: notif.notification_uuid,
    notification_id:   notif.id,
  });
});

// ── Pending Contacts ──────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/notifications/:uuid/pending-contacts
export const ensPendingContacts = asyncHandler(async (req, res) => {
  const { uuid } = req.params;

  const { rows: [notif] } = await query(
    `SELECT id FROM ens_notifications WHERE notification_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  const { rows } = await query(
    `SELECT contact_number FROM ens_notification_deliveries
     WHERE ens_notification_id = $1
       AND delivery_status NOT IN ('ANSWERED', 'REPLAYED', 'CANCELLED')
     ORDER BY contact_number`,
    [notif.id]
  );

  res.json({ contacts: rows.map(r => r.contact_number) });
});

// ── Delivery Status Update ────────────────────────────────────────────────────

// PATCH /api/v1/internal/ens/notifications/:uuid/delivery
export const ensUpdateDelivery = asyncHandler(async (req, res) => {
  const { uuid } = req.params;
  const d = DeliverySchema.parse(req.body);

  if (!validatePhone(d.contact_number)) {
    return res.status(400).json({ error: 'Invalid contact_number format' });
  }

  const { rows: [notif] } = await query(
    `SELECT id FROM ens_notifications WHERE notification_uuid = $1 AND deleted_at IS NULL`,
    [uuid]
  );
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  await withTransaction(async (tq) => {
    // Upsert delivery row
    await tq(
      `INSERT INTO ens_notification_deliveries
         (ens_notification_id, contact_number, delivery_status,
          call_uuid, hangup_cause, answered_at, attempt_number)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (ens_notification_id, contact_number)
       DO UPDATE SET
         delivery_status = EXCLUDED.delivery_status,
         call_uuid       = COALESCE(EXCLUDED.call_uuid, ens_notification_deliveries.call_uuid),
         hangup_cause    = COALESCE(EXCLUDED.hangup_cause, ens_notification_deliveries.hangup_cause),
         answered_at     = COALESCE(EXCLUDED.answered_at, ens_notification_deliveries.answered_at),
         updated_at      = now()`,
      [notif.id, d.contact_number, d.status,
       d.call_uuid, d.hangup_cause, d.answered_at]
    );

    // Atomically update counters on the parent notification
    if (d.status === 'ANSWERED') {
      await tq(
        `UPDATE ens_notifications SET total_answered = total_answered + 1 WHERE id = $1`,
        [notif.id]
      );
    } else if (d.status === 'NO_ANSWER') {
      await tq(
        `UPDATE ens_notifications SET total_no_answer = total_no_answer + 1 WHERE id = $1`,
        [notif.id]
      );
    }
  });

  emitInternal('enrs::ens_delivery', {
    notification_uuid: uuid,
    contact_number:    d.contact_number,
    status:            d.status,
  });

  res.json({ ok: true });
});

// ── Complete Notification ─────────────────────────────────────────────────────

// POST /api/v1/internal/ens/notifications/:uuid/complete
export const ensCompleteNotification = asyncHandler(async (req, res) => {
  const { uuid } = req.params;

  const { rows } = await query(
    `UPDATE ens_notifications
     SET status = 'COMPLETED', updated_at = now()
     WHERE notification_uuid = $1 AND deleted_at IS NULL
     RETURNING id, total_answered, total_no_answer, total_targets`,
    [uuid]
  );

  if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });

  emitInternal('enrs::ens_complete', {
    notification_uuid: uuid,
    total_answered:    rows[0].total_answered,
    total_no_answer:   rows[0].total_no_answer,
    total_targets:     rows[0].total_targets,
  });

  res.json({ ok: true });
});

// ── Callback Authorize ────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/callbacks/authorize?reply_clid=<clid>&caller=<number>
export const ensAuthorizeCallback = asyncHandler(async (req, res) => {
  const replyCLID = String(req.query.reply_clid || '').trim();
  const caller    = String(req.query.caller     || '').trim();

  if (!replyCLID || !caller) {
    return res.status(400).json({ error: 'reply_clid and caller params required' });
  }

  // Find ENS config by reply_clid
  const { rows: [cfg] } = await query(
    `SELECT id, recording_retention_hours FROM ens_configurations
     WHERE reply_clid = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
    [replyCLID]
  );

  if (!cfg) return res.json({ authorized: false, reason: 'no_active_notification' });

  // Find latest completed/in-progress notification within retention window
  const { rows: [notif] } = await query(
    `SELECT id, notification_uuid, recording_file
     FROM ens_notifications
     WHERE ens_configuration_id = $1
       AND status IN ('IN_PROGRESS', 'COMPLETED')
       AND deleted_at IS NULL
       AND created_at >= now() - ($2 || ' hours')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [cfg.id, cfg.recording_retention_hours]
  );

  if (!notif) return res.json({ authorized: false, reason: 'no_active_notification' });

  if (!notif.recording_file) {
    return res.json({ authorized: false, reason: 'recording_expired' });
  }

  // Check last-9-digit match on contact_number in deliveries
  const callerLast9 = caller.replace(/\D/g, '').slice(-9);

  const { rows: [delivery] } = await query(
    `SELECT id FROM ens_notification_deliveries
     WHERE ens_notification_id = $1
       AND RIGHT(REGEXP_REPLACE(contact_number, '[^0-9]', '', 'g'), 9) = $2
     LIMIT 1`,
    [notif.id, callerLast9]
  );

  if (!delivery) return res.json({ authorized: false, reason: 'not_in_blast_list' });

  res.json({
    authorized:        true,
    notification_uuid: notif.notification_uuid,
    recording_file:    notif.recording_file,
    delivery_id:       delivery.id,
  });
});

// ── Log Callback Replay ───────────────────────────────────────────────────────

// POST /api/v1/internal/ens/callbacks
export const ensLogCallback = asyncHandler(async (req, res) => {
  const d = CallbackLogSchema.parse(req.body);

  const { rows: [notif] } = await query(
    `SELECT id FROM ens_notifications
     WHERE notification_uuid = $1 AND deleted_at IS NULL`,
    [d.notification_uuid]
  );
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  await withTransaction(async (tq) => {
    await tq(
      `UPDATE ens_notification_deliveries
       SET delivery_status = 'REPLAYED', answered_at = COALESCE($2, now()), updated_at = now()
       WHERE id = $1`,
      [d.delivery_id, d.replayed_at]
    );
    await tq(
      `UPDATE ens_notifications
       SET total_replayed  = total_replayed + 1,
           callback_count  = callback_count + 1,
           updated_at      = now()
       WHERE id = $1`,
      [notif.id]
    );
  });

  emitInternal('enrs::ens_callback', {
    notification_uuid: d.notification_uuid,
    caller_number:     d.caller_number,
  });

  res.json({ ok: true });
});
