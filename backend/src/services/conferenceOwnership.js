// ── Which tenant owns a live conference room? ─────────────────────────────────
//
// SIPCommunication conferences carry no tenant; the link is the ERS incident that
// uses the room. Rooms are reused per ERS configuration (ers_<cfg>_p/_s), so the most
// recent incident of ANY status decides — a conference that outlives its incident
// (ended in the database, members still connected) stays with its tenant.
// A room no incident has ever used has no owner: only SUPER_ADMIN may see or
// control it. Callers must treat a missing entry that way (fail closed).

import { query } from '../db/pool.js';

/** @returns Map<roomName, tenantId|null> — rooms with no incident are absent. */
export async function findConferenceOwners(rooms) {
  const owners = new Map();
  if (!rooms?.length) return owners;
  const { rows } = await query(
    `SELECT DISTINCT ON (i.conference_room)
            i.conference_room, COALESCE(i.tenant_id, e.tenant_id) AS tenant_id
       FROM ers_incidents i
       JOIN ers_configurations e ON e.id = i.ers_configuration_id
      WHERE i.conference_room = ANY($1) AND i.deleted_at IS NULL
      ORDER BY i.conference_room, i.started_at DESC`,
    [rooms]
  );
  for (const r of rows) owners.set(r.conference_room, r.tenant_id ?? null);
  return owners;
}

/** True when a caller scoped to tenantId (null = SUPER_ADMIN, all) may use the room. */
export function canAccessConference(owners, room, tenantId) {
  if (tenantId == null) return true;
  return owners.has(room) && Number(owners.get(room)) === Number(tenantId);
}
