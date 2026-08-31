import path from 'node:path';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { emitInternal } from '../../services/socketService.js';
import { createCampaign, createCampaignByConfigId } from '../../services/campaignEngine.js';
import { logger } from '../../infrastructure/index.js';
import { synthesizeToFile, PiperError } from '../../services/piperClient.js';
import { fsConfig } from '../../config/fsConfig.js';

// ── Validators ────────────────────────────────────────────────────────────────

const PhoneRegex = /^[0-9+\-\s()]{7,20}$/;

function validatePhone(n) {
  return PhoneRegex.test(String(n || '').trim());
}

const DeliverySchema = z.object({
  contact_number: z.string().min(1).max(20),
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
  caller_number:    z.string().min(1).max(20).optional().nullable(),
  recording_file:   z.string().max(512).optional().nullable(),
});

const CallbackLogSchema = z.object({
  notification_uuid: z.string().uuid(),
  caller_number:     z.string().min(1).max(20),
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

  // Pre-synthesize message_text via Piper when no recording file is provided.
  // Piper produces a higher-quality WAV than FreeSWITCH's built-in flite TTS.
  // On any Piper error, fall back silently to message_text (FreeSWITCH speak).
  let resolvedRecordingFile = recording_file || null;
  let resolvedMessageText   = message_text   || null;

  if (!resolvedRecordingFile && resolvedMessageText) {
    const ttsDir = path.join(fsConfig.recordingDir, 'tts');
    try {
      resolvedRecordingFile = await synthesizeToFile(resolvedMessageText, ttsDir);
      resolvedMessageText   = null; // WAV takes over; FreeSWITCH speak not needed
      logger.info({ module: 'ensInternal', ttsDir, path: resolvedRecordingFile },
        'Piper synthesis succeeded — using WAV for campaign');
    } catch (err) {
      if (err instanceof PiperError) {
        logger.warn({ module: 'ensInternal', piperCode: err.code, err: err.message },
          'Piper unavailable — falling back to FreeSWITCH TTS for campaign');
      } else {
        logger.error({ module: 'ensInternal', err }, 'Unexpected error during Piper synthesis');
      }
      // resolvedRecordingFile stays null, resolvedMessageText stays set → FreeSWITCH speak
    }
  }

  const campaign = await createCampaign({
    triggerNumber:  trigger_number,
    triggeredVia:   'PHONE',
    triggeredBy:    null,
    recordingFile:  resolvedRecordingFile,
    messageText:    resolvedMessageText,
  });

  // Register the Lua blast recording in the unified recordings table.
  // ens_blast_trigger.lua records to recordings/ens/ before calling this endpoint.
  if (recording_file) {
    import('../recordingController.js').then(({ upsertRecordingStart }) => {
      upsertRecordingStart({
        type:       'ENS',
        recPath:    recording_file,
        campaignId: campaign.id,
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

// ── Campaign Start by Config ID (IVR ENS node) ───────────────────────────────

// POST /api/v1/internal/ens/campaign/start-by-config
// Called by ivr_executor.lua exec_ens handler.
// The IVR flow already resolved configuration_id (via ens_pin_valid condition);
// this endpoint skips the trigger_number → config lookup and goes straight to
// createCampaignByConfigId(), which creates the ens_campaigns row the campaign
// engine polls every tick.
//
// F-09 SECURITY NOTE — why tenant validation is intentionally omitted here:
//
//  1. This route is protected by INTERNAL_API_KEY (internalAuth middleware).
//     No JWT-authenticated user can reach it; only FreeSWITCH can.
//
//  2. The configuration_id this endpoint receives is embedded in a published
//     IVR flow.  At publish time, ivrGraphValidator validates every ENS node's
//     configuration_id against the IVR flow's own tenant_id
//     (ivrGraphValidator.js — `WHERE id = ANY($1) AND tenant_id = $2`).
//     A cross-tenant configuration_id cannot survive IVR flow publication.
//
//  3. The Lua executor has no access to a user JWT and therefore cannot supply
//     a tenant_id that would be meaningful for tenant-scoped lookup.  Inventing
//     one would require IVR-flow-to-tenant mapping changes in Lua and the
//     internal API contract — a larger change than the risk warrants.
//
//  4. The remaining residual risk (compromised INTERNAL_API_KEY) is the same
//     for all internal endpoints and is mitigated operationally (key rotation,
//     firewall rules, nginx deny on WAN).
//
// Do NOT add a tenantId guard here without verifying that the IVR executor
// can supply a reliable tenant context and that the Lua contract is updated.
export const startCampaignByConfig = asyncHandler(async (req, res) => {
  const configId = parseInt(req.body.configuration_id, 10);
  if (!configId || configId <= 0) {
    return res.status(400).json({ success: false, error: 'configuration_id required' });
  }

  let campaign;
  try {
    campaign = await createCampaignByConfigId({
      configId,
      triggeredBy:  null,
      triggeredVia: 'PHONE',
      recordingFile: req.body.recording_file || null,
      messageText:   null,
    });
  } catch (err) {
    throw err; // let asyncHandler/errorHandler handle it
  }

  res.status(201).json({
    success:            true,
    campaign_id:        campaign.id,
    status:             campaign.status,
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
            ec.blast_clid, ec.reply_clid, ec.sip_gateway,
            ec.pin,
            COALESCE(ec.max_concurrent_calls, 30)     AS max_concurrent_calls,
            COALESCE(ec.calls_per_second, 2)          AS calls_per_second,
            COALESCE(ec.batch_size, 30)               AS batch_size,
            COALESCE(ec.max_attempts, 3)              AS max_attempts,
            COALESCE(ec.retry_interval_sec, 60)       AS retry_interval_sec,
            COALESCE(ec.campaign_timeout_min, 60)     AS campaign_timeout_min,
            COALESCE(ec.recording_retention_hours, 24) AS recording_retention_hours,
            COALESCE(ec.campaign_priority, 5)         AS campaign_priority,
            COALESCE(ec.adaptive_throttling, false)   AS adaptive_throttling,
            COALESCE(ec.retry_failed_only, false)     AS retry_failed_only,
            ec.no_pending_source_type, ec.no_pending_msg, ec.no_pending_audio_url,
            ec.expiry_source_type, ec.expiry_announcement, ec.expiry_audio_url,
            ec.unauthorized_source_type, ec.unauthorized_msg, ec.unauthorized_audio_url
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
      blast_clid:                cfg.blast_clid,
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
      no_pending_source_type:    cfg.no_pending_source_type   || 'tts',
      no_pending_msg:            cfg.no_pending_msg,
      no_pending_audio_url:      cfg.no_pending_audio_url,
      expiry_source_type:        cfg.expiry_source_type       || 'tts',
      expiry_announcement:       cfg.expiry_announcement,
      expiry_audio_url:          cfg.expiry_audio_url,
      unauthorized_source_type:  cfg.unauthorized_source_type || 'tts',
      unauthorized_msg:          cfg.unauthorized_msg,
      unauthorized_audio_url:    cfg.unauthorized_audio_url,
      contacts,
    },
  });
});

// ── Queue Status ──────────────────────────────────────────────────────────────

// GET /api/v1/internal/ens/notifications/queue-status?configuration_id=<id>
export const ensQueueStatus = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  if (!configId) return res.status(400).json({ error: 'configuration_id required' });

  // Check legacy ens_notifications path (Lua direct-write or UI PENDING).
  const { rows: legacyRows } = await query(
    `SELECT notification_uuid FROM ens_notifications
     WHERE ens_configuration_id = $1
       AND status IN ('IN_PROGRESS', 'PENDING')
       AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [configId]
  );
  if (legacyRows[0]) {
    return res.json({ can_proceed: false, active_uuid: legacyRows[0].notification_uuid });
  }

  // Check modern ens_campaigns path (campaign engine).
  const { rows: campaignRows } = await query(
    `SELECT id::TEXT AS active_uuid FROM ens_campaigns
     WHERE ens_configuration_id = $1
       AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    [configId]
  );
  if (campaignRows[0]) {
    return res.json({ can_proceed: false, active_uuid: campaignRows[0].active_uuid });
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
  if (!cfg) {
    return res.status(404).json({ error: 'ENS configuration not found' });
  }

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
    `SELECT id, COALESCE(recording_retention_hours, 24) AS recording_retention_hours
     FROM ens_configurations
     WHERE reply_clid = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
    [replyCLID]
  );

  if (!cfg) return res.json({ authorized: false, reason: 'no_active_notification' });

  // Normalize caller to last-9 digits — same convention as ensLatestCampaign.
  const callerLast9 = caller.replace(/\D/g, '').slice(-9);

  // Stage 1: verify caller is a destination in ANY campaign for this configuration.
  // Expiry window uses COALESCE(completed_at, started_at, created_at) so campaigns
  // that started/completed late are not prematurely denied.
  const { rows: [dest] } = await query(
    `SELECT d.id, d.campaign_id
     FROM ens_campaign_destinations d
     JOIN ens_campaigns c ON c.id = d.campaign_id
     WHERE c.ens_configuration_id = $1
       AND c.status IN ('running', 'completed')
       AND c.recording_file IS NOT NULL
       AND COALESCE(c.completed_at, c.started_at, c.created_at)
             >= now() - ($2 || ' hours')::interval
       AND RIGHT(REGEXP_REPLACE(d.phone_number, '[^0-9]', '', 'g'), 9) = $3
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [cfg.id, cfg.recording_retention_hours, callerLast9]
  );

  if (!dest) return res.json({ authorized: false, reason: 'no_active_notification' });

  // Fetch the recording file for the authorized campaign.
  const { rows: [campaign] } = await query(
    `SELECT id AS campaign_id, recording_file FROM ens_campaigns WHERE id = $1`,
    [dest.campaign_id]
  );

  if (!campaign?.recording_file) {
    return res.json({ authorized: false, reason: 'recording_expired' });
  }

  res.json({
    authorized:        true,
    notification_uuid: campaign.campaign_id,
    recording_file:    campaign.recording_file,
    delivery_id:       dest.id,
  });
});

// ── Latest Campaign (for playback number) ────────────────────────────────────

// GET /api/v1/internal/ens/campaigns/latest?configuration_id=<id>&caller=<number>
// Called by ens_playback_handler.lua to authorize and select the most recent
// playable recording for a specific caller within a specific ENS configuration.
//
// Security model (three stages):
//
//   Stage 1 — Configuration
//     configuration_id is resolved server-side by ens_playback_handler.lua from the
//     dialled number via /ens/lookup. The caller cannot supply it directly.
//
//   Stage 2 — Authorization
//     Checks whether the normalized caller number exists in ens_campaign_destinations
//     for ANY running/completed campaign in this configuration (regardless of expiry).
//     This separates "not in the blast list" (UNAUTHORIZED) from "authorized but no
//     current message" (NO_CAMPAIGN) and "authorized but message expired" (EXPIRED).
//
//   Stage 3 — Latest playable campaign
//     Among campaigns where the caller IS a destination, finds the most recently
//     created campaign that (a) has playable audio and (b) is within the retention
//     window. Expiry clock uses COALESCE(completed_at, started_at, created_at) so
//     campaigns triggered late do not lose retention time to their queuing delay.
//
//     "Latest" means latest FOR THIS CALLER, not latest for the configuration.
//     A newer campaign that does not include the caller cannot hide an older valid one.
//
//   Responses:
//     { authorized: false, status: 'UNAUTHORIZED' }
//       — caller not in any campaign destination for this configuration
//       — no campaign details exposed
//     { authorized: true, status: 'NO_CAMPAIGN' }
//       — caller is authorized but has no campaigns, or all campaigns lack audio
//     { authorized: true, status: 'EXPIRED' }
//       — caller is authorized but their latest available campaign has expired
//     { authorized: true, status: 'ACTIVE', source_type, recording_file|message_audio_url, … }
//       — caller is authorized and a playable recording exists
//
// 'queued' campaigns are excluded throughout: a recipient cannot have received a call
// from a campaign that has not started dialing.
export const ensLatestCampaign = asyncHandler(async (req, res) => {
  const configId = parseInt(req.query.configuration_id, 10);
  const callerRaw = String(req.query.caller || '').trim();

  if (!configId) return res.status(400).json({ success: false, error: 'configuration_id required' });
  if (!callerRaw) return res.status(400).json({ success: false, error: 'caller required' });

  // Normalize to last 9 digits — same convention as ensAuthorizeCallback.
  const callerLast9 = callerRaw.replace(/\D/g, '').slice(-9);
  if (!callerLast9) return res.status(400).json({ success: false, error: 'caller must contain digits' });

  // Fetch retention hours. Config must be active.
  const { rows: [cfg] } = await query(
    `SELECT COALESCE(recording_retention_hours, 24) AS retention_hours
     FROM ens_configurations WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [configId]
  );
  if (!cfg) return res.status(404).json({ success: false, error: 'ENS configuration not found' });

  // ── Stage 2: Authorization ──────────────────────────────────────────────────
  // Check whether the caller exists in ANY campaign destination for this
  // configuration, considering only campaigns that could have reached the caller
  // (running or completed). Expiry is NOT applied here — we want to distinguish
  // "never authorized" (UNAUTHORIZED) from "authorized but all messages expired".
  const { rows: [authRow] } = await query(
    `SELECT 1
     FROM ens_campaign_destinations d
     JOIN ens_campaigns c ON c.id = d.campaign_id
     WHERE c.ens_configuration_id = $1
       AND c.status IN ('running', 'completed')
       AND RIGHT(REGEXP_REPLACE(d.phone_number, '[^0-9]', '', 'g'), 9) = $2
     LIMIT 1`,
    [configId, callerLast9]
  );

  if (!authRow) {
    // No campaign in this configuration has ever targeted this caller.
    // Return an opaque unauthorized response — do not expose campaign existence.
    return res.json({ authorized: false, status: 'UNAUTHORIZED' });
  }

  // ── Stage 3: Latest playable campaign for this caller ──────────────────────
  // Among campaigns that DO include this caller, find the most recently created
  // one that has playable audio and is within the retention window.
  // recording_file takes priority; message_audio_url is the fallback.
  // Expiry uses COALESCE(completed_at, started_at, created_at) so late-starting
  // campaigns do not lose retention time to their queuing delay.
  const { rows: [latest] } = await query(
    `SELECT c.id AS campaign_id,
            c.recording_file,
            c.message_audio_url,
            c.created_at,
            COALESCE(c.completed_at, c.started_at, c.created_at)
              + ($3 || ' hours')::interval AS expires_at
     FROM ens_campaigns c
     JOIN ens_campaign_destinations d ON d.campaign_id = c.id
       AND RIGHT(REGEXP_REPLACE(d.phone_number, '[^0-9]', '', 'g'), 9) = $2
     WHERE c.ens_configuration_id = $1
       AND c.status IN ('running', 'completed')
       AND (c.recording_file IS NOT NULL OR c.message_audio_url IS NOT NULL)
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [configId, callerLast9, cfg.retention_hours]
  );

  if (!latest) {
    // Caller is authorized (found in Stage 2) but has no campaigns with audio.
    return res.json({ authorized: true, status: 'NO_CAMPAIGN' });
  }

  const expired = new Date() > new Date(latest.expires_at);
  if (expired) {
    // Latest available campaign for this caller has expired.
    return res.json({ authorized: true, status: 'EXPIRED' });
  }

  // Determine source type — recording_file takes precedence over message_audio_url.
  const sourceType = latest.recording_file ? 'recording' : 'url';
  const audioField = latest.recording_file
    ? { recording_file: latest.recording_file }
    : { message_audio_url: latest.message_audio_url };

  res.json({
    authorized:  true,
    status:      'ACTIVE',
    campaign_id: latest.campaign_id,
    source_type: sourceType,
    ...audioField,
    created_at:  latest.created_at,
    expires_at:  latest.expires_at,
  });
});

// ── Playback Log (called by ens_playback_handler.lua) ────────────────────────

// GET /api/v1/internal/ens/campaigns/:id/playback-log?caller=<number>
// campaign id is a UUID string — do not parseInt.
//
// Previous behaviour (broken): parseInt(req.params.id) on a UUID → NaN → 400.
//   Also attempted UPDATE ens_campaigns SET updated_at (placeholder with no
//   business value — ens_campaigns has no playback-specific counter columns).
//
// New behaviour (Wave 1): read-only. Validates parameters and returns { success: true }.
//   Lua's ens_playback_handler.lua checks only the HTTP 200 status — the response
//   body is ignored. No DB write is performed.
//   Playback analytics (who played back which campaign and when) are a Wave 2+ item
//   requiring a dedicated playback_log table.
export const ensPlaybackLog = asyncHandler(async (req, res) => {
  const campaignId = String(req.params.id || '').trim();
  const caller     = String(req.query.caller || '').trim();

  if (!campaignId || !caller) {
    return res.status(400).json({ success: false, error: 'id and caller required' });
  }

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
