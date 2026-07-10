/**
 * Phase 5 C1's explicit test, verbatim from the spec: "multiple
 * responders join, one leaves (its own incident row correctly marks
 * COMPLETED), tier-status must still report the tier occupied because
 * the room still has live members."
 *
 * The live member count comes from ESL, which isn't available in the
 * test environment — mocked here at the eslService boundary, which is
 * exactly the point: this test pins the CONTRACT that tier-status asks
 * FreeSWITCH for live occupancy instead of trusting
 * ers_incidents.status, no matter what the DB rows say.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

process.env.INTERNAL_API_KEY = 'test-internal-key-32charmin';
process.env.NODE_ENV = 'test';

// Mock BEFORE importing anything that pulls in eslService.
const memberCounts = new Map();
vi.mock('../../services/eslService.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    getConferenceMemberCount: vi.fn(async room => memberCounts.get(room) ?? 0),
    eslCommand: vi.fn(async () => ''),
    connect: vi.fn(),
  };
});

const { default: server } = await import('../../../server.js');
const { query } = await import('../../db/pool.js');

const KEY = 'test-internal-key-32charmin';

let tenantId, orgId, configId, incidentId;
const ROOM = 'ers_tierstatus_test_room';

beforeAll(async () => {
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('TierStatusTenant', $1) RETURNING id`,
    [`tierstat-${Date.now()}`]
  );
  tenantId = t.id;
  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('TierStatusOrg', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.id;
  const { rows: [c] } = await query(
    `INSERT INTO ers_configurations (organization_id, tenant_id, name, is_active)
     VALUES ($1, $2, 'TierStatus ERS', true) RETURNING id`,
    [orgId, tenantId]
  );
  configId = c.id;
});

afterAll(async () => {
  await query(`DELETE FROM ers_incident_participants WHERE incident_id = $1`, [incidentId]).catch(() => {});
  await query(`DELETE FROM ers_incidents WHERE ers_configuration_id = $1`, [configId]);
  await query(`DELETE FROM ers_configurations WHERE id = $1`, [configId]);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

describe('Phase 5 C1 — tier-status judges occupancy by LIVE member count, never incident status', () => {
  it('setup: an incident whose row is marked COMPLETED but whose room still has live members', async () => {
    const { rows: [inc] } = await query(
      `INSERT INTO ers_incidents
         (incident_uuid, ers_configuration_id, status, caller_number, conference_room, group_type, started_at, ended_at)
       VALUES (gen_random_uuid(), $1, 'COMPLETED', '5551234567', $2, 'primary', now(), now())
       RETURNING id`,
      [configId, ROOM]
    );
    incidentId = inc.id;

    // The room still has 3 live members — e.g. the initiator + two
    // responders still bridged after ONE leg left and marked its own
    // incident row COMPLETED (the exact Phase 1 item 13 distinction).
    memberCounts.set(ROOM, 3);
    expect(incidentId).toBeTruthy();
  });

  it('reports the tier OCCUPIED despite status=COMPLETED, because the room has live members', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ers/tier-status?configuration_id=${configId}`)
      .set('X-Internal-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body.primary.occupied).toBe(true);
    expect(res.body.primary.live_members).toBe(3);
    expect(res.body.primary.incident_status).toBe('COMPLETED'); // the row says done — the room disagrees, room wins
  });

  it('reports the tier FREE once the room actually empties, regardless of any ACTIVE row', async () => {
    // Inverse direction: flip the row back to ACTIVE (a crash orphan) but
    // empty the real room — must report free.
    await query(`UPDATE ers_incidents SET status = 'ACTIVE', ended_at = NULL WHERE id = $1`, [incidentId]);
    memberCounts.set(ROOM, 0);

    const res = await request(server)
      .get(`/api/v1/internal/ers/tier-status?configuration_id=${configId}`)
      .set('X-Internal-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body.primary.occupied).toBe(false);
    expect(res.body.primary.live_members).toBe(0);
    expect(res.body.primary.incident_status).toBe('ACTIVE'); // row says live — room is empty, room wins
  });

  it('secondary tier with no incidents at all reports unoccupied', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ers/tier-status?configuration_id=${configId}`)
      .set('X-Internal-Key', KEY);
    expect(res.body.secondary.occupied).toBe(false);
    expect(res.body.secondary.incident_uuid).toBeNull();
  });
});
