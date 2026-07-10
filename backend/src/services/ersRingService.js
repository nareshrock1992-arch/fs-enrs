/**
 * ERS Ring-All Service — Phase 5 scenario 1/2 core.
 *
 * Simultaneous dial-all of a tier's responders into one conference room:
 * one bgapi originate per leg (parallel, not sequential bridging),
 * continuous re-ring until any leg answers, conference recording started
 * on first responder join, caller-identity passthrough on every leg.
 *
 * Runs in the backend (not Lua) because it needs resolveDialString()
 * (Phase 4 — gateway-agnostic), the emergency_contacts directory for
 * caller identity, and a long-lived re-ring loop that must survive the
 * caller's own Lua session doing a blocking conference() the whole time.
 *
 * Occupancy rule (Phase 1 item 13 distinction): "any leg answered" and
 * "tier occupied" are ALWAYS judged by live conference member count via
 * ESL — never ers_incidents.status, which only means "some leg's
 * completion call ran."
 */

import { query } from '../db/pool.js';
import { eslCommand, getConferenceMemberCount } from './eslService.js';
import { resolveDialString } from './dialResolver.js';
import { emitInternal } from './socketService.js';

// Safety cap when ring_timeout_seconds is NULL (= "indefinite" per spec).
// This is a runaway-loop guard, not a user-facing limit: 2h of continuous
// re-ring with nobody answering means the emergency escalated some other
// way long ago.
const MAX_RING_MS   = 2 * 60 * 60 * 1000;
const RING_POLL_MS  = 3000;   // occupancy poll interval between re-ring waves
const LEG_TIMEOUT_S = 25;     // per-leg originate timeout before that wave's leg gives up

// One active ring loop per conference room — a rejoin/duplicate trigger
// for the same room must never spawn a second storm of originates.
const activeRings = new Map();

/**
 * Look up the initiator's directory identity by extension or ANI so every
 * responder's phone shows who actually triggered the emergency (spec:
 * high priority — security personnel must be able to call the person back).
 * Falls back to the raw number when no directory match.
 */
export async function lookupCallerIdentity(callerNumber) {
  const raw = String(callerNumber || '').trim();
  if (!raw) return { name: 'Emergency Caller', number: 'unknown' };

  const last9 = raw.replace(/\D/g, '').slice(-9);
  const { rows: [contact] } = await query(
    `SELECT first_name, last_name, extension_number, mobile_number
     FROM emergency_contacts
     WHERE deleted_at IS NULL AND is_active = true
       AND (extension_number = $1
            OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
     LIMIT 1`,
    [raw, last9]
  );

  if (contact) {
    return {
      name:   `${contact.first_name} ${contact.last_name}`.trim(),
      number: contact.extension_number || contact.mobile_number || raw,
    };
  }
  return { name: raw, number: raw };
}

/** Resolve a tier's responders with contact ids (for per-contact gateway overrides + participant rows). */
async function resolveTierResponders(configId, tier) {
  const { rows: contactRows } = await query(
    `SELECT DISTINCT ec.id, ec.first_name, ec.last_name, ec.mobile_number, ec.extension_number
     FROM emergency_contacts ec
     WHERE ec.deleted_at IS NULL AND ec.is_active = true
       AND (
         ec.id IN (
           SELECT contact_id FROM ers_tier_contacts
           WHERE ers_configuration_id = $1 AND tier = $2
         )
         OR ec.id IN (
           SELECT rgm.emergency_contact_id
           FROM responder_group_members rgm
           JOIN ers_tier_groups etg ON etg.group_id = rgm.responder_group_id
           WHERE etg.ers_configuration_id = $1 AND etg.tier = $2
         )
       )`,
    [configId, tier]
  );
  return contactRows;
}

async function originateLeg({ contact, room, tenantId, callerIdentity }) {
  const { dialString } = await resolveDialString({
    tenantId,
    contactId: contact.id,
  });

  const vars = [
    // Caller identity passthrough — the INITIATOR's real name/number on
    // every responder's phone, not the system's.
    `origination_caller_id_name='${callerIdentity.name.replace(/'/g, '')}'`,
    `origination_caller_id_number=${callerIdentity.number}`,
    `effective_caller_id_name='${callerIdentity.name.replace(/'/g, '')}'`,
    `effective_caller_id_number=${callerIdentity.number}`,
    'ignore_early_media=true',
    `originate_timeout=${LEG_TIMEOUT_S}`,
  ].join(',');

  // bgapi — fire and return immediately; all legs ring in parallel.
  return eslCommand(`bgapi originate {${vars}}${dialString} &conference(${room}@default)`);
}

/**
 * Start (or no-op into) the ring-all loop for an incident's room.
 * Returns immediately — the loop runs in the background until a responder
 * answers, the timeout hits, or the caller abandons (room empties).
 */
export function startRingAll({ incidentId, incidentUuid, configId, tier, room, tenantId, callerNumber, ringTimeoutSeconds }) {
  if (activeRings.has(room)) return { started: false, reason: 'ring loop already active for this room' };

  const controller = { stopped: false };
  activeRings.set(room, controller);

  (async () => {
    try {
      const callerIdentity = await lookupCallerIdentity(callerNumber);
      const responders = await resolveTierResponders(configId, tier);

      if (responders.length === 0) {
        console.warn(`[ers-ring] No responders resolved for config=${configId} tier=${tier} — nothing to ring`);
        return;
      }

      const deadline = Date.now() + Math.min(
        (ringTimeoutSeconds ? ringTimeoutSeconds * 1000 : MAX_RING_MS),
        MAX_RING_MS
      );

      let recordingStarted = false;
      let wave = 0;

      while (!controller.stopped && Date.now() < deadline) {
        // Caller abandoned before anyone answered → room destroyed/empty; stop.
        const members = await getConferenceMemberCount(room);
        if (wave > 0 && members === 0) break;

        // members > 1 means the caller plus at least one responder — answered.
        if (members > 1) {
          if (!recordingStarted) {
            recordingStarted = true;
            const { rows: [cfg] } = await query(
              `SELECT record_conferences, recording_directory FROM ers_configurations WHERE id = $1`,
              [configId]
            );
            if (cfg?.record_conferences) {
              const dir  = cfg.recording_directory || '/var/lib/freeswitch/recordings/ers';
              const path = `${dir}/${room}_${Date.now()}.wav`;
              await eslCommand(`conference ${room} record ${path}`).catch(() => {});
              await query(
                `UPDATE ers_incidents SET recording_path = $2 WHERE id = $1`,
                [incidentId, path]
              );
            }
          }
          break; // any leg answered → stop re-ringing everyone
        }

        wave++;
        console.log(`[ers-ring] wave ${wave} — ringing ${responders.length} responder(s) into ${room}`);
        for (const contact of responders) {
          if (controller.stopped) break;
          try {
            await originateLeg({ contact, room, tenantId, callerIdentity });
          } catch (err) {
            console.error(`[ers-ring] originate failed for contact ${contact.id}:`, err.message);
          }
        }

        // Wait out the leg timeout (+ small settle) before deciding to re-ring.
        const waveEnd = Date.now() + (LEG_TIMEOUT_S + 3) * 1000;
        while (!controller.stopped && Date.now() < waveEnd) {
          await new Promise(r => setTimeout(r, RING_POLL_MS));
          const m = await getConferenceMemberCount(room);
          if (m > 1 || m === 0) break; // answered, or caller abandoned
        }
      }

      emitInternal('enrs::ers_ring_ended', { incident_uuid: incidentUuid, room, tier });
    } catch (err) {
      console.error('[ers-ring] ring loop error:', err.message);
    } finally {
      activeRings.delete(room);
    }
  })();

  return { started: true };
}

export function stopRingAll(room) {
  const controller = activeRings.get(room);
  if (controller) controller.stopped = true;
}
