/**
 * Conference Operations Center — Monitoring Controller
 *
 * All conference data comes from the in-memory ESL registry (real-time).
 * DB is used only for enrichment (ERS incident info, org names).
 */

import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import {
  getConferenceSnapshot,
  confKick, confMute, confUnmute, confDeaf, confUndeaf,
  confVolumeIn, confVolumeOut, confEnergy, confFloor,
  confTransfer, confLock, confUnlock,
  confRecord, confRecordPause, confRecordStop,
  confPlay, confSay, confInvite, confTerminate,
  eslStatus,
} from '../services/eslService.js';

// ── GET /monitoring/conferences ───────────────────────────────────────────────
//
// Returns the full in-memory conference snapshot enriched with DB incident data.
// Members come entirely from ESL events — no DB participant query.

export const getConferences = asyncHandler(async (req, res) => {
  const snapshot = getConferenceSnapshot();

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
  const { path: recPath } = req.body;
  if (!recPath) return res.status(400).json({ error: 'path required' });
  await confRecord(req.params.room, recPath);
  res.json({ ok: true });
});

export const pauseRecording = asyncHandler(async (req, res) => {
  const { path: recPath } = req.body;
  if (!recPath) return res.status(400).json({ error: 'path required' });
  await confRecordPause(req.params.room, recPath);
  res.json({ ok: true });
});

export const stopRecording = asyncHandler(async (req, res) => {
  const { path: recPath } = req.body;
  if (!recPath) return res.status(400).json({ error: 'path required' });
  await confRecordStop(req.params.room, recPath);
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
