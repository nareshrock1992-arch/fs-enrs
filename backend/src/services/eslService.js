// FreeSWITCH ESL (Event Socket Library) service
// Maintains a persistent connection; auto-reconnects; fires events to Socket.IO
import esl from 'esl';
import { config } from '../config/index.js';
import { query }  from '../db/pool.js';

const { Connection } = esl;

let conn     = null;     // active ESL connection
let io       = null;     // Socket.IO instance (injected after boot)
let isConn   = false;
let retryTimer = null;

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
    const uuid    = evt.getHeader('Unique-ID');
    const cause   = evt.getHeader('Hangup-Cause');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');
    emit('channel.hangup', { uuid, cause, callerNum });
    return;
  }

  // Channel answer
  if (name === 'CHANNEL_ANSWER') {
    const uuid    = evt.getHeader('Unique-ID');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');
    emit('channel.answer', { uuid, callerNum });
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
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

      // Subscribe to events we care about
      conn.subscribe([
        'CUSTOM conference::maintenance',
        'CHANNEL_HANGUP',
        'CHANNEL_ANSWER',
        'CUSTOM enrs::*',
      ]);

      conn.on('esl::event', handleEvent);

      emit('esl.status', { connected: true });
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
    emit('esl.status', { connected: false });
    updateHeartbeat(false);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (retryTimer) return;
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

// ─── Originate a call (e.g., for ENS notification dialing) ──
export async function originateCall({ from, to, dialplan = 'XML', context = 'default', vars = {} }) {
  const varStr = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',');
  const cmd    = `originate {${varStr}}sofia/gateway/${from}/${to} &bridge(sofia/gateway/${from}/${to})`;
  return eslCommand(cmd);
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
  return { connected: isConn, host: config.esl.host, port: config.esl.port };
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
