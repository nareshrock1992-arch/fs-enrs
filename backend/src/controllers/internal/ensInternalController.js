import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';
import { createCampaign } from '../../services/campaignEngine.js';

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

// Exported so scripts/verify-api-contracts.js can statically cross-check
// every field name the generated Lua sends against what this endpoint
// actually accepts, without needing a live server.
export const NotificationCreateSchema = z.object({
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

// Resolve all dialable numbers for an ENS config (groups + direct contacts).
// Reads from emergency_contacts / responder_groups — the same tables the public
// controller writes to when saving ENS configurations.
//
// Phase 5 (B5): a blast must reach BOTH channels per contact — internal
// extension AND mobile number. Previously this was mobile-only, which
// silently skipped desk phones entirely. Each contact now contributes up
// to two entries; the campaign engine dials each as its own delivery leg
// (the delivery table is keyed per contact_number, so the two channels
// get independent answer/retry tracking, which is what you want — a desk
// phone answering must not cancel the mobile leg's record and vice versa).
async function resolveEnsContacts(configId) {
  const { rows } = await query(
    `SELECT DISTINCT c.mobile_number, c.extension_number
     FROM emergency_contacts c
     WHERE c.deleted_at IS NULL AND c.is_active = true
       AND (c.mobile_number IS NOT NULL OR c.extension_number IS NOT NULL)
       AND (
         -- Direct contact mapping (emergency_contact_id path)
         c.id IN (
           SELECT emergency_contact_id
           FROM   ens_configuration_contacts
           WHERE  ens_configuration_id = $1
             AND  emergency_contact_id IS NOT NULL
         )
         OR
         -- Group mapping via responder_groups (responder_group_id path)
         c.id IN (
           SELECT rgm.emergency_contact_id
           FROM   responder_group_members rgm
           JOIN   ens_configuration_groups ecg
                  ON ecg.responder_group_id = rgm.responder_group_id
           WHERE  ecg.ens_configuration_id = $1
             AND  ecg.responder_group_id IS NOT NULL
         )
       )`,
    [configId]
  );
  const numbers = new Set();
  for (const r of rows) {
    if (r.mobile_number)    numbers.add(r.mobile_number);
    if (r.extension_number) numbers.add(r.extension_number);
  }
  return [...numbers].sort();
}

// ── PIN Verification ──────────────────────────────────────────────────────────

// POST /api/v1/internal/ens/verify-pin
// Lua calls this after collecting DTMF digits, before recording the blast.
// { trigger_number, pin }
// → { authorized: true } or 401 { authorized: false, error }
export const verifyPin = asyncHandler(async (req, res) => {
  const { trigger_number, pin } = req.body;

  if (!trigger_number) {
    return res.status(400).json({ success: false, error: 'trigger_number required' });
  }

  const { rows: [cfg] } = await query(
    `SELECT ec.pin
     FROM emergency_numbers en
     JOIN ens_configurations ec
       ON ec.id = en.ens_configuration_id
      AND ec.deleted_at IS NULL
      AND ec.is_active = true
     WHERE en.number = $1
       AND en.type = 'ENS'
       AND en.deleted_at IS NULL
       AND en.is_active = true
     LIMIT 1`,
    [trigger_number]
  );

  if (!cfg) {
    return res.status(404).json({ success: false, error: 'ENS service not found' });
  }

  // No PIN configured on this service — always authorized
  if (!cfg.pin) {
    return res.json({ success: true, authorized: true, pin_required: false });
  }

  if (cfg.pin !== String(pin || '').trim()) {
    return res.status(401).json({ success: false, authorized: false, pin_required: true, error: 'Invalid PIN' });
  }

  res.json({ success: true, authorized: true, pin_required: true });
});

// ── Campaign Start (Lua calls this after recording message) ──────────────────

// POST /api/v1/internal/ens/campaign/start
// Lua sends: { trigger_number, recording_file, caller_number, pin }
// If the ENS service has a PIN configured, pin must be supplied and correct.
export const startCampaign = asyncHandler(async (req, res) => {
  const { trigger_number, recording_file, caller_number, message_text, pin } = req.body;

  if (!trigger_number) {
    return res.status(400).json({ success: false, error: 'trigger_number required' });
  }
  if (!recording_file && !message_text) {
    return res.status(400).json({ success: false, error: 'recording_file or message_text required' });
  }

  // PIN guard — defense-in-depth (Lua should call verify-pin first, but also
  // checked here so the endpoint cannot be bypassed directly)
  const { rows: [cfg] } = await query(
    `SELECT ec.pin
     FROM emergency_numbers en
     JOIN ens_configurations ec
       ON ec.id = en.ens_configuration_id
      AND ec.deleted_at IS NULL AND ec.is_active = true
     WHERE en.number = $1 AND en.type = 'ENS'
       AND en.deleted_at IS NULL AND en.is_active = true
     LIMIT 1`,
    [trigger_number]
  );

  if (cfg?.pin && cfg.pin !== String(pin || '').trim()) {
    return res.status(401).json({ success: false, error: 'PIN required or invalid' });
  }

  const campaign = await createCampaign({
    triggerNumber:  trigger_number,
    triggeredVia:   'PHONE',
    triggeredBy:    null,
    recordingFile:  recording_file || null,
    messageText:    message_text   || null,
  });

  // Register the Lua blast recording in the unified recordings table.
  // blast_call.lua records to recordings/ens/ before calling this endpoint.
  if (recording_file) {
    import('../recordingController.js').then(({ upsertRecordingStart }) => {
      upsertRecordingStart({
        type:       'ENS',
        recPath:    recording_file,
        campaignId: campaign.notification_uuid ?? null,
        createdBy:  'lua',
      }).then(row => {
        if (!row) return;
        import('../../db/pool.js').then(({ query }) => {
          query(
            `UPDATE recordings SET status='COMPLETED', ended_at=now()
             WHERE id=$1 AND status='RECORDING'`,
            [row.id]
          ).catch(() => {});
        });
      }).catch(err => console.error('[ens] recording registration failed:', err.message));
    }).catch(() => {});
  }

  res.status(201).json({
    success:     true,
    campaign_id: campaign.id,
    status:      campaign.status,
    total_destinations: campaign.total_destinations,
  });
});

// ── ENS Lookup ────────────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/lookup?number=<dest>
export const ensLookup = asyncHandler(async (req, res) => {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ success: false, error: 'number param required' });

  const { rows } = await query(
    `SELECT ec.id AS configuration_id, ec.name,
            ec.blast_clid, ec.reply_clid, ec.sip_caller_id, ec.sip_gateway,
            ec.pin,
            COALESCE(ec.max_concurrent_calls, ec.max_concurrent, 30)  AS max_concurrent_calls,
            COALESCE(ec.calls_per_second, 2)                           AS calls_per_second,
            COALESCE(ec.batch_size, 30)                                AS batch_size,
            COALESCE(ec.max_attempts, ec.retry_count, 3)               AS max_attempts,
            COALESCE(ec.retry_interval_sec, ec.retry_delay_seconds, 60) AS retry_interval_sec,
            COALESCE(ec.campaign_timeout_min, 60)                      AS campaign_timeout_min,
            COALESCE(ec.recording_retention_hours, 24)                 AS recording_retention_hours,
            COALESCE(ec.campaign_priority, 5)                          AS campaign_priority,
            COALESCE(ec.adaptive_throttling, false)                    AS adaptive_throttling,
            COALESCE(ec.retry_failed_only, false)                      AS retry_failed_only,
            ec.playback_number, ec.no_pending_msg, ec.expiry_announcement
     FROM emergency_numbers en
     JOIN ens_configurations ec
       ON ec.id = en.ens_configuration_id
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
      blast_clid:                cfg.blast_clid || cfg.sip_caller_id,
      reply_clid:                cfg.reply_clid,
      sip_gateway:               cfg.sip_gateway,
      // pin_required tells Lua to collect DTMF before recording.
      // The actual PIN value is never sent to Lua — verification goes through verify-pin.
      pin_required:              Boolean(cfg.pin),
      max_concurrent_calls:      cfg.max_concurrent_calls,
      calls_per_second:          cfg.calls_per_second,
      batch_size:                cfg.batch_size,
      max_attempts:              cfg.max_attempts,
      retry_interval_sec:        cfg.retry_interval_sec,
      campaign_timeout_min:      cfg.campaign_timeout_min,
      recording_retention_hours: cfg.recording_retention_hours,
      campaign_priority:         cfg.campaign_priority,
      adaptive_throttling:       cfg.adaptive_throttling,
      retry_failed_only:         cfg.retry_failed_only,
      playback_number:           cfg.playback_number,
      no_pending_msg:            cfg.no_pending_msg,
      expiry_announcement:       cfg.expiry_announcement,
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

// ── Latest Campaign (for playback number) ────────────────────────────────────

// GET /api/v1/internal/ens/campaigns/latest?configuration_id=<id>
// Called by ENS_retry_playback.lua to get the most recent recording to play back.
// Returns: { status: "ACTIVE"|"EXPIRED"|"NO_CAMPAIGN", recording_file, campaign_id }
export const ensLatestCampaign = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  if (!configId) return res.status(400).json({ success: false, error: 'configuration_id required' });

  // Get retention hours from config
  const { rows: [cfg] } = await query(
    `SELECT COALESCE(recording_retention_hours, 24) AS retention_hours
     FROM ens_configurations WHERE id = $1 AND deleted_at IS NULL`,
    [configId]
  );
  if (!cfg) return res.status(404).json({ success: false, error: 'ENS configuration not found' });

  const { rows: [latest] } = await query(
    `SELECT id AS campaign_id, recording_file,
            status, created_at,
            created_at + ($2 || ' hours')::interval AS expires_at
     FROM ens_notifications
     WHERE ens_configuration_id = $1
       AND deleted_at IS NULL
       AND status IN ('IN_PROGRESS', 'COMPLETED')
     ORDER BY created_at DESC LIMIT 1`,
    [configId, cfg.retention_hours]
  );

  if (!latest) {
    return res.json({ success: true, status: 'NO_CAMPAIGN', recording_file: null, campaign_id: null });
  }

  if (!latest.recording_file) {
    return res.json({ success: true, status: 'NO_CAMPAIGN', recording_file: null, campaign_id: latest.campaign_id });
  }

  const expired = new Date() > new Date(latest.expires_at);
  if (expired) {
    return res.json({ success: true, status: 'EXPIRED', recording_file: null, campaign_id: latest.campaign_id });
  }

  res.json({
    success:        true,
    status:         'ACTIVE',
    campaign_id:    latest.campaign_id,
    recording_file: latest.recording_file,
    created_at:     latest.created_at,
    expires_at:     latest.expires_at,
  });
});

// ── Playback Log (called by ENS_retry_playback.lua) ──────────────────────────

// GET /api/v1/internal/ens/campaigns/:id/playback-log?caller=<number>
export const ensPlaybackLog = asyncHandler(async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const caller     = String(req.query.caller || '').trim();

  if (!campaignId || !caller) {
    return res.status(400).json({ success: false, error: 'id and caller required' });
  }

  // Increment playback counter (best-effort, non-critical)
  await query(
    `UPDATE ens_notifications
     SET callback_count = callback_count + 1, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [campaignId]
  ).catch(() => {});

  res.json({ success: true });
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
