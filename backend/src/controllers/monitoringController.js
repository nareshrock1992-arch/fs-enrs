/**
 * Conference Operations Center — Monitoring Controller
 *
 * All conference data comes from the in-memory ESL registry (real-time).
 * DB is used only for enrichment (ERS incident info, org names).
 */

import { promises as fsp } from 'fs';
import fs from 'fs';
import path from 'path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import { fsPathService } from '../services/freeSwitchPathService.js';
import {
  getConferenceSnapshot, seedConferenceRegistry,
  confKick, confMute, confUnmute, confDeaf, confUndeaf,
  confVolumeIn, confVolumeOut, confEnergy, confFloor,
  confTransfer, confLock, confUnlock, confModerator,
  confRecord, confRecordStop, confRecordStopAll,
  confPlay, confSay, confInvite, confTerminate,
  setConferenceRecordingStarting, setConferenceRecordingActive,
  setConferenceRecordingStopping,
  setConferenceRecordingPath, setConferenceRecordingError,
  eslStatus, syncConferenceFromXml,
} from '../services/eslService.js';

// Schedule a post-command xml_list verification 300 ms after the HTTP response.
// Runs conference xml_list, compares against the in-memory registry, and emits
// socket.io correction events for any field that differs from FreeSWITCH truth.
// Never blocks the HTTP response — fire-and-forget.
function scheduleSync(room, delayMs = 300) {
  setTimeout(() => {
    syncConferenceFromXml(room).catch(err =>
      console.error(`[monitoring] post-command sync failed — room="${room}": ${err.message}`)
    );
  }, delayMs);
}

// ── GET /monitoring/conferences ───────────────────────────────────────────────
//
// Returns the full in-memory conference snapshot enriched with DB incident data.
// Members come entirely from ESL events — no DB participant query.

export const getConferences = asyncHandler(async (req, res) => {
  let snapshot = getConferenceSnapshot();

  // If the registry is empty (e.g. backend restarted mid-call), seed from
  // FreeSWITCH immediately so the first page load isn't blank.
  if (snapshot.length === 0) {
    await seedConferenceRegistry();
    snapshot = getConferenceSnapshot();
  }

  const rooms = snapshot.map(c => c.name).filter(Boolean);
  let incidentMap = {};

  if (rooms.length > 0) {
    const { rows } = await query(
      `SELECT
         i.conference_room,
         i.incident_uuid,
         i.caller_number,
         i.group_type,
         i.started_at,
         i.recording_path,
         i.status AS incident_status,
         e.name AS ers_name,
         e.primary_bridge_number,
         e.secondary_bridge_number,
         e.conference_profile,
         o.name AS organization_name
       FROM ers_incidents i
       JOIN ers_configurations e ON e.id = i.ers_configuration_id
       LEFT JOIN organizations o ON o.id = e.organization_id
       WHERE i.status = 'ACTIVE'
         AND i.deleted_at IS NULL
         AND i.conference_room = ANY($1)`,
      [rooms]
    );
    for (const r of rows) incidentMap[r.conference_room] = r;
  }

  const conferences = snapshot.map(conf => ({
    ...conf,
    incident: incidentMap[conf.name] || null,
  }));

  res.json({ conferences, esl: eslStatus() });
});

// ── GET /monitoring/status ────────────────────────────────────────────────────

export const getStatus = asyncHandler(async (_req, res) => {
  res.json(eslStatus());
});

// ── Conference-level controls ─────────────────────────────────────────────────

export const lockConference = asyncHandler(async (req, res) => {
  await confLock(req.params.room);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const unlockConference = asyncHandler(async (req, res) => {
  await confUnlock(req.params.room);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

// ── Recording file verification ───────────────────────────────────────────────
//
// After issuing `conference record <path>` FreeSWITCH returns +OK immediately
// even if it cannot open the file for writing (wrong directory, bad permissions,
// Docker volume not shared). The start-recording ESL event ONLY fires when FS
// successfully opens the file. If the event never arrives we poll the filesystem
// directly as a backup confirmation path.
//
// Timeline:
//   t=0      → REST handler sends `conference record <path>` and sets STARTING
//   t=0..8s  → verifyRecordingCreated polls for file existence every 500ms
//   t≤8s     → if file appears: setConferenceRecordingActive (event was missed)
//   t=5s     → STARTING→FAILED timer in eslService fires (if event AND file absent)
//   t>5s     → state is FAILED; further polls are no-ops
//
// This covers:
//   • Same host   — file visible immediately after FS opens it
//   • Shared vol  — file visible once FS writes first PCM frames (~200ms)
//   • Wrong path  — file never appears; FAILED within 5s with actionable message
//
async function verifyRecordingCreated(room, recPath, recDir) {
  const POLL_INTERVAL_MS = 500;
  const MAX_POLLS        = 16; // 8 seconds total

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    // If the ESL event already transitioned state, our job is done.
    const snap = getConferenceSnapshot().find(c => c.name === room);
    if (!snap || snap.recordingState !== 'STARTING') return;

    try {
      const stat = await fsp.stat(recPath);
      // File exists — FreeSWITCH opened it. Confirm ACTIVE without the event.
      // (The event might still arrive and will be a no-op since state is already ACTIVE.)
      console.log(`[monitoring] verifyRecordingCreated: file confirmed at ${recPath} (${stat.size} bytes) after ${(i + 1) * POLL_INTERVAL_MS}ms`);
      setConferenceRecordingActive(room, recPath);
      return;
    } catch {
      // File not yet created — keep polling
    }
  }

  // Polling exhausted without seeing the file AND without the ESL event.
  // Provide a maximally actionable error message.
  const snap = getConferenceSnapshot().find(c => c.name === room);
  if (snap?.recordingState === 'STARTING') {
    const reason =
      `Recording file not created by FreeSWITCH after 8s. ` +
      `Path attempted: "${recPath}". ` +
      `Verify that: (1) FS_RECORDINGS_DIR env var points to a directory writable by FreeSWITCH, ` +
      `(2) in Docker the recording directory is on a shared volume mounted at the same path in both containers, ` +
      `(3) FreeSWITCH has write permission to "${recDir}".`;
    console.error(`[monitoring] verifyRecordingCreated: FAILED — ${reason}`);
    setConferenceRecordingError(room, reason);
  }
}

export const startRecording = asyncHandler(async (req, res) => {
  const room = req.params.room;

  // Guard: prevent duplicate recording starts.
  // STARTING, ACTIVE, and STOPPING are all "in-progress" — reject.
  // Only OFF and FAILED allow a new recording.
  const existingSnap = getConferenceSnapshot().find(c => c.name === room);
  const activeStates = ['STARTING', 'ACTIVE', 'STOPPING'];
  if (existingSnap && activeStates.includes(existingSnap.recordingState)) {
    console.warn(`[monitoring] startRecording: duplicate rejected — conf="${room}" state=${existingSnap.recordingState}`);
    return res.status(409).json({
      error: `Recording already ${existingSnap.recordingState.toLowerCase()} for conference "${room}"`,
      recordingState: existingSnap.recordingState,
    });
  }

  // Determine recording type: ERS when an active incident owns this conference;
  // MANUAL otherwise. Type drives directory and database ownership.
  const { rows: [activeIncident] } = await query(
    `SELECT incident_uuid FROM ers_incidents
     WHERE conference_room = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [room]
  ).catch(() => ({ rows: [] }));
  const recType = activeIncident ? 'ERS' : 'MANUAL';

  // Generate a clean recording path.
  // Use epoch ms (no colons/dots) for a filesystem-safe filename.
  const ts     = Date.now();
  const recDir = fsPathService.getRecordingDirForType(recType);
  const prefix = recType === 'ERS' ? `ers_${room}` : `conf_${room}`;
  const recPath = req.body?.path || path.posix.join(recDir, `${prefix}_${ts}.wav`);

  // Create the directory on the backend host.
  try {
    fs.mkdirSync(recDir, { recursive: true });
    console.log(`[monitoring] startRecording: recording dir ensured — "${recDir}" (type=${recType})`);
  } catch (mkdirErr) {
    console.error(`[monitoring] startRecording: cannot create recording dir "${recDir}": ${mkdirErr.message}`);
    return res.status(500).json({
      error: `Recording directory unavailable: ${mkdirErr.message}. Set FS_RECORDINGS_DIR to a path writable by both this process and FreeSWITCH.`,
    });
  }

  // Issue the ESL command and log everything.
  const eslCmd = `conference ${room} record ${recPath}`;
  const t0 = Date.now();
  let result;
  try {
    result = await confRecord(room, recPath);
  } catch (eslErr) {
    const reason = eslErr.message || String(eslErr);
    console.error(`[monitoring] startRecording ESL error — cmd="${eslCmd}" error="${reason}" elapsed=${Date.now() - t0}ms`);
    setConferenceRecordingError(room, reason);
    return res.status(502).json({ error: `FreeSWITCH ESL error: ${reason}` });
  }

  const responseText = String(result ?? '').trim();
  console.log(`[monitoring] startRecording — cmd="${eslCmd}" response="${responseText}" elapsed=${Date.now() - t0}ms`);

  if (responseText.startsWith('-ERR')) {
    console.error(`[monitoring] startRecording: FreeSWITCH rejected — conf="${room}" path="${recPath}" response="${responseText}"`);
    setConferenceRecordingError(room, responseText);
    return res.status(502).json({ error: `FreeSWITCH rejected recording: ${responseText}` });
  }

  // +OK received. FreeSWITCH accepted the command but the file may not yet exist.
  // Set STARTING state and begin file-existence verification in parallel.
  // The start-recording ESL event is the authoritative confirmation; file polling
  // is the fallback for environments where events are delayed or missed.
  setConferenceRecordingStarting(room, recPath);

  // Fire-and-forget — does not block the HTTP response.
  verifyRecordingCreated(room, recPath, recDir).catch(err =>
    console.error('[monitoring] verifyRecordingCreated unhandled error:', err.message)
  );

  res.json({ ok: true, recordingPath: recPath });
});

export const stopRecording = asyncHandler(async (req, res) => {
  const room = req.params.room;
  const snap = getConferenceSnapshot().find(c => c.name === room);
  const recPath = req.body?.path || snap?.recordingPath;

  if (!recPath) {
    return res.status(400).json({ error: 'No active recording path known for this conference' });
  }

  // Transition to STOPPING immediately so the UI shows "Stopping…" not "Active".
  setConferenceRecordingStopping(room);

  const eslCmd = `conference ${room} norecord ${recPath}`;
  const t0 = Date.now();
  let result;
  try {
    result = await confRecordStop(room, recPath);
  } catch (eslErr) {
    const reason = eslErr.message || String(eslErr);
    console.error(`[monitoring] stopRecording ESL error — cmd="${eslCmd}" error="${reason}" elapsed=${Date.now() - t0}ms`);
    return res.status(502).json({ error: `FreeSWITCH stop failed: ${reason}` });
  }

  const responseText = String(result ?? '').trim();
  console.log(`[monitoring] stopRecording — cmd="${eslCmd}" response="${responseText}" elapsed=${Date.now() - t0}ms`);

  if (responseText.startsWith('-ERR')) {
    const errLower = responseText.toLowerCase();
    if (errLower.includes('non-existent') || errLower.includes('no recording') || errLower.includes('not found')) {
      // FreeSWITCH doesn't know about this path. Two scenarios:
      //   A) Recording never started (file wasn't created) — try norecord all as cleanup.
      //   B) Path was normalized by FS (symlink, relative vs absolute) — norecord all catches it.
      console.warn(`[monitoring] stopRecording: path "${recPath}" not in FS recording table — falling back to norecord all`);
      try {
        const allResult = await confRecordStopAll(room);
        console.log(`[monitoring] stopRecording norecord all — response="${String(allResult).trim()}"`);
      } catch (allErr) {
        console.error(`[monitoring] stopRecording norecord all failed: ${allErr.message}`);
      }
      // Transition to OFF regardless — the recording either wasn't running or is now stopped.
      setConferenceRecordingPath(room, null);
      return res.json({ ok: true, warning: `Recording path not found in FreeSWITCH (may not have started). State reset to OFF.` });
    }
    return res.status(502).json({ error: `FreeSWITCH rejected stop: ${responseText}` });
  }

  // norecord succeeded. The stop-recording ESL event will arrive shortly and
  // transition state to OFF via the eslService event handler. We also clear the
  // path here as an immediate local update.
  setConferenceRecordingPath(room, null);
  res.json({ ok: true });
});

export const playAudio = asyncHandler(async (req, res) => {
  const { audio_path } = req.body;
  if (!audio_path) return res.status(400).json({ error: 'audio_path required' });
  await confPlay(req.params.room, audio_path);
  res.json({ ok: true });
});

export const sayText = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  await confSay(req.params.room, text);
  res.json({ ok: true });
});

export const inviteParticipant = asyncHandler(async (req, res) => {
  const { dial_string } = req.body;
  if (!dial_string) return res.status(400).json({ error: 'dial_string required' });
  await confInvite(req.params.room, dial_string);
  res.json({ ok: true });
});

export const terminateConference = asyncHandler(async (req, res) => {
  await confTerminate(req.params.room);
  res.json({ ok: true });
});

// ── Participant-level controls ────────────────────────────────────────────────

export const muteMember = asyncHandler(async (req, res) => {
  await confMute(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const unmuteMember = asyncHandler(async (req, res) => {
  await confUnmute(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const kickMember = asyncHandler(async (req, res) => {
  await confKick(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const deafMember = asyncHandler(async (req, res) => {
  await confDeaf(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const undeafMember = asyncHandler(async (req, res) => {
  await confUndeaf(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const setVolume = asyncHandler(async (req, res) => {
  const { direction, level } = req.body;
  if (!direction || level == null) return res.status(400).json({ error: 'direction and level required' });
  if (direction === 'in') {
    await confVolumeIn(req.params.room, req.params.memberId, level);
  } else {
    await confVolumeOut(req.params.room, req.params.memberId, level);
  }
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const setEnergy = asyncHandler(async (req, res) => {
  const { level } = req.body;
  if (level == null) return res.status(400).json({ error: 'level required' });
  await confEnergy(req.params.room, req.params.memberId, level);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const setFloor = asyncHandler(async (req, res) => {
  await confFloor(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

export const transferMember = asyncHandler(async (req, res) => {
  const { extension, dialplan = 'XML', context = 'default' } = req.body;
  if (!extension) return res.status(400).json({ error: 'extension required' });
  await confTransfer(req.params.room, req.params.memberId, extension, dialplan, context);
  res.json({ ok: true });
});

export const promoteMember = asyncHandler(async (req, res) => {
  await confModerator(req.params.room, req.params.memberId);
  res.json({ ok: true });
  scheduleSync(req.params.room);
});

// ── GET /monitoring/debug/conf-sync ──────────────────────────────────────────
// Diagnostic: compare in-memory registry against live FreeSWITCH state.

export const debugConfSync = asyncHandler(async (_req, res) => {
  const esl = eslStatus();

  // Snapshot before seed
  const beforeSnapshot = getConferenceSnapshot();

  // Seed pulls live state from FreeSWITCH and returns the parsed list
  const liveConferences = await seedConferenceRegistry();

  // Snapshot after seed (reflects any conferences just discovered)
  const afterSnapshot = getConferenceSnapshot();

  const registryMap = Object.fromEntries(
    afterSnapshot.map(c => [c.name, { memberCount: c.members.length }])
  );
  const liveMap = Object.fromEntries(
    liveConferences.map(c => [c.name, { memberCount: c.members.length }])
  );

  const allNames = new Set([...Object.keys(registryMap), ...Object.keys(liveMap)]);
  const diff = [];
  for (const name of allNames) {
    const r = registryMap[name];
    const l = liveMap[name];
    if (!r) diff.push({ name, issue: 'in_freeswitch_not_in_registry', liveMembers: l.memberCount });
    else if (!l) diff.push({ name, issue: 'in_registry_not_in_freeswitch', registryMembers: r.memberCount });
    else if (r.memberCount !== l.memberCount) diff.push({ name, issue: 'member_count_mismatch', registry: r.memberCount, live: l.memberCount });
  }

  res.json({
    esl,
    registryBeforeSeed: beforeSnapshot.length,
    registryAfterSeed: afterSnapshot.length,
    conferenceRegistry: afterSnapshot.map(c => ({ name: c.name, memberCount: c.members.length })),
    freeSwitchConferences: liveConferences.map(c => ({ name: c.name, memberCount: c.members.length })),
    registryVsFreeSwitchMatch: diff.length === 0,
    diff,
  });
});
