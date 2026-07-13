/**
 * One-time cleanup: mark ers_incidents rows stuck at status='ACTIVE' with
 * no live matching FreeSWITCH conference as COMPLETED.
 *
 * Root cause (Phase 1 item 13): exec_ers() never called
 * POST /ers/incidents/:uuid/complete after the conference ended, so every
 * incident stayed ACTIVE forever regardless of whether anyone was still on
 * the call â€” this is what made Live Monitoring show 5 permanently "Active"
 * rooms with 0 members. That's now fixed in luaGenerator.js going forward,
 * plus an ESL conference-destroy listener in eslService.js catches any
 * future orphans from an unclean restart automatically. This script is
 * ONLY for cleaning up rows that already went stale before those fixes
 * were deployed.
 *
 * Usage:  node src/db/utils/cleanup_orphaned_ers_incidents.js [--apply]
 *   (no --apply) â€” dry run, lists what WOULD be marked COMPLETED
 *   --apply      â€” actually applies the update
 *
 * Requires ESL to be connected (reads live conference member counts) â€”
 * refuses to run without it rather than guessing.
 *
 * NOTE: do NOT import eslService directly â€” importing it used to start
 * background setInterval jobs which then fired after pool.end() and
 * caused "Cannot use a pool after calling end on the pool". ESL is
 * handled here via a minimal inline connection so the pool can be
 * cleanly closed without racing timers.
 */

import esl from 'modesl';
import { pool } from '../pool.js';
import { completeIncidentCore } from '../../controllers/internal/ersInternalController.js';
import { config } from '../../config/index.js';

const { Connection } = esl;
const APPLY = process.argv.includes('--apply');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectEsl(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const c = new Connection(
      config.esl.host,
      config.esl.port,
      config.esl.password,
      () => resolve(c)
    );
    c.on('error', () => {});
    setTimeout(() => resolve(null), timeoutMs);
  });
}

async function roomMemberCount(conn, room) {
  if (!room) return 0;
  return new Promise(resolve => {
    conn.bgapi(`conference ${room} count`, res => {
      const body  = res?.getBody?.() || '';
      if (!body || body.startsWith('-USAGE:') || body.startsWith('-ERR')) return resolve(0);
      const match = /^(\d+)/.exec(body.trim());
      resolve(match ? Number(match[1]) : 0);
    });
  });
}

async function main() {
  const conn = await connectEsl();
  if (!conn) {
    console.error('[cleanup] ESL not connected â€” refusing to guess. Start FreeSWITCH/ESL and re-run.');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, incident_uuid, conference_room, ers_configuration_id, started_at
     FROM ers_incidents
     WHERE status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at`
  );

  if (rows.length === 0) {
    console.log('[cleanup] No ACTIVE incidents found â€” nothing to do.');
    conn.end();
    await pool.end();
    return;
  }

  console.log(`[cleanup] ${rows.length} ACTIVE incident(s) found. Checking live conference state...\n`);

  const orphans = [];
  for (const r of rows) {
    const members = await roomMemberCount(conn, r.conference_room);
    const live = members > 0;
    console.log(`  ${r.incident_uuid}  room=${r.conference_room}  started=${r.started_at}  live_members=${live ? String(members) : '0/not found'}`);
    if (!live) orphans.push(r);
  }

  console.log(`\n[cleanup] ${orphans.length} of ${rows.length} are orphaned (no live members).`);

  if (orphans.length === 0 || !APPLY) {
    if (!APPLY && orphans.length > 0) {
      console.log('[cleanup] Dry run â€” re-run with --apply to mark these COMPLETED.');
    }
    conn.end();
    await pool.end();
    return;
  }

  for (const r of orphans) {
    await completeIncidentCore(r.incident_uuid, null);
    console.log(`  âœ“ marked COMPLETED: ${r.incident_uuid}`);
  }

  console.log(`\n[cleanup] Done â€” ${orphans.length} incident(s) marked COMPLETED.`);
  conn.end();
  await pool.end();
}

main().catch(err => {
  console.error('[cleanup] Failed:', err);
  process.exit(1);
});

