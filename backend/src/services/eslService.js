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

  // Use xml_list (authoritative) — NOT the text `conference list` parser.
  // The text parser infers muted from pipe-delimited flags which is unreliable:
  // a member that FreeSWITCH considers unmuted may not have 'speak' in its
  // text flags, causing the text parser to return muted=true incorrectly.
  // xml_list returns explicit <can_speak> booleans with no inference needed.
  console.log('[esl] seedConferenceRegistry: querying FreeSWITCH via xml_list…');
  let conferences;
  try {
    conferences = await confXmlListAll();
  } catch (err) {
    console.error('[esl] seedConferenceRegistry: confXmlListAll failed —', err.message);
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

    // Refresh rate and flags from xml_list header
    if (conf.rate     != null) entry.rate     = conf.rate;
    if (conf.rawFlags != null) entry.rawFlags = conf.rawFlags;
    // Lock state from xml_list is authoritative
    if (conf.locked !== entry.locked) {
      entry.locked = conf.locked;
      emit('conference.locked', { confName: conf.name, locked: conf.locked });
    }

    if (isNew) {
      addedConfs++;
      console.log(`[esl] seedConferenceRegistry: conference inserted — name="${conf.name}" rate=${conf.rate} locked=${conf.locked} flags="${conf.rawFlags}"`);
      emit('conference.created', { confName: conf.name });
    } else {
      console.log(`[esl] seedConferenceRegistry: conference updated — name="${conf.name}" members=${conf.members.length}`);
    }

    for (const member of conf.members) {
      if (!entry.members.has(member.id)) {
        const rec = {
          id:          member.id,
          callerNum:   member.callerNum  || '',
          callerName:  member.callerName || '',
          displayName: member.displayName || member.callerName || member.callerNum || `Member #${member.id}`,
          muted:       member.muted      ?? false,
          deaf:        member.deaf       ?? false,
          moderator:   member.moderator  ?? false,
          talking:     false,            // xml_list is a snapshot; start with false,
                                         // start-talking event will correct if needed
          floor:       member.floor      ?? false,
          canHear:     member.canHear    ?? true,
          canSpeak:    member.canSpeak   ?? true,
          volIn:       member.volIn      ?? 0,
          volOut:      member.volOut     ?? 0,
          energy:      member.energy     ?? 0,
          joinedAt:    member.joinedAt   || null,
          _uuid:       member._uuid      || '',
        };
        entry.members.set(member.id, rec);
        addedMembers++;
        console.log(
          `[esl] seedConferenceRegistry: member inserted — conf="${conf.name}"` +
          ` id=${member.id} num=${member.callerNum} muted=${member.muted} mod=${member.moderator}`
        );
        emit('conference.member.joined', {
          confName:   conf.name,
          member:     member.id,
          callerNum:  member.callerNum  || '',
          callerName: member.callerName || '',
          memberData: rec,
        });
      } else {
        // Member already in registry — NEVER overwrite event-driven state.
        //
        // muted, deaf, talking, floor, locked: owned exclusively by ESL maintenance
        // events (mute-member, unmute-member, deaf-member, undeaf-member, start-talking,
        // stop-talking, floor-change, lock, unlock) and by post-command xml_list
        // verification (syncConferenceFromXml). The seed runs at 30-second intervals
        // and would race against and overwrite correct event state if it wrote here.
        //
        // The seed's job for existing members is structural only:
        //   • update cosmetic/audio fields (energy, volume) that have no socket events
        //   • fill in _uuid if it was missing at join time
        const existing = entry.members.get(member.id);
        existing.energy = member.energy ?? existing.energy;
        existing.volIn  = member.volIn  ?? existing.volIn;
        existing.volOut = member.volOut ?? existing.volOut;
        if (!existing._uuid && member._uuid) existing._uuid = member._uuid;
        updMembers++;
        console.log(
          `[esl] seedConferenceRegistry: existing member — conf="${conf.name}" id=${member.id}` +
          ` preserving event state: muted=${existing.muted} talking=${existing.talking} deaf=${existing.deaf}`
        );
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
    const callerNum   = evt.getHeader('Caller-Caller-ID-Number')    || '';
    const callerName  = evt.getHeader('Caller-Caller-ID-Name')     || '';
    const channelUuid = evt.getHeader('Caller-Unique-ID')          || '';
    // For ring-all originated legs, Caller-Caller-ID-Number = initiator's number
    // (set by origination_caller_id_number so the responder's phone shows the right caller).
    // The responder's actual extension is in Caller-Destination-Number.
    const destNum     = evt.getHeader('Caller-Destination-Number') || '';

    if (action === 'conference-create') {
      registryGetOrCreate(confName);
      emit('conference.created', { confName });
      import('./conferenceManager.js').then(({ handleConferenceCreated }) => {
        handleConferenceCreated(confName).catch(err =>
          console.error(`[esl] conferenceManager.handleConferenceCreated failed conf="${confName}": ${err.message}`)
        );
      }).catch(() => {});

    } else if (action === 'conference-destroy') {
      // Capture recording state BEFORE deleting the registry entry.
      // stop-recording may arrive after conference-destroy on some FS versions,
      // at which point conf is null and conf?.recordingPath would be undefined.
      // Closing here ensures the recording is always finalised on conference end.
      const destroyedConf = conferenceRegistry.get(confName);
      const activeRecPath = destroyedConf?.recordingPath || null;
      if (activeRecPath && (destroyedConf?.recording || destroyedConf?.recordingState === 'ACTIVE' || destroyedConf?.recordingState === 'STARTING')) {
        import('../controllers/recordingController.js').then(({ closeRecording }) => {
          closeRecording({ confName, recPath: activeRecPath });
        }).catch(err => console.error('[esl] closeRecording on conference-destroy failed:', err.message));
      }

      conferenceRegistry.delete(confName);
      // Reconcile DB BEFORE emitting to socket — so any REST reseed triggered
      // by the socket event sees the incident already marked COMPLETED, not ACTIVE.
      await reconcileOrphanedIncident(confName);
      emit('conference.ended', { confName });

    } else if (action === 'add-member') {
      const conf  = registryGetOrCreate(confName);
      const rawMF = evt.getHeader('Conference-Member-Flags') || '';
      const pf    = parseMemberFlags(rawMF);
      // parseMemberFlags uses text-flag inference — it is unreliable for muted state
      // on some FreeSWITCH versions. Log the raw flags so any inference error is visible.
      console.log(
        `[esl] add-member: conf="${confName}" id=${memberId} num=${callerNum}` +
        ` | raw flags="${rawMF}" → muted=${pf.muted} moderator=${pf.moderator} deaf=${pf.deaf}`
      );
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
      const memberCount = conf.members.size;
      if (memberCount === 1) {
        import('./conferenceManager.js').then(({ handleFirstParticipant }) => {
          handleFirstParticipant(confName, memberCount).catch(err =>
            console.error(`[esl] conferenceManager.handleFirstParticipant failed conf="${confName}": ${err.message}`)
          );
        }).catch(() => {});
      }
      emit('conference.member.joined', { confName, member: memberId, callerNum, callerName, memberData: member });
      persistEvent('conference.member.joined', { confName, member: memberId, callerNum });
      trackParticipant(confName, callerNum, destNum, 'join', memberId);
      // Schedule a quick xml_list 600ms after join to correct the initial muted/deaf
      // state, since parseMemberFlags inference can be wrong. The member is already
      // in the UI by then; syncConferenceFromXml emits a correction event if needed.
      setTimeout(() => {
        syncConferenceFromXml(confName).catch(err =>
          console.error(`[esl] post-join sync failed — conf="${confName}": ${err.message}`)
        );
      }, 600);

    } else if (action === 'del-member') {
      const conf = conferenceRegistry.get(confName);
      if (conf) conf.members.delete(memberId);
      emit('conference.member.left', { confName, member: memberId, callerNum });
      trackParticipant(confName, callerNum, destNum, 'leave', null);

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
      // Auto-persist recording to DB so it appears in Recording Management.
      // Infer recording type from path so ERS and MANUAL recordings are correctly
      // separated even when both come through the same ESL event handler.
      const finalPath = conf?.recordingPath || recPath;
      if (finalPath) {
        const recType = finalPath.includes('/ers/')    ? 'ERS'
                      : finalPath.includes('/ens/')    ? 'ENS'
                      : finalPath.includes('/ivr/')    ? 'IVR'
                      : finalPath.includes('/manual/') ? 'MANUAL'
                      : 'ERS'; // legacy conf/ → treat as ERS for backward compat
        import('../controllers/recordingController.js').then(({ upsertRecordingStart }) => {
          upsertRecordingStart({ type: recType, confName, recPath: finalPath, createdBy: 'system' });
        }).catch(err => console.error('[esl] upsertRecordingStart import failed:', err.message));
        // Sync recording_path onto the active ERS incident so the monitoring UI
        // and reports can link directly to the recording without a JOIN on recordings.
        if (recType === 'ERS') {
          import('../db/pool.js').then(({ query: dbQuery }) => {
            dbQuery(
              `UPDATE ers_incidents SET recording_path = $1
               WHERE conference_room = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
              [finalPath, confName]
            ).catch(err => console.error('[esl] ers_incidents recording_path sync failed:', err.message));
          }).catch(() => {});
        }
      }

    } else if (action === 'energy-level') {
      // Real-time per-member energy update. FreeSWITCH fires this when
      // the conference energy-level threshold is changed for a member.
      const energyVal = parseInt(evt.getHeader('Conference-Energy-Level') || '0', 10) || 0;
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) conf.members.get(memberId).energy = energyVal;
      emit('conference.member.energy', { confName, member: memberId, callerNum, energy: energyVal });

    } else if (action === 'moderator') {
      // FreeSWITCH toggles moderator flag when `conference <room> moderator <id>` is called.
      const conf = conferenceRegistry.get(confName);
      if (conf?.members.has(memberId)) {
        const m = conf.members.get(memberId);
        m.moderator = !m.moderator;
        emit('conference.member.moderator', { confName, member: memberId, callerNum, moderator: m.moderator });
      }

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
      } else {
        // Log any unhandled conference::maintenance action so we can see exactly
        // what FreeSWITCH sends — critical for diagnosing missing talking events.
        console.log(
          `[esl] conference::maintenance unhandled action="${action}"` +
          ` conf="${confName}" member=${memberId} num=${callerNum}`
        );
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

  // Channel create — new call leg established
  if (name === 'CHANNEL_CREATE') {
    const uuid      = evt.getHeader('Unique-ID');
    const callerNum = evt.getHeader('Caller-Caller-ID-Number');
    const destNum   = evt.getHeader('Caller-Destination-Number');
    emit('channel.create', { uuid, callerNum, destNum });
    eslEvents.emit('CHANNEL_CREATE', { uuid, callerNum, destNum });
    return;
  }

  // Channel bridge — two legs connected
  if (name === 'CHANNEL_BRIDGE') {
    const uuid       = evt.getHeader('Unique-ID');
    const bridgeUuid = evt.getHeader('Bridge-B-Unique-ID');
    const callerNum  = evt.getHeader('Caller-Caller-ID-Number');
    emit('channel.bridge', { uuid, bridgeUuid, callerNum });
    eslEvents.emit('CHANNEL_BRIDGE', { uuid, bridgeUuid, callerNum });
    return;
  }

  // DTMF digit pressed during a call
  if (name === 'DTMF') {
    const uuid   = evt.getHeader('Unique-ID');
    const digit  = evt.getHeader('DTMF-Digit');
    const dur    = evt.getHeader('DTMF-Duration');
    emit('channel.dtmf', { uuid, digit, duration: dur });
    eslEvents.emit('DTMF', { uuid, digit, duration: dur });
    return;
  }

  // Lua record_session completed — register recording in DB immediately.
  // FreeSWITCH fires RECORD_STOP for both record_session (Lua) and conference record (ESL).
  // For ESL conference recordings, upsertRecordingStart was already called from the
  // start-recording event handler; ON CONFLICT DO NOTHING prevents duplicates.
  if (name === 'RECORD_STOP') {
    const recPath  = evt.getHeader('Record-File-Path') || evt.getHeader('variable_record_file_path');
    const confName = evt.getHeader('variable_conference_name') || evt.getHeader('Conference-Name');
    console.log(`[esl] RECORD_STOP — path="${recPath}" conf="${confName}"`);
    if (recPath) {
      const recType = recPath.includes('/ers/')    ? 'ERS'
                    : recPath.includes('/ens/')    ? 'ENS'
                    : recPath.includes('/ivr/')    ? 'IVR'
                    : recPath.includes('/manual/') ? 'MANUAL'
                    : 'ERS';
      import('../controllers/recordingController.js').then(({ upsertRecordingStart, closeRecording }) => {
        upsertRecordingStart({ type: recType, confName: confName || null, recPath, createdBy: 'system' })
          .then(row => {
            // closeRecording via the stop-recording ESL event handles ESL conference recordings.
            // For Lua record_session we call it here since no stop-recording event fires for them.
            closeRecording({ confName: confName || null, recPath });
          })
          .catch(err => console.error('[esl] RECORD_STOP registration failed:', err.message));
      }).catch(() => {});
    }
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
// trackParticipant — called from add-member / del-member ESL events.
//
// WHY destNum-first resolution:
//   For ring-all originated legs, FreeSWITCH sets Caller-Caller-ID-Number to the
//   INITIATOR's number (via origination_caller_id_number, so the responder's phone
//   shows the right caller). The responder's actual extension is in
//   Caller-Destination-Number. If we only use callerNum we always find the initiator,
//   see their pre-existing participant row, and silently skip the write — leaving
//   ers_incident_participants with 1 row (initiator) and ers_incident_responders empty.
//
//   Fix: try destNum first. It correctly identifies the responder for originated legs.
//   If destNum is empty or doesn't match a contact (e.g. the initiator's inbound join
//   where destNum = the ERS number, which lives in emergency_numbers not emergency_contacts),
//   fall back to callerNum (which IS the initiator's own number for inbound joins).
async function trackParticipant(confName, callerNum, destNum, event, memberId) {
  if (!confName || (!callerNum && !destNum)) return;
  try {
    const { rows: [incident] } = await query(
      `SELECT id FROM ers_incidents
       WHERE conference_room = $1 AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [confName]
    );
    if (!incident) return; // not an ERS room

    // Phase 1: try to resolve the contact from Caller-Destination-Number (responder's extension).
    let contact     = null;
    let trackingNum = callerNum; // default: use presented CallerID

    if (destNum) {
      const lastD9 = String(destNum).replace(/\D/g, '').slice(-9);
      const { rows: [destContact] } = await query(
        `SELECT id, first_name, last_name FROM emergency_contacts
         WHERE deleted_at IS NULL
           AND (extension_number = $1
                OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
         LIMIT 1`,
        [destNum, lastD9]
      );
      if (destContact) {
        contact     = destContact;
        trackingNum = destNum;

        // Fix the in-memory conference registry so the monitoring page shows the
        // responder's actual name instead of "Outbound Call" / the initiator's CallerID.
        if (memberId && event === 'join') {
          const conf = conferenceRegistry.get(confName);
          if (conf?.members.has(memberId)) {
            const m = conf.members.get(memberId);
            const resolvedName = `${destContact.first_name || ''} ${destContact.last_name || ''}`.trim() || destNum;
            m.callerNum   = destNum;
            m.callerName  = resolvedName;
            m.displayName = resolvedName;
            m.extension   = destNum;
          }
        }
      }
    }

    // Phase 2: if destNum didn't resolve a contact, try callerNum (initiator's inbound join).
    if (!contact && callerNum) {
      const last9 = String(callerNum).replace(/\D/g, '').slice(-9);
      const { rows: [callerContact] } = await query(
        `SELECT id, first_name, last_name FROM emergency_contacts
         WHERE deleted_at IS NULL
           AND (extension_number = $1
                OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
         LIMIT 1`,
        [callerNum, last9]
      );
      if (callerContact) {
        contact     = callerContact;
        trackingNum = callerNum;
      }
    }

    if (!trackingNum) return;

    if (event === 'join') {
      const { rows: [existing] } = await query(
        `SELECT id, left_at, role FROM ers_incident_participants
         WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3)
         ORDER BY joined_at DESC LIMIT 1`,
        [incident.id, trackingNum, contact?.id ?? null]
      );

      if (existing && existing.left_at) {
        // Same person coming back — rejoin, not a new participant.
        await query(
          `UPDATE ers_incident_participants
           SET rejoined_at = now(), left_at = NULL WHERE id = $1`,
          [existing.id]
        );
        if (contact?.id && existing.role !== 'initiator') {
          await query(
            `UPDATE ers_incident_responders
             SET status = 'REJOINED', rejoin_count = rejoin_count + 1, join_time = now()
             WHERE ers_incident_id = $1 AND mobile_number = $2`,
            [incident.id, trackingNum]
          ).catch(() => {});
        }
      } else if (!existing) {
        await query(
          `INSERT INTO ers_incident_participants (incident_id, contact_id, raw_number, role, joined_at)
           VALUES ($1, $2, $3, 'responder', now())`,
          [incident.id, contact?.id ?? null, trackingNum]
        );
        if (contact?.id) {
          await query(
            `INSERT INTO ers_incident_responders
               (ers_incident_id, emergency_contact_id, mobile_number, status, join_time)
             VALUES ($1, $2, $3, 'JOINED', now())
             ON CONFLICT (ers_incident_id, mobile_number) DO UPDATE SET
               status               = CASE WHEN ers_incident_responders.status = 'INVITED'
                                           THEN 'JOINED'
                                           ELSE ers_incident_responders.status END,
               join_time            = COALESCE(ers_incident_responders.join_time, now()),
               emergency_contact_id = EXCLUDED.emergency_contact_id`,
            [incident.id, contact.id, trackingNum]
          ).catch(err => console.warn('[esl] trackParticipant: responder upsert failed:', err.message));
        }
      }
      // else: existing with left_at=NULL — same person already counted, no action.

    } else if (event === 'leave') {
      await query(
        `UPDATE ers_incident_participants
         SET left_at = now()
         WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3) AND left_at IS NULL`,
        [incident.id, trackingNum, contact?.id ?? null]
      );
      await query(
        `UPDATE ers_incident_responders
         SET leave_time = now()
         WHERE ers_incident_id = $1 AND mobile_number = $2 AND leave_time IS NULL`,
        [incident.id, trackingNum]
      ).catch(() => {});
    }
  } catch (err) {
    // Never let audit tracking break live call event handling.
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

      // Subscribe to events we care about.
      // DTMF: digit events for PIN / IVR navigation
      // CHANNEL_CREATE / CHANNEL_BRIDGE: call lifecycle for monitoring
      conn.subscribe([
        'CUSTOM conference::maintenance',
        'CHANNEL_HANGUP',
        'CHANNEL_ANSWER',
        'CHANNEL_CREATE',
        'CHANNEL_BRIDGE',
        'DTMF',
        'RECORD_STOP',
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

export async function confModerator(confName, memberId) {
  return eslCommand(`conference ${confName} moderator ${memberId}`);
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

// ─── Canonical xml_list parser ───────────────────────────────────────────────
//
// THIS IS THE SINGLE SOURCE OF TRUTH for member state.
// Both seedConferenceRegistry and syncConferenceFromXml use these functions.
// The text-list parser (parseMemberFlags / parseConferenceListAll) is kept
// only for debugConfSync diagnostics — it must NEVER write to the registry.
//
// FreeSWITCH xml_list uses explicit boolean tags with no inference:
//   <can_speak>true</can_speak>  → NOT muted
//   <can_speak>false</can_speak> → muted
//   <can_hear>true</can_hear>    → NOT deaf
//   <talking>true</talking>      → currently speaking (energy > threshold)
//   <is_moderator>true</is_moderator>
//   <has_floor>true</has_floor>
//
// `conference xml_list` (no arg) → all conferences
// `conference <name> xml_list`   → one conference
// Both produce the same XML structure inside <conferences>.

function xmlBool(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return m ? m[1].trim() === 'true' : null;
}

function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

// Parse a single <member type="caller"> XML block.
// Returns a normalized member object or null if <id> is missing.
// Logs every field that maps to muted/talking so bugs are visible in pm2 logs.
function parseMemberXml(mxml, confName) {
  const id = xmlText(mxml, 'id');
  if (!id) return null;

  const flagsM   = /<flags>([\s\S]*?)<\/flags>/i.exec(mxml);
  const flagsXml = flagsM ? flagsM[1] : '';

  const rawCanSpeak  = xmlBool(flagsXml, 'can_speak');
  const rawCanHear   = xmlBool(flagsXml, 'can_hear');
  const rawTalking   = xmlBool(flagsXml, 'talking');
  const rawModerator = xmlBool(flagsXml, 'is_moderator');
  const rawFloor     = xmlBool(flagsXml, 'has_floor');

  const muted   = rawCanSpeak  === null ? false : !rawCanSpeak;
  const deaf    = rawCanHear   === null ? false : !rawCanHear;
  const talking = rawTalking   ?? false;

  const callerName = xmlText(mxml, 'caller_id_name')   || '';
  const callerNum  = xmlText(mxml, 'caller_id_number') || '';
  const uuid       = xmlText(mxml, 'uuid')             || '';

  console.log(
    `[esl] parseMemberXml: conf="${confName}" id=${id} num=${callerNum}` +
    ` | raw can_speak=${rawCanSpeak} → muted=${muted}` +
    ` | raw talking=${rawTalking} → talking=${talking}` +
    ` | raw is_moderator=${rawModerator} raw has_floor=${rawFloor}`
  );

  return {
    id,
    _uuid:      uuid,
    callerName,
    callerNum,
    displayName: (callerName && callerName !== callerNum && !/^\+?\d+$/.test(callerName))
      ? callerName : (callerNum || `Member #${id}`),
    canSpeak:   rawCanSpeak  ?? true,
    canHear:    rawCanHear   ?? true,
    muted,
    deaf,
    talking,
    floor:      rawFloor     ?? false,
    moderator:  rawModerator ?? false,
    energy:     parseInt(xmlText(mxml, 'energy')    || '0', 10) || 0,
    volIn:      parseInt(xmlText(mxml, 'volume_in') || '0', 10) || 0,
    volOut:     parseInt(xmlText(mxml, 'volume_out')|| '0', 10) || 0,
    joinedAt:   null,   // not available in xml_list; preserved from ESL add-member event
  };
}

// Parse full xml_list output (from `conference xml_list` or `conference <n> xml_list`).
// Strips the optional "+OK " bgapi prefix. Returns an array of conference objects,
// each with { name, locked, rate, members[] }. Returns [] on error or empty.
export function parseAllConferencesXmlList(xml, label = 'xml_list') {
  if (!xml) return [];
  // Strip the "+OK " prefix that bgapi prepends to the XML body
  const t = xml.replace(/^\+OK\s*/i, '').trim();

  if (t.startsWith('-ERR') || t.startsWith('-USAGE')) {
    console.warn(`[esl] ${label}: FreeSWITCH returned error — ${t.slice(0, 120)}`);
    return [];
  }
  if (!t.includes('<conference')) {
    // No active conferences — not an error
    console.log(`[esl] ${label}: no <conference> elements in response`);
    return [];
  }

  // Log the raw XML so we can see exactly what FreeSWITCH returned
  console.log(`[esl] ${label}: raw XML (first 2000 chars):\n${t.slice(0, 2000)}`);

  const results = [];
  for (const confMatch of t.matchAll(/<conference\s+([^>]+?)>([\s\S]*?)<\/conference>/gi)) {
    const hdrAttrs = confMatch[1];
    const confBody = confMatch[2];

    const nameM = /\bname="([^"]+)"/.exec(hdrAttrs);
    if (!nameM) continue;
    const confName = nameM[1];
    const locked   = /\blocked="true"/i.test(hdrAttrs);
    const rateM    = /\brate="(\d+)"/i.exec(hdrAttrs);
    const rate     = rateM ? parseInt(rateM[1], 10) : null;
    // FreeSWITCH may include flags="running|answered|dynamic" as a conference attribute
    const flagsAttrM = /\bflags="([^"]*)"/.exec(hdrAttrs);
    const rawFlags   = flagsAttrM ? flagsAttrM[1] : null;

    console.log(`[esl] ${label}: conference="${confName}" locked=${locked} rate=${rate} flags="${rawFlags}"`);

    const members = [];
    for (const memMatch of confBody.matchAll(/<member\s+type="caller">([\s\S]*?)<\/member>/gi)) {
      const m = parseMemberXml(memMatch[1], confName);
      if (m) members.push(m);
    }

    console.log(`[esl] ${label}: conference="${confName}" parsed ${members.length} member(s)`);
    results.push({ name: confName, locked, rate, rawFlags, members });
  }

  return results;
}

// Parse xml_list for a single conference (returns first result or null).
export function parseConferenceXmlList(xml) {
  const all = parseAllConferencesXmlList(xml, 'parseConferenceXmlList');
  return all.length > 0 ? all[0] : null;
}

// Enumerate active conferences and return authoritative per-member state.
//
// Uses TWO confirmed-working FreeSWITCH commands in sequence:
//   1. `conference list`        — text output, parsed for conference NAMES ONLY
//   2. `conference <n> xml_list` — XML output, parsed for member state (one call per conf)
//
// `conference xml_list` (no room arg) is intentionally avoided: it is not
// present in all FreeSWITCH versions, and if rejected with -ERR the seed
// would interpret the empty result as "no active conferences" and delete the
// entire registry — a catastrophic regression. The two-step approach adds one
// ESL round-trip per active conference but eliminates all version uncertainty.
async function confXmlListAll() {
  // Step 1 — get conference names from text list (confirmed working on this FS build)
  let namesRaw = '';
  try {
    namesRaw = await eslCommandTimeout('conference list', 8000);
  } catch (err) {
    console.error(`[esl] confXmlListAll: conference list failed — ${err.message}`);
    return [];
  }

  if (!namesRaw) return [];

  if (
    /no active conference/i.test(namesRaw) ||
    /no conference/i.test(namesRaw)        ||
    /^\+OK\s*$/.test(namesRaw.trim())
  ) {
    console.log('[esl] confXmlListAll: conference list reports no active conferences');
    return [];
  }

  // Parse conference names from header lines only — never parse member lines here.
  // Header format (either form seen in the wild):
  //   "+OK Conference 3010 (2 members rate: 8000 flags: dynamic)"
  //   "Conference 3010 (2 members rate: 8000 flags: dynamic)"
  const names = new Set();
  for (const line of namesRaw.split('\n')) {
    const m = /^(?:\+OK\s+)?[Cc]onference\s+(\S+)\s+\(/.exec(line.trim());
    if (m) names.add(m[1]);
  }

  if (names.size === 0) {
    // Unexpected format — log and return empty so we don't corrupt registry
    console.warn('[esl] confXmlListAll: could not extract conference names from list output:\n' + namesRaw.slice(0, 500));
    return [];
  }

  console.log(`[esl] confXmlListAll: found ${names.size} conference(s) — ${[...names].join(', ')}`);

  // Step 2 — per-conference xml_list for authoritative member state
  const results = [];
  for (const name of names) {
    const data = await confXmlList(name);   // raw XML is logged inside confXmlList
    if (data) {
      // confXmlList returns the object from parseConferenceXmlList which already
      // has { name, locked, rate, rawFlags, members } — use it directly
      results.push(data);
    } else {
      console.warn(`[esl] confXmlListAll: xml_list returned null for conf="${name}" — conference may have ended`);
    }
  }

  return results;
}

// Execute `conference <confName> xml_list` and return parsed result, or null on error.
export async function confXmlList(confName) {
  if (!confName) return null;
  try {
    const raw = await eslCommandTimeout(`conference ${confName} xml_list`, 5000);
    console.log(`[esl] confXmlList: raw XML for conf="${confName}" (first 1000 chars):\n${String(raw || '').slice(0, 1000)}`);
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
//
// Does NOT update talking — talking state is event-driven (start-talking /
// stop-talking ESL events) and must not be overwritten by a point-in-time
// xml_list snapshot that will almost always show talking=false.
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

    const mutedChanged = e.muted !== m.muted;
    const deafChanged  = e.deaf  !== m.deaf;
    const floorChanged = e.floor !== m.floor;

    // Apply authoritative xml_list state.
    // talking is intentionally excluded — it is a point-in-time snapshot
    // that would overwrite the event-driven state from start/stop-talking.
    e.muted     = m.muted;
    e.deaf      = m.deaf;
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

  // 2-minute recording scan — heals recordings whose stop-recording event was
  // missed (ESL disconnect during call) and registers any file the start-recording
  // event failed to insert. The scan is idempotent and O(filesystem), not O(DB).
  setInterval(() => {
    import('../controllers/recordingController.js').then(({ scanRecordingDirectory }) => {
      scanRecordingDirectory().catch(err =>
        console.warn('[recordings] periodic scan failed:', err.message)
      );
    }).catch(() => {});
  }, 120_000);
}
