/**
 * ConferenceManager
 *
 * Single authoritative service for ERS conference provisioning.
 * All conference-type decisions, room naming, and auto-recording go here.
 * Controllers and ESL event handlers call this service; they never inline
 * conference-type logic themselves.
 *
 * Responsibilities
 * ─────────────────
 *  resolveConferenceRoom(config, slot)
 *    Returns the room name to use for an incident given the ERS configuration
 *    and slot number (1=primary, 2=secondary).
 *    STATIC → primary/secondary_bridge_number from config (or fallback)
 *    DYNAMIC → generates a unique room name that satisfies FreeSWITCH's
 *              conference naming rules (/^[a-z0-9_]{1,64}$/)
 *
 *  handleConferenceCreated(confName)
 *    Called from the ESL conference::maintenance `conference-create` event.
 *    Looks up the active ERS incident for this room, reads recording config,
 *    and starts recording automatically when:
 *      recording_enabled = true  AND
 *      recording_mode    = 'AUTO' AND
 *      recording_trigger = 'CONFERENCE_CREATED'
 *
 *  handleFirstParticipant(confName, memberCount)
 *    Called from the ESL `add-member` event when memberCount becomes 1.
 *    Same decision tree but for FIRST_PARTICIPANT trigger.
 *
 * These are the ONLY places where conference type and auto-recording decisions
 * are made. Controllers must not duplicate this logic.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { query } from '../db/pool.js';
import { fsPathService } from './freeSwitchPathService.js';

// ── Conference profile ────────────────────────────────────────────────────────

/**
 * Return a valid FreeSWITCH conference profile name from the ERS configuration.
 *
 * The `conference_profile` DB field is free-text. Admins sometimes mistakenly
 * store a SIP domain (e.g. "192.168.1.133") here. FreeSWITCH interprets
 * `conference(3010@192.168.1.133)` as a domain-scoped room and creates a
 * conference named "3010-192.168.1.133" instead of "3010".
 *
 * This function accepts only profile names that match the FS naming rules
 * (lowercase/uppercase letters, digits, hyphens, underscores — no dots, no
 * colons, no slashes). Anything that looks like an IP or FQDN falls back to
 * "default".
 *
 * IMPORTANT: every codepath that constructs a `conference(room@profile)` string
 * — backend originates, the ersLookup JSON that Lua reads — must call this
 * function rather than reading conference_profile raw from the DB.
 *
 * @param {object} config - ERS configuration row (or lookup response)
 * @returns {string}      - Validated FreeSWITCH conference profile name
 */
export function getConferenceProfile(config) {
  const raw = (config.conference_profile ?? '').trim();
  // Reject IPs (v4 and v6) and FQDNs (contain dots or colons).
  // Accept: letters, digits, hyphens, underscores — nothing else.
  return /^[a-z0-9_-]{1,64}$/i.test(raw) ? raw : 'default';
}

/**
 * Return the FreeSWITCH conference string "room@profile" for an incident slot.
 * This is the canonical string for use in `conference()` dialplan app and ESL.
 *
 * @param {object} config - ERS configuration row
 * @param {number} slot   - 1 = primary bridge, 2 = secondary bridge
 * @returns {string}      - e.g. "3010@default"
 */
export function getConferenceString(config, slot) {
  return `${resolveConferenceRoom(config, slot)}@${getConferenceProfile(config)}`;
}

// ── Room name generation ──────────────────────────────────────────────────────

/**
 * STATIC: use the bridge number configured on the ERS config, or the
 * deterministic fallback `ers_cfg{id}_{tier}`.  This mirrors exactly what
 * Lua's dial_911_conference.lua already computes from the lookup response —
 * the backend uses the same logic so both sides are always in agreement.
 *
 * DYNAMIC: generate a short, unique, lowercase-alphanumeric room name that
 * satisfies FreeSWITCH's conference name regex (/^[a-z0-9_]{1,64}$/).
 * The name encodes the config ID and slot so it's debuggable in FS logs.
 *
 * @param {object} config  - Row from ers_configurations (or lookup response)
 * @param {number} slot    - 1 for primary, 2 for secondary
 * @returns {string}       - Conference room name
 */
export function resolveConferenceRoom(config, slot) {
  const type = config.conference_type ?? 'STATIC';
  const tier = slot === 1 ? 'primary' : 'secondary';

  if (type === 'STATIC') {
    const bridgeNumber = slot === 1
      ? config.primary_bridge_number
      : config.secondary_bridge_number;
    return bridgeNumber
      ? String(bridgeNumber)
      : `ers_cfg${config.id ?? config.configuration_id}_${tier}`;
  }

  // DYNAMIC — encode configId + slot + last 7 hex digits of epoch seconds
  // Result example: ers1_p_6b1a2c3 (15 chars, always valid regex, debuggable)
  const cfgId = config.id ?? config.configuration_id;
  const slotChar = slot === 1 ? 'p' : 's';
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-7);
  return `ers${cfgId}_${slotChar}_${ts}`;
}

// ── Auto-recording ────────────────────────────────────────────────────────────

/**
 * Looks up the ERS configuration for a given conference room and starts
 * recording automatically if the config requires it for the given trigger.
 *
 * @param {string} confName   - FreeSWITCH conference name (room)
 * @param {string} trigger    - 'CONFERENCE_CREATED' | 'FIRST_PARTICIPANT'
 */
async function maybeAutoRecord(confName, trigger) {
  // Find the active ERS incident and its configuration for this room
  const { rows: [row] } = await query(
    `SELECT
       i.incident_uuid, i.tenant_id,
       ec.recording_enabled,
       ec.recording_mode,
       ec.recording_trigger,
       ec.recording_format,
       ec.recording_directory
     FROM ers_incidents i
     JOIN ers_configurations ec ON ec.id = i.ers_configuration_id
     WHERE i.conference_room = $1
       AND i.status          = 'ACTIVE'
       AND i.deleted_at      IS NULL
     ORDER BY i.started_at DESC
     LIMIT 1`,
    [confName]
  ).catch(() => ({ rows: [] }));

  if (!row) return; // Not an ERS-managed conference

  if (!row.recording_enabled) {
    console.log(`[conference-mgr] auto-record skipped: recording_enabled=false conf="${confName}"`);
    return;
  }

  if (row.recording_mode !== 'AUTO') {
    console.log(`[conference-mgr] auto-record skipped: recording_mode=${row.recording_mode} conf="${confName}"`);
    return;
  }

  if (row.recording_trigger !== trigger) {
    console.log(`[conference-mgr] auto-record skipped: trigger=${row.recording_trigger} (wanted ${trigger}) conf="${confName}"`);
    return;
  }

  await startAutoRecording(confName, row);
}

/**
 * Issues the ESL `conference record` command and registers the recording row.
 * Uses the path conventions from Recording Refactor (migration 026):
 *   recordings/ers/{confName}_{ts}.wav
 */
async function startAutoRecording(confName, config) {
  const ts      = Date.now();
  const format  = config.recording_format || 'wav';
  const recBase = config.recording_directory?.trim()
    ? config.recording_directory.trim()
    : fsPathService.getErsRecordingDir();

  const recPath = path.posix.join(recBase, `ers_${confName}_${ts}.${format}`);

  // Ensure the directory exists on the backend host. In a Docker shared-volume
  // setup the directory is on the shared filesystem; FreeSWITCH will see it.
  try {
    await fs.mkdir(recBase, { recursive: true });
  } catch (err) {
    console.error(`[conference-mgr] cannot create recording dir "${recBase}": ${err.message}`);
    return;
  }

  // Lazy-import confRecord to avoid a circular dependency with eslService.
  // eslService → conferenceManager is the only import direction at module load time.
  try {
    const { confRecord } = await import('./eslService.js');
    const result = await confRecord(confName, recPath);
    const resp   = String(result ?? '').trim();

    if (resp.startsWith('-ERR')) {
      console.error(`[conference-mgr] auto-record ESL error — conf="${confName}" resp="${resp}"`);
      return;
    }

    console.log(`[conference-mgr] auto-recording started — conf="${confName}" path="${recPath}" resp="${resp}"`);

    // The ESL start-recording event will register the row via upsertRecordingStart.
    // We don't insert here to avoid a race condition with the event handler.
  } catch (err) {
    console.error(`[conference-mgr] auto-record failed — conf="${confName}": ${err.message}`);
  }
}

// ── ESL event hooks ───────────────────────────────────────────────────────────

/**
 * Called by eslService when conference::maintenance `conference-create` fires.
 * Triggers auto-recording for CONFERENCE_CREATED mode.
 *
 * @param {string} confName
 */
export async function handleConferenceCreated(confName) {
  await maybeAutoRecord(confName, 'CONFERENCE_CREATED');
}

/**
 * Called by eslService after the first member joins (memberCount === 1).
 * Triggers auto-recording for FIRST_PARTICIPANT mode.
 *
 * @param {string} confName
 * @param {number} memberCount - current member count after this add-member event
 */
export async function handleFirstParticipant(confName, memberCount) {
  if (memberCount !== 1) return; // Only trigger on the very first member
  await maybeAutoRecord(confName, 'FIRST_PARTICIPANT');
}
