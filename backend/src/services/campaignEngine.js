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

// Apply a gateway's mobile number formatting rules.
// Gateway decides HOW to format; ENS only decided WHAT to dial.
function applyMobileFormatting(raw, gw) {
  if (!gw.mobile_normalize_enabled) return raw;
  let n = String(raw || '').trim();
  if (!n) return n;
  if (gw.mobile_strip_leading_zero && n.startsWith('0')) n = n.slice(1);
  if (gw.mobile_prefix) n = gw.mobile_prefix + n;
  if (gw.mobile_suffix) n = n + gw.mobile_suffix;
  return n;
}

// Apply a gateway's extension formatting rules (prefix / suffix).
function applyExtensionFormatting(raw, gw) {
  if (!gw.ext_normalize_enabled) return raw;
  let n = String(raw || '').trim();
  if (!n) return n;
  if (gw.ext_prefix) n = gw.ext_prefix + n;
  if (gw.ext_suffix) n = n + gw.ext_suffix;
  return n;
}

// Load all active gateways for a tenant into two maps for O(1) lookup.
// Called once per campaign creation — never per-contact.
async function loadGatewayMap(tenantId) {
  const { rows } = await query(
    `SELECT id, name,
            allow_mobile, allow_extension,
            mobile_normalize_enabled, mobile_strip_leading_zero,
            mobile_prefix, mobile_suffix,
            ext_normalize_enabled, ext_prefix, ext_suffix
     FROM sip_gateways
     WHERE tenant_id = $1 AND is_active = true AND deleted_at IS NULL`,
    [tenantId]
  );
  return {
    byId:   new Map(rows.map(g => [g.id,   g])),
    byName: new Map(rows.map(g => [g.name, g])),
  };
}

// Resolve one contact into a bare dial target.
// Returns { skip: false, phone_number, gateway_name } or { skip: true, reason }.
//
// Gateway priority chain:
//   contact.gateway_id → cfg.sip_gateway → platform default → internal
//
// ENS policy fields read from cfg:
//   routing_mode    — 'auto' | 'internal_only' | 'gateway_only'
//   dial_preference — 'extension_only' | 'mobile_only' | 'extension_mobile' | 'mobile_extension'
//
// Gateway capability fields (allow_mobile, allow_extension) control which
// contact fields are valid for that gateway. Formatting is gateway-owned.
function resolveContact(contact, cfg, gateways) {
  const routingMode    = cfg.routing_mode    || 'auto';
  const dialPreference = cfg.dial_preference || 'extension_mobile';

  // Step 1: Resolve effective gateway via priority chain
  let gw     = null;
  let gwName = null;

  if (contact.gateway_id) {
    gw = gateways.byId.get(contact.gateway_id) || null;
    gwName = gw?.name || null;
  }
  if (!gw && cfg.sip_gateway) {
    gw = gateways.byName.get(cfg.sip_gateway) || null;
    // Use the name from the DB record if found; otherwise the raw config string
    gwName = gw?.name || cfg.sip_gateway;
  }
  if (!gw && !gwName) {
    const platformGw = config.freeswitch?.defaultGateway || null;
    if (platformGw) {
      gw = gateways.byName.get(platformGw) || null;
      gwName = gw?.name || null; // only use if registered
    }
  }

  // Step 2: Determine dialing mode
  let isGatewayMode;
  if      (routingMode === 'internal_only') { isGatewayMode = false; gwName = null; gw = null; }
  else if (routingMode === 'gateway_only')  {
    isGatewayMode = true;
    if (!gwName) return { skip: true, reason: 'gateway_only_mode_but_no_gateway_configured' };
  } else {
    isGatewayMode = !!gwName;
  }

  const ext = contact.extension_number || null;
  const mob = contact.mobile_number    || null;

  // Gateway capabilities (internal routing allows both)
  const gwAllowMobile    = isGatewayMode ? (gw?.allow_mobile    ?? true)  : true;
  const gwAllowExtension = isGatewayMode ? (gw?.allow_extension ?? false) : true;

  // Step 3: Select number based on dial preference + gateway capabilities
  let raw        = null;
  let targetType = null;
  let skipReason = null;

  switch (dialPreference) {
    case 'extension_only':
      if      (ext && gwAllowExtension) { raw = ext; targetType = 'extension'; }
      else if (!ext)                     skipReason = 'no_extension_number';
      else                               skipReason = 'extension_not_allowed_by_gateway';
      break;

    case 'mobile_only':
      if      (mob && gwAllowMobile) { raw = mob; targetType = 'mobile'; }
      else if (!mob)                  skipReason = 'no_mobile_number';
      else                            skipReason = 'mobile_not_allowed_by_gateway';
      break;

    case 'extension_mobile':
      if      (ext && gwAllowExtension) { raw = ext; targetType = 'extension'; }
      else if (mob && gwAllowMobile)    { raw = mob; targetType = 'mobile'; }
      else if (!ext && !mob)             skipReason = 'no_dialable_number';
      else                               skipReason = 'no_allowed_target_by_gateway';
      break;

    case 'mobile_extension':
      if      (mob && gwAllowMobile)    { raw = mob; targetType = 'mobile'; }
      else if (ext && gwAllowExtension) { raw = ext; targetType = 'extension'; }
      else if (!ext && !mob)             skipReason = 'no_dialable_number';
      else                               skipReason = 'no_allowed_target_by_gateway';
      break;

    default:
      // Backward-compatible: gateway → mobile; internal → extension then mobile
      if (isGatewayMode) {
        raw = mob; targetType = 'mobile';
        if (!raw)              skipReason = 'no_mobile_number';
        else if (!gwAllowMobile) skipReason = 'mobile_not_allowed_by_gateway';
        else                     raw = mob;
      } else {
        raw = ext || mob;
        targetType = ext ? 'extension' : 'mobile';
        if (!raw) skipReason = 'no_dialable_number';
      }
  }

  if (skipReason) return { skip: true, reason: skipReason };

  // Step 4: Apply gateway formatting (gateway's rules, not ENS rules)
  let phone_number;
  if (isGatewayMode && gw) {
    phone_number = targetType === 'mobile'
      ? applyMobileFormatting(raw, gw)
      : applyExtensionFormatting(raw, gw);
  } else {
    phone_number = raw; // internal: no formatting — dialResolver uses user/<ext>
  }

  return {
    skip:         false,
    phone_number,
    gateway_name: isGatewayMode ? (gwName || null) : null,
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
        contact_id:   c.id || null,
        phone_number: result.phone_number,
        name:         c.name || null,
        gateway_name: result.gateway_name || null,
      });
    }
  }

  return { resolved, skipped };
}

// ── In-memory state ───────────────────────────────────────────────────────────

// Per-campaign adaptive state (non-critical — rebuilt from DB on restart)
const campaignState = new Map(); // campaignId → { busyTotal, callTotal, cpsHistory[] }

let ticking         = false;
let engineTimer     = null;

// ── Engine lifecycle ─────────────────────────────────────────────────────────

export function startEngine() {
  if (engineTimer) return;
  engineTimer = setInterval(tick, TICK_MS);
  console.log('[campaign] Engine started');
  recoverStaleDialing().catch(e => console.error('[campaign] stale recovery error:', e.message));
}

export function stopEngine() {
  if (engineTimer) { clearInterval(engineTimer); engineTimer = null; }
  campaignState.clear();
  console.log('[campaign] Engine stopped');
}

// ── Crash recovery: reset dialing rows that were orphaned ────────────────────

async function recoverStaleDialing() {
  const { rows } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'queued', call_uuid = null, next_attempt_at = now() + interval '5 seconds',
         updated_at = now()
     WHERE status = 'dialing'
       AND last_attempt_at < now() - ($1 || ' seconds')::interval
     RETURNING campaign_id`,
    [STALE_DIALING_SEC]
  );
  if (rows.length) {
    console.log(`[campaign] Recovered ${rows.length} stale dialing rows`);
    // Also fix campaign dialing counters
    const campaignIds = [...new Set(rows.map(r => r.campaign_id))];
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
    await processAllCampaigns();
  } catch (e) {
    console.error('[campaign] tick error:', e.message);
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
      console.error(`[campaign] error in ${c.id}:`, e.message)
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

  // Current dialing count from DB (authoritative)
  const { rows: [counts] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'dialing')::INT AS dialing,
       COUNT(*) FILTER (WHERE status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now()))::INT AS ready
     FROM ens_campaign_destinations WHERE campaign_id = $1`,
    [campaign.id]
  );

  const { dialing, ready } = counts;

  // Update peak concurrent
  if (dialing > campaign.peak_concurrent) {
    await query(
      `UPDATE ens_campaigns SET peak_concurrent = $2, dialing_count = $2, updated_at = now()
       WHERE id = $1`,
      [campaign.id, dialing]
    );
  }

  // No work to do
  if (ready === 0 && dialing === 0) {
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

  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][processCampaign] campaign=${campaign.id} slots=${destinations.length} clid=${JSON.stringify(clid)} mediaPath=${JSON.stringify(mediaPath)}`);
  for (const dest of destinations) {
    console.log(`[ENS-DEBUG][destClaimed] campaign=${campaign.id} dest.id=${dest.id} dest.phone_number=${JSON.stringify(dest.phone_number)} dest.gateway_name=${JSON.stringify(dest.gateway_name)}`);
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

  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][originateDestination] ENTER campaign=${campaign.id} dest=${dest.id} callUuid=${callUuid}`);
  console.log(`[ENS-DEBUG][originateDestination]   number=${JSON.stringify(dest.phone_number)} contactId=${JSON.stringify(dest.contact_id ?? undefined)} gatewayName=${JSON.stringify(gatewayName)} clid=${JSON.stringify(clid)} playbackFile=${JSON.stringify(playbackFile || null)}`);

  try {
    await originateCampaignCall({
      callUuid,
      campaignId:  campaign.id,
      destId:      dest.id,
      number:      dest.phone_number,
      clid,
      gatewayName,
      contactId:   dest.contact_id || null,
      playbackFile: playbackFile || null,
      timeout:     ORIGINATE_TIMEOUT,
    });
    // DEBUG-PROBE
    console.log(`[ENS-DEBUG][originateDestination] originateCampaignCall returned (no throw) campaign=${campaign.id} dest=${dest.id} callUuid=${callUuid}`);
  } catch (e) {
    // ESL not connected or originate error — mark failed immediately
    // DEBUG-PROBE
    console.error(`[ENS-DEBUG][originateDestination] CAUGHT ERROR campaign=${campaign.id} dest=${dest.id} callUuid=${callUuid} error="${e.message}"`);
    await handleDestFailed(dest.id, campaign.id, 'ORIGINATE_ERROR', e.message);
  }
}

// ── ESL Event Handlers ────────────────────────────────────────────────────────

// Called from eslService via eslEvents EventEmitter
export async function onCallAnswer(callUuid) {
  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][onCallAnswer] CHANNEL_ANSWER received callUuid=${callUuid}`);
  const { rows: [dest] } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'answered', answered_at = now(), updated_at = now()
     WHERE call_uuid = $1 AND status = 'dialing'
     RETURNING id, campaign_id`,
    [callUuid]
  );
  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][onCallAnswer] dest lookup: ${dest ? `id=${dest.id} campaign=${dest.campaign_id}` : 'NO ROW FOUND (uuid not in dialing state?)'}`);
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
  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][onCallHangup] CHANNEL_HANGUP received callUuid=${callUuid} cause=${cause}`);
  const { rows: [dest] } = await query(
    `SELECT id, campaign_id, answered_at, attempt_count, max_attempts, status
     FROM ens_campaign_destinations WHERE call_uuid = $1`,
    [callUuid]
  );
  // DEBUG-PROBE
  console.log(`[ENS-DEBUG][onCallHangup] dest lookup: ${dest ? `id=${dest.id} campaign=${dest.campaign_id} status=${dest.status} answered_at=${dest.answered_at} attempt_count=${dest.attempt_count}/${dest.max_attempts}` : 'NO ROW FOUND (not a campaign call)'}`);
  if (!dest) return; // not a campaign call

  const state       = getOrCreateState(dest.campaign_id);
  const wasAnswered = dest.answered_at != null || dest.status === 'answered';

  if (wasAnswered) {
    // Successfully delivered
    await query(
      `UPDATE ens_campaign_destinations
       SET status = 'completed', hangup_cause = $2, completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [dest.id, cause]
    );
    await query(
      `UPDATE ens_campaigns
       SET completed_count = completed_count + 1,
           dialing_count   = GREATEST(0, dialing_count - 1),
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
    // Failed / max retries exhausted
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
  // DEBUG-PROBE
  console.error(`[ENS-DEBUG][handleDestFailed] dest=${destId} campaign=${campaignId} cause=${cause} error=${JSON.stringify(errorMsg)}`);
  await query(
    `UPDATE ens_campaign_destinations
     SET status = 'failed', hangup_cause = $3, error_message = $4,
         completed_at = now(), call_uuid = null, updated_at = now()
     WHERE id = $1`,
    [destId, campaignId, cause, errorMsg]
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
    console.log(`[campaign] Completed: ${campaignId}`);
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
  console.log(`[campaign] Expired: ${campaignId}`);
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
  // Gateway dialing rules (allow_mobile, allow_extension, formatting) are read
  // from sip_gateways. ENS only decides routing_mode + dial_preference.
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
        recordingFile || null,
        messageAudioUrl || null,
        messageText || null,
        cfg.max_concurrent_calls || 30,
        cfg.calls_per_second     || 2.0,
        cfg.retry_count          || 3,
        cfg.retry_interval_sec   || 300,
        cfg.max_attempts         || 4,
        cfg.retry_failed_only    !== false,
        cfg.adaptive_throttling  !== false,
        cfg.campaign_priority    || 5,
        cfg.campaign_timeout_min || 60,
        cfg.sip_gateway          || null,
        cfg.sip_caller_id        || null,
        resolved.length,  // Wave 1: skipped contacts are excluded from total_destinations
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
           (campaign_id, contact_id, phone_number, contact_name, max_attempts, gateway_name)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [campaign.id, r.contact_id, r.phone_number, r.name, cfg.max_attempts || 4, r.gateway_name]
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
  // DEBUG-PROBE: Layer 1 — full contact data from emergency_contacts
  console.log(`[ENS-DEBUG][resolveContacts] configId=${configId} rowCount=${rows.length}`);
  for (const r of rows) {
    console.log(`[ENS-DEBUG][resolveContacts]   contact id=${r.id} mobile_number=${JSON.stringify(r.mobile_number)} extension_number=${JSON.stringify(r.extension_number)} gateway_id=${JSON.stringify(r.gateway_id)} name=${JSON.stringify(r.name)}`);
  }
  return rows;
}

async function syncCampaignCounters(campaignId) {
  await query(
    `UPDATE ens_campaigns c SET
       queued_count   = (SELECT COUNT(*) FROM ens_campaign_destinations
                         WHERE campaign_id = c.id AND status = 'queued'),
       dialing_count  = (SELECT COUNT(*) FROM ens_campaign_destinations
                         WHERE campaign_id = c.id AND status = 'dialing'),
       updated_at     = now()
     WHERE id = $1`,
    [campaignId]
  );
}
