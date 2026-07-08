// FreeSWITCH ESL (Event Socket Library) service
// Maintains a persistent connection; auto-reconnects; fires events to Socket.IO
import { EventEmitter } from 'events';
import esl from 'modesl';
import { config } from '../config/index.js';
import { query }  from '../db/pool.js';

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
// mode: 'gateway'  — external SIP gateway (production)
//         opts.gateway  = gateway name in FreeSWITCH
//         opts.to       = destination number to dial
//
// mode: 'user'     — internal user/ dial string (lab mode, no SIP trunk needed)
//         opts.extension = internal extension (e.g. '1001')
//
// mode: 'internal' — sofia/internal profile (lab/internal profile)
//         opts.extension = extension
//         opts.domain    = FreeSWITCH domain (default 127.0.0.1)
//
// Common opts:
//   clid   — caller ID shown on recipient phone
//   action — 'playback' | 'conference'
//   target — recording path (playback) or room@profile (conference)
//   vars   — additional channel variables { key: value }
export async function originateCall({
  mode = 'gateway',
  gateway,
  extension,
  domain,
  to,
  clid,
  action = 'playback',
  target,
  vars = {},
}) {
  const dest = extension || to;
  const cid  = clid || dest;

  const varParts = {
    origination_caller_id_number: cid,
    origination_caller_id_name:   cid,
    ignore_early_media:           'true',
    originate_timeout:            '30',
    ...vars,
  };
  const varStr = Object.entries(varParts).map(([k, v]) => `${k}=${v}`).join(',');

  let dialStr;
  if (mode === 'user') {
    // user/ dial string — routes through FreeSWITCH user directory (no external gateway)
    dialStr = `user/${dest}`;
  } else if (mode === 'internal') {
    // sofia/internal profile — for extensions on internal SIP profile
    const dom = domain || config.esl.domain || '127.0.0.1';
    dialStr = `sofia/internal/${dest}@${dom}`;
  } else {
    // External SIP gateway (production)
    dialStr = `sofia/gateway/${gateway}/${dest}`;
  }

  let app;
  if (action === 'conference') {
    app = `&conference(${target}@default)`;
  } else {
    app = `&playback(${target})`;
  }

  const cmd = `originate {${varStr}}${dialStr} ${app}`;
  return eslCommand(cmd);
}

// ─── Originate a campaign outbound call ─────────────────────
//
// Uses a pre-assigned UUID (origination_uuid) so we know the
// call ID before the CHANNEL_ANSWER / CHANNEL_HANGUP events fire.
// playbackFile is the absolute FS path to the recording to play.
// If null, the call is put in park — backend can send media later.
export async function originateCampaignCall({
  callUuid,
  campaignId,
  destId,
  number,
  clid,
  gateway = 'default',
  playbackFile,
  timeout = 30,
}) {
  const varParts = {
    origination_uuid:             callUuid,
    origination_caller_id_number: clid || number,
    origination_caller_id_name:   'Emergency',
    ignore_early_media:           'true',
    originate_timeout:            String(timeout),
    enrs_campaign_id:             String(campaignId),
    enrs_dest_id:                 String(destId),
  };
  const varStr  = Object.entries(varParts).map(([k, v]) => `${k}=${v}`).join(',');
  const dialStr = `sofia/gateway/${gateway}/${number}`;
  const app     = playbackFile ? `&playback(${playbackFile})` : '&park()';
  return eslCommand(`originate {${varStr}}${dialStr} ${app}`);
}

// ─── Play audio in a conference ─────────────────────────────
export async function confPlay(confName, audioPath) {
  return eslCommand(`conference ${confName} play ${audioPath}`);
}

// ─── Kick a member from conference ──────────────────────────
export async function confKick(confName, memberId) {
  return eslCommand(`conference ${confName} kick ${memberId}`);
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
