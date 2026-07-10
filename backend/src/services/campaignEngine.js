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
     RETURNING id, phone_number, contact_name, attempt_count, max_attempts`,
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

  // Originate each call — Phase 4: no hardcoded 'default' gateway name.
  // Passing null/undefined through to resolveDialString() means "no
  // gateway configured," which correctly falls back to sofia/internal/
  // for local testing instead of assuming a gateway literally named
  // "default" exists in FreeSWITCH (which broke every fresh local setup
  // with zero gateways configured).
  const gatewayName = campaign.sip_gateway || config.freeswitch?.defaultGateway || null;
  const clid         = campaign.sip_caller_id || campaign.trigger_number || '999';
  const mediaPath    = campaign.recording_file || '';

  for (const dest of destinations) {
    const callUuid = randomUUID();
    state.cpsHistory.push(Date.now());
    await originateDestination(campaign, dest, callUuid, gatewayName, clid, mediaPath);
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
      campaignId:  campaign.id,
      destId:      dest.id,
      number:      dest.phone_number,
      clid,
      gatewayName,
      contactId:   dest.contact_id || null,
      playbackFile: playbackFile || null,
      timeout:     ORIGINATE_TIMEOUT,
    });
  } catch (e) {
    // ESL not connected or originate error — mark failed immediately
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
        contacts.length,
      ]
    );

    // Bulk insert destinations
    for (const c of contacts) {
      await tq(
        `INSERT INTO ens_campaign_destinations
           (campaign_id, contact_id, phone_number, contact_name, max_attempts)
         VALUES ($1,$2,$3,$4,$5)`,
        [campaign.id, c.id || null, c.mobile_number, c.name || null, cfg.max_attempts || 4]
      );
    }

    console.log(`[campaign] Created ${campaign.id} with ${contacts.length} destinations`);
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
       queued_count   = (SELECT COUNT(*) FROM ens_campaign_destinations
                         WHERE campaign_id = c.id AND status = 'queued'),
       dialing_count  = (SELECT COUNT(*) FROM ens_campaign_destinations
                         WHERE campaign_id = c.id AND status = 'dialing'),
       updated_at     = now()
     WHERE id = $1`,
    [campaignId]
  );
}
