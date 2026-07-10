// FreeSWITCH ESL (Event Socket Library) service
// Maintains a persistent connection; auto-reconnects; fires events to Socket.IO
import { EventEmitter } from 'events';
import esl from 'modesl';
import { config } from '../config/index.js';
import { query }  from '../db/pool.js';
import { resolveDialString } from './dialResolver.js';

const { Connection } = esl;

// Internal event bus — campaign engine subscribes here (avoids circular imports)
export const eslEvents = new EventEmitter();

let conn            = null;     // active ESL connection
let io              = null;     // Socket.IO instance (injected after boot)
let isConn          = false;
let retryTimer      = null;
let reconnectCount  = 0;

// ─── Inject Socket.IO instance ──────────────────────────────
export function setSocketIO(ioInstance) {
  io = ioInstance;
}

// ─── Broadcast to all connected browser clients ─────────────
function emit(event, data) {
  if (io) io.emit(event, data);
}

// ─── Update DB heartbeat record ──────────────────────────────
async function updateHeartbeat(connected) {
  try {
    await query(
      `UPDATE esl_connections SET last_heartbeat_at = now(), is_active = $1
       WHERE is_active IS NOT NULL LIMIT 1`,
      [connected]
    );
  } catch {}
}

// ─── Handle incoming ESL events ─────────────────────────────
function handleEvent(evt) {
  if (!evt) return;
  const name   = evt.getHeader('Event-Name');
  const subclass = evt.getHeader('Event-Subclass') || '';

  // Conference member join
  if (name === 'CUSTOM' && subclass === 'conference::maintenance') {
    const action  = evt.getHeader('Action');
    const confName = evt.getHeader('Conference-Name');
    const member   = evt.getHeader('Member-ID');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');

    if (action === 'add-member') {
      emit('conference.member.joined', { confName, member, callerNum });
      persistEvent('conference.member.joined', { confName, member, callerNum });
    } else if (action === 'del-member') {
      emit('conference.member.left', { confName, member, callerNum });
    } else if (action === 'conference-create') {
      emit('conference.created', { confName });
    } else if (action === 'conference-destroy') {
      emit('conference.ended', { confName });
      // Preferred fix over a periodic sweep (Phase 1 item 13): FreeSWITCH
      // itself tells us the instant a room is truly empty and torn down —
      // reconcile any ers_incidents row still marked ACTIVE for this exact
      // room immediately, rather than polling. Catches orphans from an
      // unclean process restart (crash mid-call, kill -9, etc.) where
      // exec_ers's own /complete call never ran because the Lua process
      // itself never got to finish executing.
      reconcileOrphanedIncident(confName);
    }
    return;
  }

  // Channel hangup
  if (name === 'CHANNEL_HANGUP') {
    const uuid      = evt.getHeader('Unique-ID');
    const cause     = evt.getHeader('Hangup-Cause');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');
    emit('channel.hangup', { uuid, cause, callerNum });
    eslEvents.emit('CHANNEL_HANGUP', { uuid, cause, callerNum });
    return;
  }

  // Channel answer
  if (name === 'CHANNEL_ANSWER') {
    const uuid      = evt.getHeader('Unique-ID');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');
    emit('channel.answer', { uuid, callerNum });
    eslEvents.emit('CHANNEL_ANSWER', { uuid, callerNum });
    return;
  }

  // Custom ENS/ERS events from Lua scripts
  if (name === 'CUSTOM' && subclass.startsWith('enrs::')) {
    const payload = {};
    for (const h of (evt.getHeader('variable_enrs_payload') || '').split('&')) {
      const [k, v] = h.split('=');
      if (k) payload[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    emit(subclass, payload);
  }
}

// ─── Reconcile an ERS incident whose conference room was just destroyed ─
//
// mod_conference destroys a room the instant its last member leaves — this
// is the authoritative "truly vacant" signal, stronger than any per-leg
// /complete call (which only ever means "this leg left," not "the room is
// empty"; see exec_ers's own comment in luaGenerator.js). Any ers_incidents
// row still ACTIVE for this exact room at this point is an orphan — most
// commonly from an unclean backend/FreeSWITCH restart where the per-leg
// completion call never ran. Marking it here also promotes the next queued
// entry via the same endpoint the normal completion path uses, so the
// queue doesn't stall because of the crash either.
async function reconcileOrphanedIncident(confName) {
  if (!confName) return;
  try {
    const { rows } = await query(
      `SELECT incident_uuid FROM ers_incidents
       WHERE conference_room = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [confName]
    );
    for (const { incident_uuid } of rows) {
      // Local import to avoid a circular import at module load time
      // (controllers import eslService, not the reverse).
      const { completeIncidentCore } = await import('../controllers/internal/ersInternalController.js');
      await completeIncidentCore(incident_uuid, null);
    }
  } catch (err) {
    console.error('[esl] reconcileOrphanedIncident failed for', confName, err.message);
  }
}

// ─── Persist important events to DB for audit trail ─────────
async function persistEvent(action, details) {
  try {
    await query(
      `INSERT INTO audit_logs (action, entity_type, details)
       VALUES ($1, 'esl_event', $2)`,
      [action, JSON.stringify(details)]
    );
  } catch {}
}

// ─── Connect to FreeSWITCH ───────────────────────────────────
export function connect() {
  if (conn) { try { conn.end(); } catch {} }

  console.log(`[esl] Connecting to ${config.esl.host}:${config.esl.port}…`);

  conn = new Connection(
    config.esl.host,
    config.esl.port,
    config.esl.password,
    () => {
      console.log('[esl] Connected to FreeSWITCH');
      isConn = true;
      reconnectCount = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

      // Subscribe to events we care about
      conn.subscribe([
        'CUSTOM conference::maintenance',
        'CHANNEL_HANGUP',
        'CHANNEL_ANSWER',
        'CUSTOM enrs::*',
      ]);

      conn.on('esl::event', handleEvent);

      emit('esl.status', { connected: true, host: config.esl.host, port: config.esl.port });
      updateHeartbeat(true);
    }
  );

  conn.on('error', (err) => {
    console.error('[esl] Error:', err.message);
    scheduleReconnect();
  });

  conn.on('end', () => {
    if (isConn) console.log('[esl] Connection closed');
    isConn = false;
    emit('esl.status', { connected: false, host: config.esl.host, port: config.esl.port, reconnect_attempts: reconnectCount });
    updateHeartbeat(false);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (retryTimer) return;
  reconnectCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, config.esl.reconnectMs);
}

// ─── Execute an ESL command, return result ───────────────────
export function eslCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!conn || !isConn) return reject(new Error('ESL not connected'));
    conn.bgapi(cmd, (res) => {
      resolve(res?.getBody?.() || '');
    });
  });
}

// ─── Originate a call leg ────────────────────────────────────
//
// Gateway-agnostic (Phase 4) — the dial string is resolved by
// dialResolver.js, never constructed inline here. With zero SIP gateways
// configured this always dials sofia/internal/<ext>@<domain>; adding a
// tenant's default gateway (or a per-contact override) switches it to
// sofia/gateway/<name>/<number> with no code change.
//
// opts:
//   tenantId, contactId, extension, mobileNumber, gatewayId — passed
//     straight through to resolveDialString()
//   clid   — caller ID shown on recipient phone
//   action — 'playback' | 'conference'
//   target — recording path (playback) or room@profile (conference)
//   vars   — additional channel variables { key: value }
export async function originateCall({
  tenantId,
  contactId,
  extension,
  mobileNumber,
  gatewayId,
  domain,
  clid,
  action = 'playback',
  target,
  vars = {},
}) {
  const { dialString } = await resolveDialString({
    tenantId, contactId, extension, mobileNumber, gatewayId, domain,
  });
  const cid = clid || extension || mobileNumber;

  const varParts = {
    origination_caller_id_number: cid,
    origination_caller_id_name:   cid,
    ignore_early_media:           'true',
    originate_timeout:            '30',
    ...vars,
  };
  const varStr = Object.entries(varParts).map(([k, v]) => `${k}=${v}`).join(',');

  const app = action === 'conference'
    ? `&conference(${target}@default)`
    : `&playback(${target})`;

  const cmd = `originate {${varStr}}${dialString} ${app}`;
  return eslCommand(cmd);
}

// ─── Originate a campaign outbound call ─────────────────────
//
// Uses a pre-assigned UUID (origination_uuid) so we know the
// call ID before the CHANNEL_ANSWER / CHANNEL_HANGUP events fire.
// playbackFile is the absolute FS path to the recording to play.
// If null, the call is put in park — backend can send media later.
//
// Gateway-agnostic (Phase 4): dialString is resolved via
// resolveDialString() by the caller (campaignEngine.js), or this
// function resolves it itself if contactId/tenantId are provided instead
// of a pre-resolved dialString — never construct "sofia/gateway/" here.
export async function originateCampaignCall({
  callUuid,
  campaignId,
  destId,
  number,
  clid,
  tenantId,
  contactId,
  gatewayId,
  gatewayName,
  dialString,
  playbackFile,
  timeout = 30,
}) {
  const resolved = dialString || (await resolveDialString({
    tenantId, contactId, mobileNumber: number, gatewayId, gatewayName,
  })).dialString;

  const varParts = {
    origination_uuid:             callUuid,
    origination_caller_id_number: clid || number,
    origination_caller_id_name:   'Emergency',
    ignore_early_media:           'true',
    originate_timeout:            String(timeout),
    enrs_campaign_id:             String(campaignId),
    enrs_dest_id:                 String(destId),
  };
  const varStr = Object.entries(varParts).map(([k, v]) => `${k}=${v}`).join(',');
  const app    = playbackFile ? `&playback(${playbackFile})` : '&park()';
  return eslCommand(`originate {${varStr}}${resolved} ${app}`);
}

// ─── Play audio in a conference ─────────────────────────────
export async function confPlay(confName, audioPath) {
  return eslCommand(`conference ${confName} play ${audioPath}`);
}

// ─── Kick a member from conference ──────────────────────────
export async function confKick(confName, memberId) {
  return eslCommand(`conference ${confName} kick ${memberId}`);
}

// ─── Verify an extension actually loaded into the live dialplan ─────
//
// reloadxml reporting "+OK" only means FreeSWITCH re-parsed its config
// tree — it says nothing about whether a given extension ended up inside
// the context that live calls actually route through (e.g. a file
// written to the wrong directory produces a sibling XML node that never
// merges in, and reloadxml succeeds regardless). xml_locate resolves the
// dialplan the same way a real call would, so grepping its output for
// the extension name is the only way to know it is truly live.
//
// xml_locate takes 4 arguments: <section> <tag_name> <key_name> <key_value>
// — "xml_locate dialplan default" (2 args) is not a valid invocation; the
// "default" context is located via tag_name="context", key_name="name",
// key_value="default". A malformed command reliably produced a
// false-negative "not found" even immediately after a reload that a real
// test call proved had succeeded.
//
// There is also a real race: reloadxml's ESL response can return before
// FreeSWITCH has finished re-parsing internally. Retry a few times before
// declaring failure — a false failure here makes an already-correct
// deploy look broken with no way for a non-technical user to tell the
// difference from a real one.
async function xmlLocateDefaultContext() {
  return eslCommand('xml_locate dialplan context name default');
}

// `locateFn` is injectable purely so the retry/backoff behavior can be unit
// tested without a real ESL connection — production callers never pass it,
// so this changes nothing about real behavior.
export async function verifyExtensionLoaded(extensionName, { attempts = 3, delayMs = 500, locateFn = xmlLocateDefaultContext } = {}) {
  let lastRaw = '';
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await locateFn();
      lastRaw = raw;
      if (typeof raw === 'string' && raw.includes(extensionName)) {
        return { loaded: true, raw, attempts: attempt };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { loaded: false, raw: lastRaw, error: lastErr?.message, attempts };
}

// ─── Get current ESL status ─────────────────────────────────
export function eslStatus() {
  return { connected: isConn, host: config.esl.host, port: config.esl.port, reconnect_attempts: reconnectCount };
}

// ─── Heartbeat: ping FS every 30 s ──────────────────────────
setInterval(async () => {
  if (!isConn) return;
  try {
    await eslCommand('status');
    updateHeartbeat(true);
  } catch {
    updateHeartbeat(false);
  }
}, 30_000);
