/**
 * ENS Campaign Engine
 *
 * Backend-owned outbound campaign manager.
 * Lua only records the message and calls POST /internal/campaign/start.
 * This engine handles ALL concurrency, scheduling, retry, and ESL origination.
 *
 * Design principles:
 *  - One tick/second — fills available concurrent slots
 *  - Pre-assigned call UUIDs via origination_uuid FS variable
 *  - Crash-safe: all state in DB; in-memory only for performance
 *  - Advisory lock prevents multi-process races (PM2 cluster mode safe)
 *  - ESL events routed here via eslEvents EventEmitter (no circular import)
 */

import { randomUUID }  from 'crypto';
import { query, withTransaction } from '../db/pool.js';
import { originateCampaignCall } from './eslService.js';
import { emitInternal } from './socketService.js';
import { config } from '../config/index.js';
import { logger } from '../infrastructure/index.js';

// ── Constants ────────────────────────────────────────────────────────────────

const TICK_MS          = 1000;
const ORIGINATE_TIMEOUT = 30;  // seconds before FreeSWITCH gives up on an outbound leg
const STALE_DIALING_SEC = 90;  // reset 'dialing' rows stuck longer than this (crash recovery)

const RETRYABLE_CAUSES = new Set([
  'BUSY', 'USER_BUSY', 'NO_ANSWER', 'CALL_REJECTED',
  'NORMAL_CIRCUIT_CONGESTION', 'SWITCH_CONGESTION',
  'NO_ROUTE_DESTINATION', 'ORIGINATOR_CANCEL',
]);

const BUSY_CAUSES = new Set(['BUSY', 'USER_BUSY', 'NORMAL_CIRCUIT_CONGESTION', 'SWITCH_CONGESTION']);

// ── Local helpers ─────────────────────────────────────────────────────────────

// Apply ENS mobile dialing rules (prefix, strip leading zero, suffix).
// Formatting is owned by the ENS configuration, not the gateway.
// Only applied in gateway mode — internal routing uses the raw extension.
function applyMobileFormatting(raw, cfg) {
  if (!cfg.mobile_normalize_enabled) return raw;
  let n = String(raw || '').trim();
  if (!n) return n;
  if (cfg.mobile_strip_leading_zero && n.startsWith('0')) n = n.slice(1);
  if (cfg.mobile_prefix) n = cfg.mobile_prefix + n;
  if (cfg.mobile_suffix) n = n + cfg.mobile_suffix;
  return n;
}

// Apply ENS extension dialing rules (prefix / suffix).
// Only applied in gateway mode — internal routing uses user/<ext> directly.
function applyExtensionFormatting(raw, cfg) {
  if (!cfg.ext_normalize_enabled) return raw;
  let n = String(raw || '').trim();
  if (!n) return n;
  if (cfg.ext_prefix) n = cfg.ext_prefix + n;
  if (cfg.ext_suffix) n = n + cfg.ext_suffix;
  return n;
}

// Load active gateways for a tenant — name lookup only.
// Formatting is now owned by ENS configuration, not the gateway.
async function loadGatewayMap(tenantId) {
  const { rows } = await query(
    `SELECT id, name FROM sip_gateways
     WHERE tenant_id = $1 AND is_active = true AND deleted_at IS NULL`,
    [tenantId]
  );
  return {
    byId:   new Map(rows.map(g => [g.id,   g])),
    byName: new Map(rows.map(g => [g.name, g])),
  };
}

// Resolve one contact into a dial target.
// Returns { skip: false, phone_number, gateway_name, target_type,
//           original_number, routing_mode_used }
//      or { skip: true, reason }.
//
// Gateway priority chain (name-based — FreeSWITCH uses sofia/gateway/<name>):
//   contact.gateway_id → cfg.sip_gateway → platform default → internal
//
// ENS config owns ALL dialing policy:
//   routing_mode    — auto | internal_only | gateway_only
//   dial_preference — extension_only | mobile_only | extension_mobile | mobile_extension
//   allow_mobile    — whether mobile numbers are permitted
//   allow_extension — whether extension numbers are permitted
//   mobile_*/ext_*  — formatting rules applied in gateway mode
function resolveContact(contact, cfg, gateways) {
  const routingMode    = cfg.routing_mode    || 'auto';
  const dialPreference = cfg.dial_preference || 'extension_mobile';

  // Step 1: Gateway priority chain
  let gwName = cfg.gateway_override?.trim() || null;

  if (!gwName && contact.gateway_id) {
    const gw = gateways.byId.get(contact.gateway_id);
    gwName = gw?.name || null;
  }
  if (!gwName && cfg.sip_gateway) {
    const gw = gateways.byName.get(cfg.sip_gateway);
    gwName = gw?.name || cfg.sip_gateway;
  }
  if (!gwName) {
    const platformGw = config.freeswitch?.defaultGateway || null;
    if (platformGw && gateways.byName.has(platformGw)) gwName = platformGw;
  }

  // Step 2: Determine routing mode
  let isGatewayMode;
  if      (routingMode === 'internal_only') { isGatewayMode = false; gwName = null; }
  else if (routingMode === 'gateway_only')  {
    isGatewayMode = true;
    if (!gwName) return { skip: true, reason: 'gateway_only_mode_but_no_gateway_configured' };
  } else {
    isGatewayMode = !!gwName;
  }

  const ext = contact.extension_number || null;
  const mob = contact.mobile_number    || null;

  // Step 3: ENS config capability flags
  const allowMobile    = cfg.allow_mobile    ?? true;
  const allowExtension = cfg.allow_extension ?? false;

  // Step 4: Number selection per dial_preference + ENS capability flags
  let raw        = null;
  let targetType = null;
  let skipReason = null;

  switch (dialPreference) {
    case 'extension_only':
      if      (ext && allowExtension) { raw = ext; targetType = 'extension'; }
      else if (!ext)                   skipReason = 'no_extension_number';
      else                             skipReason = 'extension_not_allowed';
      break;

    case 'mobile_only':
      if      (mob && allowMobile) { raw = mob; targetType = 'mobile'; }
      else if (!mob)                skipReason = 'no_mobile_number';
      else                          skipReason = 'mobile_not_allowed';
      break;

    case 'extension_mobile':
      if      (ext && allowExtension) { raw = ext; targetType = 'extension'; }
      else if (mob && allowMobile)    { raw = mob; targetType = 'mobile'; }
      else if (!ext && !mob)           skipReason = 'no_dialable_number';
      else                             skipReason = 'no_allowed_target';
      break;

    case 'mobile_extension':
      if      (mob && allowMobile)    { raw = mob; targetType = 'mobile'; }
      else if (ext && allowExtension) { raw = ext; targetType = 'extension'; }
      else if (!ext && !mob)           skipReason = 'no_dialable_number';
      else                             skipReason = 'no_allowed_target';
      break;

    default:
      raw = ext || mob;
      targetType = ext ? 'extension' : 'mobile';
      if (!raw) skipReason = 'no_dialable_number';
  }

  if (skipReason) return { skip: true, reason: skipReason };

  // Step 5: Apply ENS formatting rules (gateway mode only — internal uses user/<ext>)
  let phone_number;
  if (isGatewayMode) {
    phone_number = targetType === 'mobile'
      ? applyMobileFormatting(raw, cfg)
      : applyExtensionFormatting(raw, cfg);
  } else {
    phone_number = raw;
  }

  return {
    skip:             false,
    phone_number,
    gateway_name:     isGatewayMode ? (gwName || null) : null,
    target_type:      targetType,
    original_number:  raw,
    routing_mode_used: isGatewayMode ? 'gateway' : 'internal',
  };
}

// Resolve all contacts into dial targets before the campaign transaction.
// Loads gateways once, then applies per-contact resolution.
// skip_behavior controls what happens when a contact cannot be dialed:
//   'skip' / 'warn' — exclude the contact, log WARN, campaign continues
//   'fail'          — throw 422; the campaign cannot be created
async function resolveDialTargets(contacts, cfg) {
  const gateways    = await loadGatewayMap(cfg.tenant_id);
  const skipBehavior = cfg.skip_behavior || 'skip';
  const resolved    = [];
  const skipped     = [];

  for (const c of contacts) {
    const result = resolveContact(c, cfg, gateways);

    if (result.skip) {
      if (skipBehavior === 'fail') {
        throw Object.assign(
          new Error(
            `Campaign cannot be created: contact ${c.id} (${c.name || 'unnamed'}) ` +
            `cannot be dialed — ${result.reason}`
          ),
          { status: 422 }
        );
      }
      logger.warn({
        module:    'campaignEngine',
        contactId: c.id,
        name:      c.name,
        reason:    result.reason,
      }, 'Contact skipped — no dialable target');
      skipped.push({ contact_id: c.id, name: c.name, reason: result.reason });
    } else {
      resolved.push({
        contact_id:        c.id || null,
        phone_number:      result.phone_number,
        name:              c.name || null,
        gateway_name:      result.gateway_name      || null,
        target_type:       result.target_type       || null,
        original_number:   result.original_number   || null,
        routing_mode_used: result.routing_mode_used || null,
      });
    }
  }

  return { resolved, skipped };
}

// ── In-memory state ───────────────────────────────────────────────────────────

// Per-campaign adaptive state (non-critical — rebuilt from DB on restart)
const campaignState = new Map(); // campaignId → { busyTotal, callTotal, cpsHistory[] }

let ticking              = false;
let engineTimer          = null;
let lastStaleRecoveryMs  = 0;
const STALE_RECOVERY_INTERVAL_MS = 60_000;

// ── Engine lifecycle ─────────────────────────────────────────────────────────

export function startEngine() {
  if (engineTimer) return;
  engineTimer = setInterval(tick, TICK_MS);
  logger.info({ module: 'campaignEngine' }, 'Engine started');
  recoverStaleDialing().catch(e =>
    logger.error({ module: 'campaignEngine', err: e }, 'Stale dialing recovery error')
  );
}

export function stopEngine() {
  if (engineTimer) { clearInterval(engineTimer); engineTimer = null; }
  campaignState.clear();
  logger.info({ module: 'campaignEngine' }, 'Engine stopped');
}

// ── Crash recovery: reset dialing rows that were orphaned ────────────────────

async function recoverStaleDialing() {
  // Reset 'dialing' rows orphaned by a crash (no CHANNEL_HANGUP will ever arrive).
  const { rows: dialingRows } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'queued', call_uuid = null, next_attempt_at = now() + interval '5 seconds',
         updated_at = now()
     WHERE status = 'dialing'
       AND last_attempt_at < now() - ($1 || ' seconds')::interval
     RETURNING campaign_id`,
    [STALE_DIALING_SEC]
  );

  // Complete 'answered' rows that survived a crash. The call was answered so
  // treat it as delivered rather than queueing a retry.
  const STALE_ANSWERED_SEC = 600;
  const { rows: answeredRows } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'completed', hangup_cause = 'RECOVERY', completed_at = now(),
         call_uuid = null, updated_at = now()
     WHERE status = 'answered'
       AND answered_at < now() - ($1 || ' seconds')::interval
     RETURNING campaign_id`,
    [STALE_ANSWERED_SEC]
  );

  const allRows = [...dialingRows, ...answeredRows];
  if (allRows.length) {
    logger.info({ module: 'campaignEngine', dialing: dialingRows.length, answered: answeredRows.length },
      'Recovered stale destination rows');
    const campaignIds = [...new Set(allRows.map(r => r.campaign_id))];
    for (const id of campaignIds) {
      await syncCampaignCounters(id);
    }
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    if (now - lastStaleRecoveryMs > STALE_RECOVERY_INTERVAL_MS) {
      lastStaleRecoveryMs = now;
      recoverStaleDialing().catch(e =>
        logger.error({ module: 'campaignEngine', err: e }, 'Periodic stale dialing recovery error')
      );
    }
    await processAllCampaigns();
  } catch (e) {
    logger.error({ module: 'campaignEngine', err: e }, 'Tick error');
  } finally {
    ticking = false;
  }
}

async function processAllCampaigns() {
  const { rows: campaigns } = await query(
    `SELECT * FROM ens_campaigns
     WHERE status IN ('queued','running')
       AND (scheduled_at IS NULL OR scheduled_at <= now())
     ORDER BY campaign_priority DESC, created_at ASC`
  );
  for (const c of campaigns) {
    await processCampaign(c).catch(e =>
      logger.error({ module: 'campaignEngine', campaignId: c.id, err: e }, 'Campaign tick error')
    );
  }
}

async function processCampaign(campaign) {

  // Transition queued → running (idempotent via WHERE status='queued')
  if (campaign.status === 'queued') {
    const { rows: [started] } = await query(
      `UPDATE ens_campaigns
       SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING id`,
      [campaign.id]
    );
    if (started) {
      emitInternal('enrs::campaign_started', { campaign_id: campaign.id });
      campaign.status = 'running';
    }
  }

  // Enforce campaign timeout
  if (campaign.campaign_timeout_min && campaign.started_at) {
    const elapsedMin = (Date.now() - new Date(campaign.started_at).getTime()) / 60000;
    if (elapsedMin >= campaign.campaign_timeout_min) {
      await expireCampaign(campaign.id);
      return;
    }
  }

  // Current dialing count from DB (authoritative).
  // 'pending' counts queued rows whose retry window hasn't opened yet — they
  // must block the completion gate or the campaign closes before the retry fires.
  const { rows: [counts] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('dialing','answered'))::INT AS dialing,
       COUNT(*) FILTER (WHERE status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now()))::INT AS ready,
       COUNT(*) FILTER (WHERE status = 'queued'
         AND next_attempt_at > now())::INT AS pending
     FROM ens_campaign_destinations WHERE campaign_id = $1`,
    [campaign.id]
  );

  const { dialing, ready, pending } = counts;

  // Update peak concurrent
  if (dialing > campaign.peak_concurrent) {
    await query(
      `UPDATE ens_campaigns SET peak_concurrent = $2, dialing_count = $2, updated_at = now()
       WHERE id = $1`,
      [campaign.id, dialing]
    );
  }

  // No work to do — all destinations are in a terminal or future-scheduled state
  if (ready === 0 && dialing === 0 && pending === 0) {
    await completeCampaign(campaign.id);
    return;
  }

  const availableSlots = Math.max(0, campaign.max_concurrent - dialing);
  if (availableSlots === 0) return;

  // CPS throttling
  const state = getOrCreateState(campaign.id);
  const now = Date.now();
  state.cpsHistory = state.cpsHistory.filter(t => now - t < 1000);
  const cpsCapacity = Math.max(0, Math.floor(getEffectiveCps(state, campaign)) - state.cpsHistory.length);

  const slots = Math.min(availableSlots, cpsCapacity, campaign.batch_size || 10, ready);
  if (slots === 0) return;

  // Claim next queued destinations atomically (SKIP LOCKED prevents double-claiming)
  const { rows: destinations } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'dialing',
         attempt_count   = attempt_count + 1,
         last_attempt_at = now(),
         next_attempt_at = null,
         call_uuid       = null,
         updated_at      = now()
     WHERE id IN (
       SELECT id FROM ens_campaign_destinations
       WHERE campaign_id = $1
         AND status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, phone_number, contact_name, attempt_count, max_attempts, gateway_name`,
    [campaign.id, slots]
  );

  if (destinations.length === 0) return;

  // Update campaign counters
  await query(
    `UPDATE ens_campaigns
     SET dialing_count = dialing_count + $2,
         queued_count  = GREATEST(0, queued_count - $2),
         updated_at    = now()
     WHERE id = $1`,
    [campaign.id, destinations.length]
  );

  // Use per-destination gateway (resolved at campaign creation time from the
  // priority chain: contact.gateway_id → cfg.sip_gateway → platform default).
  // The execution engine never re-reads emergency_contacts — phone_number and
  // gateway_name in ens_campaign_destinations are the authoritative snapshot.
  const clid      = campaign.sip_caller_id || campaign.trigger_number || '999';
  const mediaPath = campaign.recording_file || '';

  for (const dest of destinations) {
    const callUuid = randomUUID();
    state.cpsHistory.push(Date.now());
    await originateDestination(campaign, dest, callUuid, dest.gateway_name || null, clid, mediaPath);
  }

  emitInternal('enrs::campaign_progress', {
    campaign_id: campaign.id,
    dialing: dialing + destinations.length,
    ready: ready - destinations.length,
  });
}

async function originateDestination(campaign, dest, callUuid, gatewayName, clid, playbackFile) {
  // Assign UUID to destination row first so ESL CHANNEL_HANGUP can find it
  await query(
    `UPDATE ens_campaign_destinations SET call_uuid = $2, updated_at = now() WHERE id = $1`,
    [dest.id, callUuid]
  );

  try {
    await originateCampaignCall({
      callUuid,
      campaignId:   campaign.id,
      destId:       dest.id,
      number:       dest.phone_number,
      clid,
      gatewayName,
      contactId:    dest.contact_id || null,
      playbackFile: playbackFile || null,
      timeout:      ORIGINATE_TIMEOUT,
    });
  } catch (e) {
    await handleDestFailed(dest.id, campaign.id, 'ORIGINATE_ERROR', e.message);
  }
}

// ── ESL Event Handlers ────────────────────────────────────────────────────────

// Called from eslService via eslEvents EventEmitter
export async function onCallAnswer(callUuid) {
  const { rows: [dest] } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'answered', answered_at = now(), updated_at = now()
     WHERE call_uuid = $1 AND status = 'dialing'
     RETURNING id, campaign_id`,
    [callUuid]
  );
  if (!dest) return;

  await query(
    `UPDATE ens_campaigns
     SET answered_count = answered_count + 1,
         dialing_count  = GREATEST(0, dialing_count - 1),
         updated_at     = now()
     WHERE id = $1`,
    [dest.campaign_id]
  );

  emitInternal('enrs::campaign_call_answered', {
    campaign_id: dest.campaign_id,
    call_uuid:   callUuid,
  });
}

export async function onCallHangup(callUuid, cause) {
  const { rows: [dest] } = await query(
    `SELECT id, campaign_id, answered_at, attempt_count, max_attempts, status
     FROM ens_campaign_destinations WHERE call_uuid = $1`,
    [callUuid]
  );
  if (!dest) return; // not a campaign call

  const state       = getOrCreateState(dest.campaign_id);
  const wasAnswered = dest.answered_at != null || dest.status === 'answered';

  if (wasAnswered) {
    // Successfully delivered.
    // dialing_count was already decremented in onCallAnswer (dialing→answered),
    // so it must NOT be decremented again here (answered→completed).
    await query(
      `UPDATE ens_campaign_destinations
       SET status = 'completed', hangup_cause = $2, completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [dest.id, cause]
    );
    await query(
      `UPDATE ens_campaigns
       SET completed_count = completed_count + 1,
           updated_at      = now()
       WHERE id = $1`,
      [dest.campaign_id]
    );
    state.callTotal  = (state.callTotal  || 0) + 1;
  } else if (RETRYABLE_CAUSES.has(cause) && dest.attempt_count < dest.max_attempts) {
    // Schedule retry
    const { rows: [c] } = await query(
      `SELECT retry_interval_sec FROM ens_campaigns WHERE id = $1`,
      [dest.campaign_id]
    );
    const delay = c?.retry_interval_sec || 300;

    await query(
      `UPDATE ens_campaign_destinations
       SET status = 'queued', hangup_cause = $2,
           next_attempt_at = now() + ($3 || ' seconds')::interval,
           call_uuid = null, updated_at = now()
       WHERE id = $1`,
      [dest.id, cause, delay]
    );
    const busyCol = BUSY_CAUSES.has(cause) ? 'busy_count' : 'no_answer_count';
    await query(
      `UPDATE ens_campaigns
       SET ${busyCol}     = ${busyCol} + 1,
           retried_count  = retried_count + 1,
           dialing_count  = GREATEST(0, dialing_count - 1),
           queued_count   = queued_count + 1,
           updated_at     = now()
       WHERE id = $1`,
      [dest.campaign_id]
    );
    if (BUSY_CAUSES.has(cause)) state.busyTotal = (state.busyTotal || 0) + 1;
    state.callTotal = (state.callTotal || 0) + 1;
  } else {
    await handleDestFailed(dest.id, dest.campaign_id, cause, null);
  }

  emitInternal('enrs::campaign_call_hangup', {
    campaign_id: dest.campaign_id,
    call_uuid:   callUuid,
    cause,
    was_answered: wasAnswered,
  });
}

async function handleDestFailed(destId, campaignId, cause, errorMsg) {
  await query(
    `UPDATE ens_campaign_destinations
     SET status = 'failed', hangup_cause = $2, error_message = $3,
         completed_at = now(), call_uuid = null, updated_at = now()
     WHERE id = $1`,
    [destId, cause, errorMsg]
  );
  await query(
    `UPDATE ens_campaigns
     SET failed_count  = failed_count + 1,
         dialing_count = GREATEST(0, dialing_count - 1),
         updated_at    = now()
     WHERE id = $1`,
    [campaignId]
  );
}

// ── Campaign lifecycle helpers ────────────────────────────────────────────────

async function completeCampaign(campaignId) {
  const { rows: [c] } = await query(
    `UPDATE ens_campaigns
     SET status = 'completed', completed_at = now(), updated_at = now(),
         campaign_duration_sec = EXTRACT(EPOCH FROM (now() - started_at))::INT
     WHERE id = $1 AND status = 'running'
     RETURNING id, answered_count, failed_count, total_destinations`,
    [campaignId]
  );
  if (c) {
    campaignState.delete(campaignId);
    emitInternal('enrs::campaign_completed', { campaign_id: campaignId, stats: c });
    logger.info({ module: 'campaignEngine', campaignId }, 'Campaign completed');
  }
}

async function expireCampaign(campaignId) {
  await query(
    `UPDATE ens_campaign_destinations
     SET status = 'expired', updated_at = now()
     WHERE campaign_id = $1 AND status = 'queued'`,
    [campaignId]
  );
  await query(
    `UPDATE ens_campaigns
     SET status = 'completed', completed_at = now(), updated_at = now(),
         campaign_duration_sec = EXTRACT(EPOCH FROM (now() - started_at))::INT
     WHERE id = $1 AND status = 'running'`,
    [campaignId]
  );
  campaignState.delete(campaignId);
  emitInternal('enrs::campaign_expired', { campaign_id: campaignId });
  logger.info({ module: 'campaignEngine', campaignId }, 'Campaign expired');
}

// ── Public campaign management API ───────────────────────────────────────────

export async function createCampaign({
  triggerNumber,
  triggeredBy  = null,
  triggeredVia = 'PHONE',
  recordingFile,
  messageAudioUrl,
  messageText,
}) {
  // Resolve ENS config from emergency_numbers
  const { rows: [numRow] } = await query(
    `SELECT en.ens_configuration_id, en.organization_id
     FROM emergency_numbers en
     WHERE en.number = $1
       AND en.type = 'ENS'
       AND en.deleted_at IS NULL
       AND en.is_active = true
     LIMIT 1`,
    [triggerNumber]
  );
  if (!numRow?.ens_configuration_id) {
    throw Object.assign(new Error(`No active ENS configuration for number ${triggerNumber}`), { status: 404 });
  }

  return createCampaignByConfigId({
    configId:       numRow.ens_configuration_id,
    organizationId: numRow.organization_id,
    triggeredBy,
    triggeredVia,
    triggerNumber,
    recordingFile,
    messageAudioUrl,
    messageText,
  });
}

export async function createCampaignByConfigId({
  configId,
  organizationId,
  triggeredBy,
  triggeredVia = 'UI',
  triggerNumber,
  recordingFile,
  messageAudioUrl,
  messageText,
}) {
  const { rows: [cfg] } = await query(
    `SELECT * FROM ens_configurations
     WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
    [configId]
  );
  if (!cfg) throw Object.assign(new Error('ENS configuration not found'), { status: 404 });

  const contacts = await resolveContacts(configId);
  if (contacts.length === 0) {
    throw Object.assign(new Error('No active contacts for this ENS configuration'), { status: 422 });
  }

  // Pre-resolve each contact into a concrete dial target before the transaction.
  // All dialing rules (allow_mobile, allow_extension, formatting) are read from
  // the ENS configuration. The gateway provides only the SIP route name.
  const { resolved, skipped } = await resolveDialTargets(contacts, cfg);

  if (skipped.length > 0) {
    logger.warn({
      module:    'campaignEngine',
      operation: 'createCampaignByConfigId',
      configId,
      skipped:   skipped.length,
      resolved:  resolved.length,
      reasons:   [...new Set(skipped.map(s => s.reason))],
    }, `${skipped.length} contact(s) skipped during dial target resolution`);
  }

  // A campaign with zero resolvable contacts cannot be dialed.
  // This is distinct from the earlier check (zero contacts in the config) —
  // this case occurs when all contacts exist but none can be resolved in the
  // current dialing mode (e.g., gateway mode with extension-only contacts).
  if (resolved.length === 0) {
    throw Object.assign(
      new Error('No dialable contacts after dial target resolution — check contact phone numbers and gateway mode'),
      { status: 422 }
    );
  }

  return withTransaction(async (tq) => {
    const { rows: [campaign] } = await tq(
      `INSERT INTO ens_campaigns (
         ens_configuration_id, organization_id, triggered_by, triggered_via,
         trigger_number, recording_file, message_audio_url, message_text,
         max_concurrent, calls_per_second, retry_count, retry_interval_sec,
         max_attempts, retry_failed_only, adaptive_throttling, campaign_priority,
         campaign_timeout_min, sip_gateway, sip_caller_id,
         total_destinations, queued_count, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$20,'queued'
       ) RETURNING *`,
      [
        configId,
        organizationId || cfg.organization_id,
        triggeredBy,
        triggeredVia,
        triggerNumber,
        recordingFile   || null,
        messageAudioUrl || null,
        messageText     || null,
        cfg.max_concurrent_calls || 30,
        cfg.calls_per_second     || 2.0,
        cfg.max_attempts         || 3,
        cfg.retry_interval_sec   || 60,
        cfg.max_attempts         || 3,
        cfg.retry_failed_only    === true,
        cfg.adaptive_throttling  === true,
        cfg.campaign_priority    || 5,
        cfg.campaign_timeout_min || 60,
        cfg.sip_gateway          || null,
        cfg.blast_clid           || null,  // outbound caller ID shown to blast recipients
        resolved.length,
      ]
    );

    logger.debug({
      module:      'campaignEngine',
      operation:   'createCampaignByConfigId',
      campaignId:  campaign.id,
      status:      campaign.status,
      sipGateway:  campaign.sip_gateway,
      totalDest:   campaign.total_destinations,
      maxConcurrent: campaign.max_concurrent,
    }, 'Campaign row inserted');

    for (const r of resolved) {
      await tq(
        `INSERT INTO ens_campaign_destinations
           (campaign_id, contact_id, phone_number, contact_name, max_attempts,
            gateway_name, target_type, original_number, routing_mode_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [campaign.id, r.contact_id, r.phone_number, r.name, cfg.max_attempts || 3,
         r.gateway_name, r.target_type, r.original_number, r.routing_mode_used]
      );
    }

    logger.info({
      module:    'campaignEngine',
      operation: 'createCampaignByConfigId',
      campaignId: campaign.id,
      destinations: resolved.length,
      skipped:      skipped.length,
    }, `Campaign created — ${resolved.length} destinations queued`);
    return campaign;
  });
}

export async function pauseCampaign(campaignId) {
  const { rows: [row] } = await query(
    `UPDATE ens_campaigns
     SET status = 'paused', paused_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [campaignId]
  );
  if (!row) throw Object.assign(new Error('Campaign not found or not running'), { status: 404 });
  emitInternal('enrs::campaign_paused', { campaign_id: campaignId });
  return row;
}

export async function resumeCampaign(campaignId) {
  const { rows: [row] } = await query(
    `UPDATE ens_campaigns
     SET status = 'running', paused_at = null, updated_at = now()
     WHERE id = $1 AND status = 'paused'
     RETURNING id`,
    [campaignId]
  );
  if (!row) throw Object.assign(new Error('Campaign not found or not paused'), { status: 404 });
  emitInternal('enrs::campaign_resumed', { campaign_id: campaignId });
  return row;
}

export async function cancelCampaign(campaignId) {
  await query(
    `UPDATE ens_campaign_destinations
     SET status = 'skipped', updated_at = now()
     WHERE campaign_id = $1 AND status = 'queued'`,
    [campaignId]
  );
  const { rows: [row] } = await query(
    `UPDATE ens_campaigns
     SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
         campaign_duration_sec = EXTRACT(EPOCH FROM (now() - COALESCE(started_at, now())))::INT
     WHERE id = $1 AND status IN ('queued','running','paused')
     RETURNING id`,
    [campaignId]
  );
  if (!row) throw Object.assign(new Error('Campaign not found or already finished'), { status: 404 });
  campaignState.delete(campaignId);
  emitInternal('enrs::campaign_cancelled', { campaign_id: campaignId });
  return row;
}

export function getEngineStats() {
  return {
    active_campaigns: campaignState.size,
    is_running:       engineTimer !== null,
    campaign_ids:     [...campaignState.keys()],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreateState(campaignId) {
  if (!campaignState.has(campaignId)) {
    campaignState.set(campaignId, { cpsHistory: [], busyTotal: 0, callTotal: 0 });
  }
  return campaignState.get(campaignId);
}

function getEffectiveCps(state, campaign) {
  if (!campaign.adaptive_throttling) return campaign.calls_per_second;
  const total = state.callTotal || 0;
  if (total < 10) return campaign.calls_per_second;
  const busyRate = (state.busyTotal || 0) / total;
  if (busyRate > 0.30) return Math.max(0.5, campaign.calls_per_second * 0.75);
  if (busyRate > 0.15) return campaign.calls_per_second * 0.90;
  return campaign.calls_per_second;
}

async function resolveContacts(configId) {
  const { rows } = await query(
    `SELECT DISTINCT
       ec.id,
       ec.mobile_number,
       ec.extension_number,
       ec.gateway_id,
       TRIM(COALESCE(ec.first_name,'') || ' ' || COALESCE(ec.last_name,'')) AS name
     FROM emergency_contacts ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND (
         ec.id IN (
           SELECT ecc.emergency_contact_id
           FROM ens_configuration_contacts ecc
           WHERE ecc.ens_configuration_id = $1
         )
         OR ec.id IN (
           SELECT rgm.emergency_contact_id
           FROM responder_group_members rgm
           JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
           WHERE ecg.ens_configuration_id = $1
         )
       )
     ORDER BY ec.id`,
    [configId]
  );
  return rows;
}

async function syncCampaignCounters(campaignId) {
  await query(
    `UPDATE ens_campaigns c SET
       queued_count     = (SELECT COUNT(*) FROM ens_campaign_destinations
                           WHERE campaign_id = c.id AND status = 'queued'),
       dialing_count    = (SELECT COUNT(*) FROM ens_campaign_destinations
                           WHERE campaign_id = c.id AND status IN ('dialing','answered')),
       answered_count   = (SELECT COUNT(*) FROM ens_campaign_destinations
                           WHERE campaign_id = c.id AND answered_at IS NOT NULL),
       completed_count  = (SELECT COUNT(*) FROM ens_campaign_destinations
                           WHERE campaign_id = c.id AND status = 'completed'),
       failed_count     = (SELECT COUNT(*) FROM ens_campaign_destinations
                           WHERE campaign_id = c.id AND status = 'failed'),
       updated_at       = now()
     WHERE id = $1`,
    [campaignId]
  );
}
