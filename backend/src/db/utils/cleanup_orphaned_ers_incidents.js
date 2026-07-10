/**
 * One-time cleanup: mark ers_incidents rows stuck at status='ACTIVE' with
 * no live matching FreeSWITCH conference as COMPLETED.
 *
 * Root cause (Phase 1 item 13): exec_ers() never called
 * POST /ers/incidents/:uuid/complete after the conference ended, so every
 * incident stayed ACTIVE forever regardless of whether anyone was still on
 * the call — this is what made Live Monitoring show 5 permanently "Active"
 * rooms with 0 members. That's now fixed in luaGenerator.js going forward,
 * plus an ESL conference-destroy listener in eslService.js catches any
 * future orphans from an unclean restart automatically. This script is
 * ONLY for cleaning up rows that already went stale before those fixes
 * were deployed.
 *
 * Usage:  node src/db/utils/cleanup_orphaned_ers_incidents.js [--apply]
 *   (no --apply) — dry run, lists what WOULD be marked COMPLETED
 *   --apply      — actually applies the update
 *
 * Requires ESL to be connected (reads live conference member counts) —
 * refuses to run without it rather than guessing.
 */

import { pool } from '../pool.js';
import { connect, eslCommand, eslStatus } from '../../services/eslService.js';
import { completeIncidentCore } from '../../controllers/internal/ersInternalController.js';

const APPLY = process.argv.includes('--apply');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForEsl(timeoutMs = 5000) {
  connect();
  const start = Date.now();
  while (!eslStatus().connected) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(200);
  }
  return true;
}

async function isRoomLive(room) {
  try {
    const res = await eslCommand(`conference ${room} list count`);
    // "0 total" or similar when the room exists but is empty; an error
    // string (e.g. "Conference X not found") when it doesn't exist at all.
    const match = /^(\d+)/.exec((res || '').trim());
    return match ? Number(match[1]) > 0 : false;
  } catch {
    return false;
  }
}

async function main() {
  const ok = await waitForEsl();
  if (!ok) {
    console.error('[cleanup] ESL not connected — refusing to guess. Start FreeSWITCH/ESL and re-run.');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, incident_uuid, conference_room, ers_configuration_id, started_at
     FROM ers_incidents
     WHERE status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at`
  );

  if (rows.length === 0) {
    console.log('[cleanup] No ACTIVE incidents found — nothing to do.');
    await pool.end();
    return;
  }

  console.log(`[cleanup] ${rows.length} ACTIVE incident(s) found. Checking live conference state...\n`);

  const orphans = [];
  for (const r of rows) {
    const live = await isRoomLive(r.conference_room);
    console.log(`  ${r.incident_uuid}  room=${r.conference_room}  started=${r.started_at}  live_members=${live ? '>0' : '0/not found'}`);
    if (!live) orphans.push(r);
  }

  console.log(`\n[cleanup] ${orphans.length} of ${rows.length} are orphaned (no live members).`);

  if (orphans.length === 0) {
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log('[cleanup] Dry run — re-run with --apply to mark these COMPLETED.');
    await pool.end();
    return;
  }

  for (const r of orphans) {
    await completeIncidentCore(r.incident_uuid, null);
    console.log(`  ✓ marked COMPLETED: ${r.incident_uuid}`);
  }

  console.log(`\n[cleanup] Done — ${orphans.length} incident(s) marked COMPLETED.`);
  await pool.end();
}

main().catch(err => {
  console.error('[cleanup] Failed:', err);
  process.exit(1);
});
