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

// ─── In-memory conference registry ──────────────────────────────────────────
//
// Authoritative real-time picture of every active FreeSWITCH conference and
// its members. Updated by conference::maintenance ESL events + seedConferenceRegistry.
// The monitoring API endpoint reads from here (no DB query for live data).
//
// Shape: confName → {
//   name, createdAt, locked, recording, floorHolder,
//   rate, flags,
//   members: Map<memberId, MemberRecord>
// }
const conferenceRegistry    = new Map();
const recordingStartTimers  = new Map(); // confName → timeout ID, cleared by start-recording ESL event

function registryGetOrCreate(confName) {
  if (!conferenceRegistry.has(confName)) {
    conferenceRegistry.set(confName, {
      name:           confName,
      createdAt:      new Date().toISOString(),
      locked:         false,
      recording:      false,   // true = recording active
      recordingPath:  null,    // absolute path of current/last recording
      recordingState: 'OFF',   // 'OFF' | 'STARTING' | 'ACTIVE' | 'STOPPING' | 'FAILED'
      recordingError: null,    // error message when state='FAILED'
      floorHolder:    null,
      rate:           null,    // Hz — populated by seedConferenceRegistry from FS header
      rawFlags:       null,    // raw pipe-delimited FS flags string
      members:        new Map(),
    });
  }
  return conferenceRegistry.get(confName);
}

// Parse raw FreeSWITCH conference flags string ("running|answered|dynamic") into
// a normalized set of boolean properties for the API model.
function parseConfFlags(rawFlags) {
  if (!rawFlags) return { dynamic: false, running: false, answered: false, locked: false };
  const parts = String(rawFlags).split('|').map(s => s.trim().toLowerCase());
  return {
    dynamic:  parts.includes('dynamic'),
    running:  parts.includes('running'),
    answered: parts.includes('answered'),
    moderated: parts.includes('moderated'),
  };
}

// Parse raw FreeSWITCH member flags string ("hear|speak|floor|moderator|talking") into
// clean booleans — never expose the raw string to the frontend.
function parseMemberFlags(rawFlags) {
  const parts = String(rawFlags || '').split('|').map(s => s.trim().toLowerCase());
  return {
    canHear:   parts.includes('hear'),
    canSpeak:  parts.includes('speak'),
    floor:     parts.includes('floor'),
    moderator: parts.includes('moderator'),
    muted:     !parts.includes('speak') || parts.includes('mute'),
    deaf:      parts.includes('deaf'),
    talking:   parts.includes('talking'),
  };
}

// Called from stopRecording once the recording has been stopped (or force-cleared).
export function setConferenceRecordingPath(confName, path) {
  const entry = conferenceRegistry.get(confName);
  if (!entry) return;
  if (recordingStartTimers.has(confName)) {
    clearTimeout(recordingStartTimers.get(confName));
    recordingStartTimers.delete(confName);
  }
  entry.recordingPath  = path || null;
  entry.recordingState = path ? 'ACTIVE' : 'OFF';
  entry.recordingError = null;
  entry.recording      = !!path;
}

// Called when file-based verification confirms FreeSWITCH opened the recording file
// even when the start-recording ESL event was delayed or missed.
export function setConferenceRecordingActive(confName, recPath) {
  if (recordingStartTimers.has(confName)) {
    clearTimeout(recordingStartTimers.get(confName));
    recordingStartTimers.delete(confName);
  }
  const entry = conferenceRegistry.get(confName);
  if (!entry) return;
  if (entry.recordingState !== 'STARTING') return; // already transitioned via event
  entry.recording      = true;
  entry.recordingState = 'ACTIVE';
  entry.recordingError = null;
  if (recPath) entry.recordingPath = recPath;
  emit('conference.recording', {
    confName, recording: true, recordingState: 'ACTIVE',
    recordingPath: recPath, recordingError: null,
  });
}

// Called immediately before issuing norecord so the UI shows "Stopping..." instead
// of jumping directly from ACTIVE to OFF.
export function setConferenceRecordingStopping(confName) {
  const entry = conferenceRegistry.get(confName);
  if (!entry) return;
  entry.recordingState = 'STOPPING';
  emit('conference.recording', {
    confName, recording: true, recordingState: 'STOPPING',
    recordingPath: entry.recordingPath, recordingError: null,
  });
}

// Set state to STARTING immediately after issuing the record command.
// The actual ACTIVE transition happens only when the start-recording ESL event
// confirms FreeSWITCH opened the file. If no event arrives within 5 seconds
// the state flips to FAILED so the UI doesn't hang in a "Starting…" limbo.
export function setConferenceRecordingStarting(confName, recPath) {
  const entry = conferenceRegistry.get(confName);
  if (!entry) return;
  if (recordingStartTimers.has(confName)) {
    clearTimeout(recordingStartTimers.get(confName));
    recordingStartTimers.delete(confName);
  }
  entry.recordingPath  = recPath || null;
  entry.recordingState = 'STARTING';
  entry.recordingError = null;
  entry.recording      = false;

  const timer = setTimeout(() => {
    recordingStartTimers.delete(confName);
    const e = conferenceRegistry.get(confName);
    if (e && e.recordingState === 'STARTING') {
      const reason = 'FreeSWITCH did not confirm recording start (5 s timeout — check FS file permissions and recording directory)';
      e.recordingState = 'FAILED';
      e.recordingError = reason;
      e.recording      = false;
      console.error(`[esl] recording start timeout — conf="${confName}" path="${recPath}"`);
      emit('conference.recording', {
        confName, recording: false, recordingState: 'FAILED',
        recordingPath: recPath, recordingError: reason,
      });
    }
  }, 5000);
  recordingStartTimers.set(confName, timer);

  emit('conference.recording', {
    confName, recording: false, recordingState: 'STARTING',
    recordingPath: recPath, recordingError: null,
  });
}

export function setConferenceRecordingError(confName, reason) {
  const entry = conferenceRegistry.get(confName);
  if (entry) {
    entry.recordingState = 'FAILED';
    entry.recordingError = reason || 'Unknown error';
    entry.recording      = false;
  }
  emit('conference.recording', {
    confName,
    recording:      false,
    recordingState: 'FAILED',
    recordingPath:  conferenceRegistry.get(confName)?.recordingPath || null,
    recordingError: reason || 'Unknown error',
  });
}

// ─── ESL command with explicit timeout ──────────────────────────────────────
//
// bgapi callbacks can silently hang if the ESL connection drops between the
// isConn check and the actual send. Without a timeout the caller waits forever,
// blocking every HTTP request that arrives during that window.
function eslCommandTimeout(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!conn || !isConn) return reject(new Error('ESL not connected'));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`ESL bgapi timeout after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);

    conn.bgapi(cmd, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res?.getBody?.() || '');
    });
  });
}

// ─── Parse multi-conference `conference list` output ────────────────────────
//
// `conference list` (no room name) lists every active conference in one shot.
//
// FreeSWITCH output (both "+OK Conference" and bare "Conference" headers seen
// across FS versions — we accept either):
//
//   +OK Conference 3010 (2 members rate: 8000 flags: dynamic)
//   64;6b13-uuid;7001004;7001004;hear|speak|floor|moderator|talking
//   63;7c22-uuid;1001;1001;hear|speak
//
// Member fields (;-separated, 0-indexed):
//   0  = member_id          e.g. 64
//   1  = channel uuid       e.g. 6b13-...
//   2  = caller_id_name     e.g. 7001004
//   3  = caller_id_number   e.g. 7001004
//   4  = flags              pipe-separated: hear|speak|floor|moderator|talking
//   5  = talking            0 or 1 (some FS versions move this here)
//   6  = vol_in
//   7  = vol_out
//   8  = energy_score
//   9  = join_epoch
//
// If parsing fails for any line we log the raw line and skip it — never
// silently continue and never render raw output to the UI.
function parseConferenceListAll(raw) {
  const conferences = [];
  let current = null;

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;

    // Explicitly skip FreeSWITCH usage banners and error responses.
    // These appear when a command is invoked with wrong args OR when FS
    // appends a usage hint at the END of a valid response.
    // Must be checked BEFORE the header regex so a line like
    // "-USAGE: codec|endpoint|..." is never mistaken for anything else.
    //
    // IMPORTANT: Do NOT skip "+OK Conference <name> ..." here.
    // FreeSWITCH prepends "+OK " to the first conference header in the
    // bgapi response body (e.g. "+OK Conference 3010 (2 members ...)").
    // The header regex below handles the optional "+OK " prefix.
    // Only bare "+OK" acknowledgement lines (no content after) are skipped.
    if (t.startsWith('-USAGE:') || t.startsWith('-ERR')) {
      console.warn(`[esl] confListAll: FS error/usage line skipped — "${t.slice(0, 120)}"`);
      continue;
    }
    if (t === '+OK') continue; // bare command acknowledgement, not a conference header

    // Conference header — accept with or without leading "+OK "
    // "Conference 3010 (2 members rate: 8000 flags: dynamic)"
    // "Conference 3010 (2 members rate: 8000 flags: running|answered|dynamic)"
    const hdr = /^(?:\+OK )?Conference (\S+) \((\d+) member/i.exec(t);
    if (hdr) {
      if (current) conferences.push(current);
      const rateMatch  = /rate:\s*(\d+)/.exec(t);
      const flagsMatch = /flags:\s*(\S+)/.exec(t);
      current = {
        name:        hdr[1],
        memberCount: parseInt(hdr[2], 10),
        rate:        rateMatch  ? parseInt(rateMatch[1], 10) : null,
        rawFlags:    flagsMatch ? flagsMatch[1] : null,
        members:     [],
      };
      console.log(
        `[esl] confListAll: conference detected — name="${current.name}"` +
        ` members=${current.memberCount} rate=${current.rate ?? 'unknown'}` +
        ` flags=${current.rawFlags ?? 'unknown'}`
      );
      continue;
    }

    // Member row — starts with a numeric member ID followed by semicolon
    if (current && /^\d+;/.test(t)) {
      const parts = t.split(';');
      if (parts.length < 4) {
        console.warn(`[esl] confListAll: malformed member line in conf "${current.name}" — raw: ${t}`);
        continue;
      }
      const rawMemberFlags = parts[4]?.trim() || '';
      const parsed  = parseMemberFlags(rawMemberFlags);
      // Some FS versions encode talking as a flag; others put 0/1 in parts[5]
      const talking = parsed.talking || parts[5] === '1';

      const member = {
        id:         parts[0].trim(),
        callerName: parts[2].trim() || '',
        callerNum:  parts[3].trim() || '',
        muted:      parsed.muted,
        talking,
        deaf:       parsed.deaf,
        moderator:  parsed.moderator,
        floor:      parsed.floor,
        canHear:    parsed.canHear,
        canSpeak:   parsed.canSpeak,
        volIn:      parseInt(parts[6] || '0', 10) || 0,
        volOut:     parseInt(parts[7] || '0', 10) || 0,
        energy:     parseInt(parts[8] || '0', 10) || 0,
        joinTs:     parts[9]?.trim() || null,
        joinedAt:   null,
        // uuid stored internally only — not sent to frontend
        _uuid:      parts[1].trim(),
      };
      current.members.push(member);
      console.log(
        `[esl] confListAll: member parsed — conf="${current.name}"` +
        ` id=${member.id} num=${member.callerNum}` +
        ` mod=${member.moderator} muted=${member.muted} talking=${talking}`
      );
      continue;
    }

    // Any other line — log at debug level, don't store
    console.log(`[esl] confListAll: unrecognized line skipped — "${t.slice(0, 80)}"`);
  }

  if (current) conferences.push(current);
  return conferences;
}

// ─── Enumerate all active FreeSWITCH conferences with their members ──────────
//
// Sends bgapi "conference list" (no room argument). On this FreeSWITCH build,
// "show conferences" produces -USAGE: because `show` is handled differently
// by bgapi on older FS versions. "conference list" (no room) is the correct
// command — confirmed working on the FreeSWITCH CLI with:
//   freeswitch> conference list
//   Conference 3010 (2 members rate: 8000 flags: dynamic)
//   64;...
//
// Throws loudly when FreeSWITCH returns -USAGE: so the caller can log it
// rather than silently returning an empty list and hiding the error.
async function confListAll() {
  const raw = await eslCommandTimeout('conference list', 8000);

  if (!raw) {
    console.warn('[esl] confListAll: empty response from FreeSWITCH');
    return [];
  }

  // Bad command — fail loudly so we know immediately which command is wrong
  if (raw.trimStart().startsWith('-USAGE:') || raw.trimStart().startsWith('-ERR')) {
    throw new Error(
      `[esl] confListAll: FreeSWITCH rejected command — ` +
      `raw response: ${raw.split('\n')[0].trim()}`
    );
  }

  // No active conferences (empty room list).
  // Use anchored match WITHOUT the /m flag so "+OK" only matches when the
  // ENTIRE response body is that bare acknowledgement — not when "+OK" happens
  // to appear as an isolated line inside a multi-conference response.
  if (
    /no active conference/i.test(raw) ||
    /no conference/i.test(raw)        ||
    /^\+OK\s*$/.test(raw.trim())
  ) {
    console.log('[esl] confListAll: no active conferences reported by FreeSWITCH');
    return [];
  }

  const result = parseConferenceListAll(raw);

  if (result.length === 0) {
    // Parsed but got nothing — log the raw output so we can diagnose
    console.warn('[esl] confListAll: parsed 0 conferences from response. Raw output:\n' + raw);
  } else {
    console.log(`[esl] confListAll: parsed ${result.length} conference(s) successfully`);
  }

  return result;
}

// ─── Seed the in-memory registry from FreeSWITCH live state ─────────────────
//
// Called:
//  • 800 ms after ESL connect (catches backend restarts mid-call)
//  • Every 30 s by startBackgroundJobs (ongoing drift correction)
//  • On demand by GET /monitoring/conferences when snapshot is empty
//
// Each call is idempotent: conferences already in the registry are not
// re-added, and no duplicate socket events are emitted for them.
export async function seedConferenceRegistry() {
  if (!isConn) {
    console.log('[esl] seedConferenceRegistry: skipped — ESL not connected');
    return [];
  }

  console.log('[esl] seedConferenceRegistry: querying FreeSWITCH live state…');
  let conferences;
  try {
    conferences = await confListAll();
  } catch (err) {
    console.error('[esl] seedConferenceRegistry: confListAll failed —', err.message);
    return [];
  }

  if (conferences.length === 0) {
    console.log('[esl] seedConferenceRegistry: FreeSWITCH reports no active conferences');
    // Do NOT return here — fall through to the stale-entry cleanup loop so any
    // conferences that exist in the registry (but not in FreeSWITCH) are removed
    // and conference.ended is emitted to the frontend.
  }

  let addedConfs   = 0;
  let addedMembers = 0;
  let updMembers   = 0;

  for (const conf of conferences) {
    const isNew = !conferenceRegistry.has(conf.name);
    const entry = registryGetOrCreate(conf.name);

    // Always refresh rate/rawFlags from the live header
    if (conf.rate     != null) entry.rate     = conf.rate;
    if (conf.rawFlags != null) entry.rawFlags = conf.rawFlags;

    if (isNew) {
      addedConfs++;
      console.log(`[esl] seedConferenceRegistry: conference inserted — name="${conf.name}" rate=${conf.rate} flags=${conf.rawFlags}`);
      emit('conference.created', { confName: conf.name });
    } else {
      console.log(`[esl] seedConferenceRegistry: conference updated — name="${conf.name}" members=${conf.members.length}`);
    }

    for (const member of conf.members) {
      if (!entry.members.has(member.id)) {
        const rec = {
          id:         member.id,
          callerNum:  member.callerNum  || '',
          callerName: member.callerName || '',
          muted:      member.muted      ?? false,
          deaf:       member.deaf       ?? false,
          moderator:  member.moderator  ?? false,
          talking:    member.talking    ?? false,
          floor:      member.floor      ?? false,
          canHear:    member.canHear    ?? true,
          canSpeak:   member.canSpeak   ?? true,
          volIn:      member.volIn      ?? 0,
          volOut:     member.volOut     ?? 0,
          energy:     member.energy     ?? 0,
          joinedAt:   member.joinedAt   || null,
          _uuid:      member._uuid      || '',
        };
        entry.members.set(member.id, rec);
        addedMembers++;
        console.log(
          `[esl] seedConferenceRegistry: member inserted — conf="${conf.name}"` +
          ` id=${member.id} num=${member.callerNum} mod=${member.moderator}`
        );
        emit('conference.member.joined', {
          confName:   conf.name,
          member:     member.id,
          callerNum:  member.callerNum  || '',
          callerName: member.callerName || '',
          memberData: rec,
        });
      } else {
        // Member already in registry — update mutable fields from live state
        const existing = entry.members.get(member.id);
        existing.muted     = member.muted     ?? existing.muted;
        existing.deaf      = member.deaf      ?? existing.deaf;
        existing.moderator = member.moderator ?? existing.moderator;
        existing.floor     = member.floor     ?? existing.floor;
        existing.canHear   = member.canHear   ?? existing.canHear;
        existing.canSpeak  = member.canSpeak  ?? existing.canSpeak;
        existing.energy    = member.energy    ?? existing.energy;
        existing.volIn     = member.volIn     ?? existing.volIn;
        existing.volOut    = member.volOut    ?? existing.volOut;
        if (!existing._uuid && member._uuid) existing._uuid = member._uuid;
        updMembers++;
        console.log(`[esl] seedConferenceRegistry: member updated — conf="${conf.name}" id=${member.id}`);
      }
    }

    // Remove members that are no longer in the live list (left while ESL was down)
    for (const [id] of entry.members) {
      if (!conf.members.find(m => m.id === id)) {
        entry.members.delete(id);
        console.log(`[esl] seedConferenceRegistry: member removed (no longer live) — conf="${conf.name}" id=${id}`);
        emit('conference.member.left', { confName: conf.name, member: id });
      }
    }
  }

  // Remove conferences that are no longer live.
  // Reconcile the DB (mark incident COMPLETED) BEFORE emitting conference.ended so
  // that any REST reseed triggered by the socket event observes the updated DB state.
  // Without this ordering, the Dashboard reseeds immediately after conference.ended,
  // fetches ers_incidents WHERE status = 'ACTIVE', and sees the incident as still
  // ACTIVE — because the DB update hadn't happened yet.
  for (const [name] of conferenceRegistry) {
    if (!conferences.find(c => c.name === name)) {
      conferenceRegistry.delete(name);
      console.log(`[esl] seedConferenceRegistry: conference removed (no longer live) — name="${name}"`);
      await reconcileOrphanedIncident(name);   // update DB first
      emit('conference.ended', { confName: name }); // socket event second
    }
  }

  console.log(
    `[esl] seedConferenceRegistry: done — ${conferences.length} conference(s),` +
    ` +${addedConfs} new conf(s), +${addedMembers} new member(s), ~${updMembers} updated`
  );

  return conferences;
}

// Returns a serialisable, normalized snapshot.
// Raw FreeSWITCH strings (UUIDs, sofia: URIs, pipe-delimited flags) are
// NEVER included — all FS internals stay server-side.
export function getConferenceSnapshot() {
  return Array.from(conferenceRegistry.entries()).map(([name, c]) => {
    const parsedFlags = parseConfFlags(c.rawFlags);
    return {
      name,
      createdAt:      c.createdAt,
      locked:         c.locked,
      recording:      c.recording,
      recordingPath:  c.recordingPath,
      recordingState: c.recordingState,   // 'OFF'|'STARTING'|'ACTIVE'|'STOPPING'|'FAILED'
      recordingError: c.recordingError,
      floorHolder:    c.floorHolder,
      rate:           c.rate,
      // Normalized flag properties — no raw pipe-delimited string
      isDynamic:      parsedFlags.dynamic,
      isRunning:      parsedFlags.running,
      isAnswered:     parsedFlags.answered,
      isModerated:    parsedFlags.moderated,
      members: Array.from(c.members.values()).map(m => ({
        id:         m.id,
        // Display name: prefer callerName if it's meaningful (not a raw number),
        // fall back to callerNum, then the member ID.
        displayName: (m.callerName && m.callerName !== m.callerNum && !/^\+?\d+$/.test(m.callerName))
          ? m.callerName
          : (m.callerNum || `Member #${m.id}`),
        extension:   m.callerNum  || '',
        callerName:  m.callerName || '',
        callerNum:   m.callerNum  || '',
        role:        m.moderator ? 'moderator' : 'participant',
        moderator:   m.moderator,
        muted:       m.muted,
        deaf:        m.deaf,
        talking:     m.talking,
        floor:       m.floor,
        canHear:     m.canHear,
        canSpeak:    m.canSpeak,
        energy:      m.energy,
        volIn:       m.volIn,
        volOut:      m.volOut,
        joinedAt:    m.joinedAt,
        // uuid deliberately NOT included in the snapshot
      })),
    };
  });
}

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
       WHERE is_active IS NOT NULL`,
      [connected]
    );
  } catch (err) {
    // Non-fatal — heartbeat row may not exist in all environments
    console.warn('[esl] heartbeat update failed:', err.message);
  }
}

// ─── Handle incoming ESL events ─────────────────────────────
async function handleEvent(evt) {
  if (!evt) return;
  const name   = evt.getHeader('Event-Name');
  const subclass = evt.getHeader('Event-Subclass') || '';

  // Conference member join
  if (name === 'CUSTOM' && subclass === 'conference::maintenance') {
    const action     = evt.getHeader('Action');
    const confName   = evt.getHeader('Conference-Name');
    const memberId   = evt.getHeader('Member-ID');
    const callerNum  = evt.getHeader('Caller-Caller-ID-Number') || '';
    const callerName = evt.getHeader('Caller-Caller-ID-Name')   || '';
    const channelUuid = evt.getHeader('Caller-Unique-ID')       || '';

    if (action === 'conference-create') {
      registryGetOrCreate(confName);
      emit('conference.created', { confName });

    } else if (action === 'conference-destroy') {
      conferenceRegistry.delete(confName);
      // Reconcile DB BEFORE emitting to socket — so any REST reseed triggered
      // by the socket event sees the incident already marked COMPLETED, not ACTIVE.
      await reconcileOrphanedIncident(confName);
      emit('conference.ended', { confName });

    } else if (action === 'add-member') {
      const conf  = registryGetOrCreate(confName);
      const rawMF = evt.getHeader('Conference-Member-Flags') || '';
      const pf    = parseMemberFlags(rawMF);
      const member = {
        id:         memberId,
        callerNum,
        callerName,
        displayName: (callerName && callerName !== callerNum && !/^\+?\d+$/.test(callerName))
          ? callerName
          : (callerNum || `Member #${memberId}`),
        extension:  callerNum || '',
        role:       pf.moderator ? 'moderator' : 'participant',
        muted:      pf.muted,
        deaf:       pf.deaf,
        moderator:  pf.moderator,
        talking:    false,
        floor:      false,
        canHear:    pf.canHear,
        canSpeak:   pf.canSpeak,
        volIn:      0,
        volOut:     0,
        energy:     0,
        joinedAt:   new Date().toISOString(),
        _uuid:      channelUuid,
      };
      conf.members.set(memberId, member);
      emit('conference.member.joined', { confName, member: memberId, callerNum, callerName, memberData: member });
      persistEvent('conference.member.joined', { confName, member: memberId, callerNum });
      trackParticipant(confName, callerNum, 'join');

    } else if (action === 'del-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf) conf.members.delete(memberId);
      emit('conference.member.left', { confName, member: memberId, callerNum });
      trackParticipant(confName, callerNum, 'leave');

    } else if (action === 'mute-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).muted = true;
      emit('conference.member.muted', { confName, member: memberId, callerNum, muted: true });

    } else if (action === 'unmute-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).muted = false;
      emit('conference.member.muted', { confName, member: memberId, callerNum, muted: false });

    } else if (action === 'deaf-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).deaf = true;
      emit('conference.member.deaf', { confName, member: memberId, deaf: true });

    } else if (action === 'undeaf-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).deaf = false;
      emit('conference.member.deaf', { confName, member: memberId, deaf: false });

    } else if (action === 'start-talking') {
      console.log(`[esl] start-talking — conf="${confName}" member=${memberId} num=${callerNum}`);
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).talking = true;
      emit('conference.member.talking', { confName, member: memberId, callerNum, talking: true });

    } else if (action === 'stop-talking') {
      console.log(`[esl] stop-talking  — conf="${confName}" member=${memberId} num=${callerNum}`);
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).talking = false;
      emit('conference.member.talking', { confName, member: memberId, callerNum, talking: false });

    } else if (action === 'floor-change') {
      const newFloor = evt.getHeader('New-ID');
      const conf = conferenceRegistry.get(confName);
      if (conf) {
        conf.floorHolder = newFloor;
        for (const [mid, m] of conf.members) m.floor = (mid === newFloor);
      }
      emit('conference.floor.changed', { confName, member: newFloor });

    } else if (action === 'lock') {
      const conf = conferenceRegistry.get(confName);
      if (conf) conf.locked = true;
      emit('conference.locked', { confName, locked: true });

    } else if (action === 'unlock') {
      const conf = conferenceRegistry.get(confName);
      if (conf) conf.locked = false;
      emit('conference.locked', { confName, locked: false });

    } else if (action === 'start-recording') {
      // FreeSWITCH confirmed the file opened — clear the STARTING timeout
      if (recordingStartTimers.has(confName)) {
        clearTimeout(recordingStartTimers.get(confName));
        recordingStartTimers.delete(confName);
      }
      const conf = conferenceRegistry.get(confName);
      // FreeSWITCH sends the recording file path in the 'Path' header.
      // Accept any of the known header names across FS versions.
      const recPath = evt.getHeader('Path') || evt.getHeader('Recording-File') || evt.getHeader('Recording-Path') || null;
      console.log(`[esl] start-recording event — conf="${confName}" path="${recPath}"`);
      if (conf) {
        conf.recording      = true;
        conf.recordingState = 'ACTIVE';
        conf.recordingError = null;
        if (recPath) conf.recordingPath = recPath;
      }
      emit('conference.recording', {
        confName,
        recording:      true,
        recordingState: 'ACTIVE',
        recordingPath:  conf?.recordingPath || recPath,
        recordingError: null,
      });
      // Auto-persist recording to DB so it appears in Recording Management
      const finalPath = conf?.recordingPath || recPath;
      if (finalPath) {
        import('../controllers/recordingController.js').then(({ upsertRecordingStart }) => {
          upsertRecordingStart({ confName, recPath: finalPath, createdBy: 'system' });
        }).catch(err => console.error('[esl] upsertRecordingStart import failed:', err.message));
      }

    } else if (action === 'energy-level') {
      // Real-time per-member energy update. FreeSWITCH fires this when
      // the conference energy-level threshold is changed for a member.
      const energyVal = parseInt(evt.getHeader('Conference-Energy-Level') || '0', 10) || 0;
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).energy = energyVal;
      // No socket event needed — energy is reflected in the next snapshot/joined event.

    } else if (action === 'stop-recording') {
      const conf    = conferenceRegistry.get(confName);
      const recPath = evt.getHeader('Path') || evt.getHeader('Recording-File') || evt.getHeader('Recording-Path') || conf?.recordingPath || null;
      console.log(`[esl] stop-recording event — conf="${confName}" path="${recPath}"`);
      const lastPath = recPath || conf?.recordingPath || null;
      if (conf) {
        conf.recording      = false;
        conf.recordingState = 'OFF';
        // Keep recordingPath so the UI can show "last recording was X"
      }
      emit('conference.recording', {
        confName,
        recording: false,
        recordingState: 'OFF',
        recordingPath: lastPath,
      });
      // Close the DB recording record and extract metadata
      if (lastPath) {
        import('../controllers/recordingController.js').then(({ closeRecording }) => {
          closeRecording({ confName, recPath: lastPath });
        }).catch(err => console.error('[esl] closeRecording import failed:', err.message));
      }
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

// ─── Participant tracking (Phase 5 — ers_incident_participants) ─────
//
// One row per person per incident, with join/leave/rejoin timestamps —
// the detail level the ERS incident report needs ("all participants,
// join/leave/rejoin") that a single status column can't represent for
// someone who dropped and came back. Driven by mod_conference's own
// add-member/del-member events so it's accurate regardless of WHICH path
// put the leg in the room (ring-all originate, caller's own Lua bridge,
// a rejoin redial).
async function trackParticipant(confName, callerNum, event) {
  if (!confName || !callerNum) return;
  try {
    const { rows: [incident] } = await query(
      `SELECT id FROM ers_incidents
       WHERE conference_room = $1 AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [confName]
    );
    if (!incident) return; // not an ERS room (e.g. an unrelated conference)

    const last9 = String(callerNum).replace(/\D/g, '').slice(-9);
    const { rows: [contact] } = await query(
      `SELECT id FROM emergency_contacts
       WHERE deleted_at IS NULL
         AND (extension_number = $1
              OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
       LIMIT 1`,
      [callerNum, last9]
    );

    if (event === 'join') {
      const { rows: [existing] } = await query(
        `SELECT id, left_at FROM ers_incident_participants
         WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3)
         ORDER BY joined_at DESC LIMIT 1`,
        [incident.id, callerNum, contact?.id ?? null]
      );
      if (existing && existing.left_at) {
        // Same person coming back — a rejoin, not a new participant.
        await query(
          `UPDATE ers_incident_participants
           SET rejoined_at = now(), left_at = NULL WHERE id = $1`,
          [existing.id]
        );
      } else if (!existing) {
        await query(
          `INSERT INTO ers_incident_participants (incident_id, contact_id, raw_number, role, joined_at)
           VALUES ($1, $2, $3, 'responder', now())`,
          [incident.id, contact?.id ?? null, callerNum]
        );
      }
    } else if (event === 'leave') {
      await query(
        `UPDATE ers_incident_participants
         SET left_at = now()
         WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3) AND left_at IS NULL`,
        [incident.id, callerNum, contact?.id ?? null]
      );
    }
  } catch (err) {
    // Table may not exist yet (migration 016 pending) — never let audit
    // tracking break live call event handling.
    console.error('[esl] trackParticipant failed:', err.message);
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
  } catch (err) {
    console.warn('[esl] persistEvent failed:', err.message);
  }
}

// ─── Connect to FreeSWITCH ───────────────────────────────────
export function connect() {
  if (conn) { try { conn.end(); } catch {} }

  // Log the resolved host/port so we can immediately verify env vars loaded
  console.log(
    `[esl] Connecting to ${config.esl.host}:${config.esl.port}` +
    ` (ESL_HOST=${process.env.ESL_HOST || '(unset — using default)'})`
  );

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
      ]);

      conn.on('esl::event', handleEvent);

      emit('esl.status', { connected: true, host: config.esl.host, port: config.esl.port });
      updateHeartbeat(true);

      // Seed registry with any conferences already active in FreeSWITCH.
      // Without this, a backend restart while calls are in-progress leaves the
      // registry empty because the conference-create / add-member events already
      // fired before this ESL session opened.  Give FreeSWITCH 800 ms to finish
      // processing the subscribe ACK before issuing the bgapi.
      setTimeout(() => seedConferenceRegistry().catch(err =>
        console.warn('[esl] startup seed failed:', err.message)
      ), 800);
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
  // Exponential backoff: base * 2^attempts, capped at 30 s
  const delay = Math.min(config.esl.reconnectMs * Math.pow(2, Math.min(reconnectCount - 1, 5)), 30_000);
  console.log(`[esl] Reconnecting in ${delay}ms (attempt #${reconnectCount})`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

// ─── Execute an ESL command, return result ───────────────────
//
// Uses a 10-second timeout so a stale/dropped connection doesn't hang
// indefinitely. Callers that need a different timeout use eslCommandTimeout
// directly.
export function eslCommand(cmd) {
  return eslCommandTimeout(cmd, 10_000);
}

// ─── Originate a call leg ────────────────────────────────────
//
// Gateway-agnostic (Phase 4) — the dial string is resolved by
// dialResolver.js, never constructed inline here. With zero SIP gateways
// configured this always dials user/<ext> (FreeSWITCH resolves the
// registered contact); adding a tenant's default gateway (or a
// per-contact override) switches it to sofia/gateway/<name>/<number>
// with no code change.
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

// ─── Mute / unmute a conference member ──────────────────────
export async function confMute(confName, memberId) {
  return eslCommand(`conference ${confName} mute ${memberId}`);
}

export async function confUnmute(confName, memberId) {
  return eslCommand(`conference ${confName} unmute ${memberId}`);
}

// ─── Lock / unlock ──────────────────────────────────────────
export async function confLock(confName) {
  return eslCommand(`conference ${confName} lock`);
}

export async function confUnlock(confName) {
  return eslCommand(`conference ${confName} unlock`);
}

// ─── Deaf / Undeaf ──────────────────────────────────────────
export async function confDeaf(confName, memberId) {
  return eslCommand(`conference ${confName} deaf ${memberId}`);
}

export async function confUndeaf(confName, memberId) {
  return eslCommand(`conference ${confName} undeaf ${memberId}`);
}

// ─── Volume ─────────────────────────────────────────────────
export async function confVolumeIn(confName, memberId, level) {
  return eslCommand(`conference ${confName} volume_in ${memberId} ${level}`);
}

export async function confVolumeOut(confName, memberId, level) {
  return eslCommand(`conference ${confName} volume_out ${memberId} ${level}`);
}

// ─── Energy level ────────────────────────────────────────────
export async function confEnergy(confName, memberId, level) {
  return eslCommand(`conference ${confName} energy ${memberId} ${level}`);
}

// ─── Floor control ──────────────────────────────────────────
export async function confFloor(confName, memberId) {
  return eslCommand(`conference ${confName} floor ${memberId}`);
}

// ─── Transfer a member to another extension ─────────────────
export async function confTransfer(confName, memberId, extension, dialplan = 'XML', context = 'default') {
  return eslCommand(`conference ${confName} transfer ${memberId} ${extension} ${dialplan} ${context}`);
}

// ─── Recording ───────────────────────────────────────────────
export async function confRecord(confName, path) {
  return eslCommand(`conference ${confName} record ${path}`);
}

export async function confRecordStop(confName, path) {
  return eslCommand(`conference ${confName} norecord ${path}`);
}

// Stop ALL active recordings in a conference regardless of path.
// Used as a fallback when the specific path is lost or mismatched.
export async function confRecordStopAll(confName) {
  return eslCommand(`conference ${confName} norecord all`);
}

// ─── Terminate (empty the room) ──────────────────────────────
export async function confTerminate(confName) {
  return eslCommand(`conference ${confName} kick all`);
}

// ─── TTS broadcast ───────────────────────────────────────────
export async function confSay(confName, text) {
  return eslCommand(`conference ${confName} say ${text}`);
}

// ─── Invite a number into the conference ────────────────────
export async function confInvite(confName, dialString) {
  return eslCommand(`conference ${confName} bgdial ${dialString}`);
}

// ─── List all members in a conference ───────────────────────
//
// mod_conference "list" output format (one line per member):
//   id;uuid;caller_id_name;caller_id_number;flags;talking;vol_in;vol_out;energy;join_ts
// flags is pipe-separated: hear|speak|mute|deaf|moderator|floor|talking
//
// Returns empty array when the conference doesn't exist or ESL is down.
export async function confList(confName) {
  if (!confName) return [];
  try {
    const raw = await eslCommand(`conference ${confName} list`);
    if (!raw || raw.includes('No conference') || raw.includes('not found')) return [];
    if (raw.startsWith('-USAGE:')) {
      throw new Error(`ESL command rejected: "conference ${confName} list" → ${raw.split('\n')[0]}`);
    }
    const members = [];
    for (const line of raw.trim().split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('-USAGE:') || t.startsWith('-ERR') || t === '+OK') continue;
      const parts = t.split(';');
      if (parts.length < 4) continue;
      const rawMF = parts[4]?.trim() || '';
      const pf    = parseMemberFlags(rawMF);
      const talking = pf.talking || parts[5] === '1';
      const callerName = parts[2]?.trim() || '';
      const callerNum  = parts[3]?.trim() || '';
      members.push({
        id:          parts[0]?.trim(),
        callerName,
        callerNum,
        displayName: (callerName && callerName !== callerNum && !/^\+?\d+$/.test(callerName))
          ? callerName : (callerNum || `Member #${parts[0]?.trim()}`),
        extension:   callerNum,
        role:        pf.moderator ? 'moderator' : 'participant',
        muted:       pf.muted,
        talking,
        deaf:        pf.deaf,
        moderator:   pf.moderator,
        floor:       pf.floor,
        canHear:     pf.canHear,
        canSpeak:    pf.canSpeak,
        energy:      parseInt(parts[8] || '0', 10) || 0,
        joinTs:      parts[9]?.trim() || null,
        joinedAt:    null,
        // _uuid internal only, not sent to frontend via confList
      });
    }
    return members;
  } catch (err) {
    console.error(`[esl] confList: failed to list members for conf="${confName}" — ${err.message}`);
    return [];
  }
}

// ─── Live conference member count — Phase 5's tier-status distinction ──
//
// ers_incidents.status alone only ever means "this particular leg's
// completion call ran" — NOT "the room is empty" (see the comment on
// completeIncidentCore()). Any code that needs to know whether a tier is
// genuinely free to ring must check the room's actual live member count
// via ESL, never the DB status column alone. Returns 0 for a room that
// doesn't exist (already destroyed / never created) rather than erroring
// — that's the correct "not occupied" answer for this use case.
export async function getConferenceMemberCount(room) {
  if (!room) return 0;
  try {
    const res = await eslCommand(`conference ${room} count`);
    if (!res || res.startsWith('-USAGE:') || res.startsWith('-ERR')) return 0;
    const match = /^(\d+)/.exec((res || '').trim());
    return match ? Number(match[1]) : 0;
  } catch (err) {
    console.error(`[esl] getConferenceMemberCount: ESL error for room="${room}" — ${err.message}`);
    return 0;
  }
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

// ─── xml_list helpers ─────────────────────────────────────────────────────────
//
// `conference <name> xml_list` returns the authoritative member state with
// explicit boolean tags — no inference from pipe-delimited flag strings.
// Used for post-command verification and as the source of truth whenever the
// text `conference list` flags may be ambiguous.
//
// Sample FreeSWITCH xml_list output:
//   <conferences>
//     <conference name="3010" rate="8000" locked="false" ...>
//       <members>
//         <member type="caller">
//           <id>64</id>
//           <uuid>...</uuid>
//           <caller_id_name>7001004</caller_id_name>
//           <caller_id_number>7001004</caller_id_number>
//           <flags>
//             <can_hear>true</can_hear>
//             <can_speak>true</can_speak>
//             <talking>false</talking>
//             <has_floor>true</has_floor>
//             <is_moderator>true</is_moderator>
//           </flags>
//           <volume_in>0</volume_in>
//           <volume_out>0</volume_out>
//           <energy>300</energy>
//         </member>
//       </members>
//     </conference>
//   </conferences>

function xmlBool(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return m ? m[1].trim() === 'true' : null;
}

function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

// Parse the output of `conference <name> xml_list`.
// Returns { members, locked, rate } or null when the conference doesn't exist.
export function parseConferenceXmlList(xml) {
  if (!xml) return null;
  const t = xml.trim();
  if (t.startsWith('-ERR') || t.startsWith('-USAGE') || !t.includes('<conference')) return null;

  // Conference-level attributes from the <conference> opening tag
  const hdrMatch = /<conference\s+([^>]+?)(?:\s*\/)?>/i.exec(t);
  const hdrAttrs = hdrMatch ? hdrMatch[1] : '';
  const locked   = /\blocked="true"/i.test(hdrAttrs);
  const rateStr  = (/\brate="(\d+)"/i.exec(hdrAttrs) || [])[1];

  const members = [];
  for (const m of t.matchAll(/<member\s+type="caller">([\s\S]*?)<\/member>/gi)) {
    const mxml     = m[1];
    const flagsM   = /<flags>([\s\S]*?)<\/flags>/i.exec(mxml);
    const flagsXml = flagsM ? flagsM[1] : '';
    const id       = xmlText(mxml, 'id');
    if (!id) continue;

    const canSpeak = xmlBool(flagsXml, 'can_speak');
    const canHear  = xmlBool(flagsXml, 'can_hear');
    members.push({
      id,
      uuid:       xmlText(mxml, 'uuid')             || '',
      callerName: xmlText(mxml, 'caller_id_name')   || '',
      callerNum:  xmlText(mxml, 'caller_id_number') || '',
      canSpeak:   canSpeak  ?? true,
      canHear:    canHear   ?? true,
      muted:      canSpeak  === null ? false : !canSpeak,
      deaf:       canHear   === null ? false : !canHear,
      talking:    xmlBool(flagsXml, 'talking')      ?? false,
      floor:      xmlBool(flagsXml, 'has_floor')    ?? false,
      moderator:  xmlBool(flagsXml, 'is_moderator') ?? false,
      energy:     parseInt(xmlText(mxml, 'energy')    || '0', 10) || 0,
      volIn:      parseInt(xmlText(mxml, 'volume_in') || '0', 10) || 0,
      volOut:     parseInt(xmlText(mxml, 'volume_out')|| '0', 10) || 0,
    });
  }

  return { members, locked, rate: rateStr ? parseInt(rateStr, 10) : null };
}

// Execute `conference <confName> xml_list` and return parsed result, or null on error.
export async function confXmlList(confName) {
  if (!confName) return null;
  try {
    const raw = await eslCommandTimeout(`conference ${confName} xml_list`, 5000);
    return parseConferenceXmlList(raw);
  } catch (err) {
    console.error(`[esl] confXmlList: failed — conf="${confName}" err="${err.message}"`);
    return null;
  }
}

// Compare xml_list result against the in-memory registry and emit socket events
// for each field that differs. Called 300 ms after every member/conference control
// command so clients always see authoritative FreeSWITCH state regardless of
// whether the corresponding ESL maintenance event was received.
export async function syncConferenceFromXml(confName) {
  const xmlData = await confXmlList(confName);
  if (!xmlData) {
    console.warn(`[esl] syncConferenceFromXml: no data for conf="${confName}"`);
    return;
  }

  const entry = conferenceRegistry.get(confName);
  if (!entry) return; // conference ended while we were waiting — normal

  // Conference-level: lock
  if (entry.locked !== xmlData.locked) {
    entry.locked = xmlData.locked;
    emit('conference.locked', { confName, locked: xmlData.locked });
    console.log(`[esl] sync: lock corrected — conf="${confName}" locked=${xmlData.locked}`);
  }
  if (xmlData.rate && !entry.rate) entry.rate = xmlData.rate;

  // Per-member state — only update members already in the registry.
  // New members that appeared between command and xml_list will be caught
  // by the next add-member event or 30-second seed.
  for (const m of xmlData.members) {
    if (!entry.members.has(m.id)) continue;
    const e = entry.members.get(m.id);

    const mutedChanged   = e.muted   !== m.muted;
    const deafChanged    = e.deaf    !== m.deaf;
    const talkingChanged = e.talking !== m.talking;
    const floorChanged   = e.floor   !== m.floor;

    // Apply authoritative xml_list state
    e.muted     = m.muted;
    e.deaf      = m.deaf;
    e.talking   = m.talking;
    e.floor     = m.floor;
    e.moderator = m.moderator;
    e.canSpeak  = m.canSpeak;
    e.canHear   = m.canHear;
    e.energy    = m.energy;
    e.volIn     = m.volIn;
    e.volOut    = m.volOut;

    if (mutedChanged) {
      emit('conference.member.muted', { confName, member: m.id, callerNum: m.callerNum, muted: m.muted });
      console.log(`[esl] sync: mute corrected — conf="${confName}" member=${m.id} muted=${m.muted}`);
    }
    if (deafChanged) {
      emit('conference.member.deaf', { confName, member: m.id, deaf: m.deaf });
    }
    if (talkingChanged) {
      emit('conference.member.talking', { confName, member: m.id, callerNum: m.callerNum, talking: m.talking });
    }
    if (floorChanged && m.floor) {
      emit('conference.floor.changed', { confName, member: m.id });
    }
  }

  console.log(`[esl] syncConferenceFromXml: done — conf="${confName}" ${xmlData.members.length} member(s) verified`);
}

// ─── Get current ESL status ─────────────────────────────────
export function eslStatus() {
  return { connected: isConn, host: config.esl.host, port: config.esl.port, reconnect_attempts: reconnectCount };
}

// ─── Incident reconciliation sweep ──────────────────────────
//
// Finds every ACTIVE ers_incidents row within 48 h and checks its
// deterministic conference room via ESL. If the room is empty (member
// count == 0), the incident is an orphan — FreeSWITCH never sent the
// conference-destroy event (missed while ESL was disconnected, or the
// backend restarted mid-call). Mark it COMPLETED so the queue can drain.
//
// Also expires QUEUED ers_queues rows older than 2 hours whose caller
// has already hung up (they produce stale queue depth in the dashboard).
//
// Called from server.js at startup (via setTimeout) and on a 60-second
// interval started by startBackgroundJobs() below. Standalone CLI scripts
// (cleanup_orphaned_ers_incidents.js, tests) must NOT import this file
// without calling startBackgroundJobs(), but they DON'T — so no intervals
// fire when the module is loaded by a script that never calls the starter.
export async function reconcileAllActiveIncidents() {
  // CRITICAL: skip when ESL is not connected. getConferenceMemberCount returns 0
  // for every room when ESL is down (it catches the connection error and returns 0).
  // Without this guard, every active incident would be falsely completed as an orphan
  // the moment ESL disconnects — destroying live incident state.
  if (!isConn) {
    console.log('[esl] reconcileAllActiveIncidents: skipped — ESL not connected');
    return;
  }
  try {
    const { rows } = await query(
      `SELECT incident_uuid, conference_room FROM ers_incidents
       WHERE status = 'ACTIVE' AND deleted_at IS NULL
         AND started_at > now() - interval '48 hours'
         AND conference_room IS NOT NULL`,
    );
    for (const { incident_uuid, conference_room } of rows) {
      try {
        const members = await getConferenceMemberCount(conference_room);
        if (members === 0) {
          const { completeIncidentCore } = await import('../controllers/internal/ersInternalController.js');
          const result = await completeIncidentCore(incident_uuid, null);
          if (result) {
            console.log(`[esl] reconcile: completed orphaned incident ${incident_uuid} (room ${conference_room} was empty)`);
          }
        }
      } catch (err) {
        console.error(`[esl] reconcile: error for incident ${incident_uuid}:`, err.message);
      }
    }

    // Expire QUEUED rows (and their incidents) abandoned for over 2 hours.
    // These accumulate when a queued caller hangs up before the Lua loop
    // can call /overflow/cancel (e.g. network drop, FS crash).
    await query(
      `UPDATE ers_queues SET status = 'EXPIRED', updated_at = now()
       WHERE status = 'QUEUED' AND created_at < now() - interval '2 hours'`
    );
    await query(
      `UPDATE ers_incidents SET status = 'COMPLETED', ended_at = now()
       WHERE status = 'QUEUED' AND deleted_at IS NULL
         AND id NOT IN (SELECT incident_id FROM ers_queues WHERE status = 'QUEUED')`
    );
  } catch (err) {
    console.error('[esl] reconcileAllActiveIncidents failed:', err.message);
  }
}

// ─── Background jobs (heartbeat + sweep) ────────────────────
//
// Intentionally NOT started at module load time so that standalone CLI
// scripts and test files that import from this module don't inherit the
// intervals and then break when the pool is ended.
//
// server.js calls this once during the boot sequence. Nothing else should.
export function startBackgroundJobs() {
  // Heartbeat: ping FS every 30 s + drift-correction re-seed
  setInterval(async () => {
    if (!isConn) return;
    try {
      await eslCommandTimeout('status', 5000);
      updateHeartbeat(true);
    } catch {
      updateHeartbeat(false);
    }
    // Re-seed on every heartbeat tick so the registry never drifts more
    // than 30 s behind FreeSWITCH — catches any add-member/del-member event
    // that was dropped while ESL was briefly disconnected.
    seedConferenceRegistry().catch(err =>
      console.warn('[esl] periodic reseed failed:', err.message)
    );
  }, 30_000);

  // 60-second safety sweep — catches anything the conference-destroy event
  // missed (e.g. ESL was disconnected when the room emptied).
  setInterval(() => {
    if (!isConn) return;
    reconcileAllActiveIncidents().catch(() => {});
  }, 60_000);
}
