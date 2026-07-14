/**
 * Conference Operations Center — Monitoring Controller
 *
 * All conference data comes from the in-memory ESL registry (real-time).
 * DB is used only for enrichment (ERS incident info, org names).
 */

import fs from 'fs';
import path from 'path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import { fsPathService } from '../services/freeSwitchPathService.js';
import {
  getConferenceSnapshot, seedConferenceRegistry,
  confKick, confMute, confUnmute, confDeaf, confUndeaf,
  confVolumeIn, confVolumeOut, confEnergy, confFloor,
  confTransfer, confLock, confUnlock,
  confRecord, confRecordPause, confRecordStop, confRecordStopAll,
  confPlay, confSay, confInvite, confTerminate,
  setConferenceRecordingStarting, setConferenceRecordingPath, setConferenceRecordingError,
  eslStatus,
} from '../services/eslService.js';

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
});

export const unlockConference = asyncHandler(async (req, res) => {
  await confUnlock(req.params.room);
  res.json({ ok: true });
});

export const startRecording = asyncHandler(async (req, res) => {
  const room = req.params.room;

  // Guard: reject duplicate recording starts. FreeSWITCH allows multiple concurrent
  // recordings per conference, which makes norecord-by-path unreliable because the
  // backend only tracks one path. Prevent the second command entirely.
  const existingSnap = getConferenceSnapshot().find(c => c.name === room);
  if (existingSnap && existingSnap.recordingState !== 'OFF' && existingSnap.recordingState !== 'FAILED') {
    return res.status(409).json({
      error: `Recording already ${existingSnap.recordingState.toLowerCase()} for conference "${room}"`,
      recordingState: existingSnap.recordingState,
    });
  }

  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const recDir  = fsPathService.getConfRecordingDir();
  // path.posix.join ensures forward-slash separators on all platforms —
  // the path is sent to FreeSWITCH (Linux), not the local OS.
  const recPath = req.body?.path || path.posix.join(recDir, `conf_${room}_${ts}.wav`);

  // Create the directory on the backend host. In a shared-volume Docker setup
  // this also creates it on the FreeSWITCH side; in other configs FreeSWITCH
  // must already have write access to its own recording directory.
  try {
    fs.mkdirSync(recDir, { recursive: true });
  } catch (mkdirErr) {
    console.error(`[monitoring] startRecording: cannot create recording dir "${recDir}": ${mkdirErr.message}`);
    return res.status(500).json({ error: `Recording directory unavailable: ${mkdirErr.message}` });
  }

  let result;
  try {
    result = await confRecord(room, recPath);
  } catch (eslErr) {
    const reason = eslErr.message || String(eslErr);
    console.error(`[monitoring] startRecording ESL error for conf="${room}" path="${recPath}": ${reason}`);
    setConferenceRecordingError(room, reason);
    return res.status(502).json({ error: `FreeSWITCH recording failed: ${reason}` });
  }

  if (typeof result === 'string' && result.trimStart().startsWith('-ERR')) {
    const reason = result.trim();
    console.error(`[monitoring] startRecording FreeSWITCH rejected conf="${room}" path="${recPath}": ${reason}`);
    setConferenceRecordingError(room, reason);
    return res.status(502).json({ error: `FreeSWITCH rejected recording: ${reason}` });
  }

  console.log(`[monitoring] startRecording OK conf="${room}" path="${recPath}" fs_response="${String(result).trim()}"`);
  // Set STARTING state — transitions to ACTIVE only when the start-recording ESL event
  // confirms FreeSWITCH opened the file. A 5 s timeout sets FAILED if no event arrives.
  setConferenceRecordingStarting(room, recPath);
  res.json({ ok: true, recordingPath: recPath });
});

export const pauseRecording = asyncHandler(async (req, res) => {
  const room = req.params.room;
  const snap = getConferenceSnapshot().find(c => c.name === room);
  const recPath = req.body?.path || snap?.recordingPath;
  if (!recPath) return res.status(400).json({ error: 'No active recording path known for this conference' });

  let result;
  try {
    result = await confRecordPause(room, recPath);
  } catch (eslErr) {
    const reason = eslErr.message || String(eslErr);
    console.error(`[monitoring] pauseRecording ESL error for conf="${room}": ${reason}`);
    return res.status(502).json({ error: `FreeSWITCH pause failed: ${reason}` });
  }

  if (typeof result === 'string' && result.trimStart().startsWith('-ERR')) {
    const reason = result.trim();
    console.error(`[monitoring] pauseRecording FreeSWITCH rejected conf="${room}": ${reason}`);
    return res.status(502).json({ error: `FreeSWITCH rejected pause: ${reason}` });
  }

  res.json({ ok: true });
});

export const stopRecording = asyncHandler(async (req, res) => {
  const room = req.params.room;
  const snap = getConferenceSnapshot().find(c => c.name === room);
  const recPath = req.body?.path || snap?.recordingPath;
  if (!recPath) return res.status(400).json({ error: 'No active recording path known for this conference' });

  let result;
  try {
    result = await confRecordStop(room, recPath);
  } catch (eslErr) {
    const reason = eslErr.message || String(eslErr);
    console.error(`[monitoring] stopRecording ESL error for conf="${room}": ${reason}`);
    return res.status(502).json({ error: `FreeSWITCH stop failed: ${reason}` });
  }

  if (typeof result === 'string' && result.trimStart().startsWith('-ERR')) {
    const errBody = result.trim().toLowerCase();
    if (errBody.includes('non-existent') || errBody.includes('no recording')) {
      // Path mismatch (e.g. backend restarted, or FreeSWITCH normalized the path).
      // Fall back to norecord all to stop every active recording in this room.
      console.warn(`[monitoring] stopRecording: path not found in FS, attempting norecord all — conf="${room}"`);
      try {
        await confRecordStopAll(room);
      } catch (allErr) {
        console.error(`[monitoring] stopRecording norecord all failed: ${allErr.message}`);
      }
    } else {
      const reason = result.trim();
      console.error(`[monitoring] stopRecording FreeSWITCH rejected conf="${room}": ${reason}`);
      return res.status(502).json({ error: `FreeSWITCH rejected stop: ${reason}` });
    }
  }

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
});

export const unmuteMember = asyncHandler(async (req, res) => {
  await confUnmute(req.params.room, req.params.memberId);
  res.json({ ok: true });
});

export const kickMember = asyncHandler(async (req, res) => {
  await confKick(req.params.room, req.params.memberId);
  res.json({ ok: true });
});

export const deafMember = asyncHandler(async (req, res) => {
  await confDeaf(req.params.room, req.params.memberId);
  res.json({ ok: true });
});

export const undeafMember = asyncHandler(async (req, res) => {
  await confUndeaf(req.params.room, req.params.memberId);
  res.json({ ok: true });
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
});

export const setEnergy = asyncHandler(async (req, res) => {
  const { level } = req.body;
  if (level == null) return res.status(400).json({ error: 'level required' });
  await confEnergy(req.params.room, req.params.memberId, level);
  res.json({ ok: true });
});

export const setFloor = asyncHandler(async (req, res) => {
  await confFloor(req.params.room, req.params.memberId);
  res.json({ ok: true });
});

export const transferMember = asyncHandler(async (req, res) => {
  const { extension, dialplan = 'XML', context = 'default' } = req.body;
  if (!extension) return res.status(400).json({ error: 'extension required' });
  await confTransfer(req.params.room, req.params.memberId, extension, dialplan, context);
  res.json({ ok: true });
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
