// ── Live-conference access and command-input rules ────────────────────────────
//
// Every /monitoring/conferences/:room route controls a live emergency call, so:
//  - the room must belong to the caller's tenant (404 otherwise — existence is not
//    revealed; a failed ownership lookup is an error, never "allowed");
//  - everything that reaches an ESL command is validated first. An ESL command is one
//    line of space-separated text, so a space or control character in a name would
//    change its meaning, and a newline would start a second command.

import { effectiveTenantId } from './tenantScope.js';
import { asyncHandler } from './asyncHandler.js';
import { query } from '../db/pool.js';
import { logger } from '../infrastructure/index.js';
import { findConferenceOwners, canAccessConference } from '../services/conferenceOwnership.js';

// A room name is one ESL argument: only whitespace and control characters could change the
// command. Any other character a room was named with before (e.g. "+9665…", "ers:1") works.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const ROOM_RE    = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const MEMBER_RE  = /^\d{1,10}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const TOKEN_RE   = /^[^\s\u0000-\u001f\u007f]{1,512}$/;   // one ESL argument: no spaces or control characters

const notFound = (res) => res.status(404).json({ error: 'Conference not found' });

export const requireConferenceAccess = asyncHandler(async (req, res, next) => {
  const room = req.params.room;
  if (!ROOM_RE.test(room)) return notFound(res);
  // SUPER_ADMIN (from the verified token) reaches every conference, including rooms with
  // no ERS incident, whichever tenant the UI is focused on. No lookup: platform control
  // must not depend on the database being reachable.
  if (req.user?.role === 'SUPER_ADMIN') return next();
  const tenantId = effectiveTenantId(req);
  if (!canAccessConference(await findConferenceOwners([room]), room, tenantId)) return notFound(res);
  return next();
});

// Every conference command leaves an audit record, written before the command runs so a
// crash cannot hide it. Holds room and action only: no spoken text or dial strings.
export const auditConferenceAction = asyncHandler(async (req, res, next) => {
  if (req.method === 'GET') return next();
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'conference_control', 'conference', $2, $3)`,
      [req.user?.id ?? null, req.params.room,
       JSON.stringify({ tenant_id: req.user?.tenantId ?? null, role: req.user?.role, method: req.method, command: req.path })]
    );
  } catch (err) {
    // An audit failure must not block an emergency action; it must be visible though.
    logger.error({ module: 'monitoring', room: req.params.room, err: err.message }, 'Conference action audit failed');
  }
  return next();
});

export function requireMemberId(req, res, next) {
  if (!MEMBER_RE.test(req.params.memberId)) return res.status(400).json({ error: 'memberId must be a number' });
  return next();
}

/** A single ESL argument (dial string, extension, file path). */
export const isEslToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);
/** Free text that stays on one line (TTS). */
export const isEslText = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1000 && !CONTROL_RE.test(v);
