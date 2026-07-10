/**
 * Phase 1 stabilization regression tests — one test per numbered item in
 * the debugging session's fix list, isolated from the other integration
 * suites (own tenant/org/user) so it can run standalone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import server from '../../../server.js';
import { query } from '../../db/pool.js';
import { completeIncidentCore } from '../../controllers/internal/ersInternalController.js';

let adminToken = '';
let tenantId   = null;
let orgId      = null;
let ersConfigId = null;
let ensConfigId = null;

beforeAll(async () => {
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('Phase1RegressionTenant', $1) RETURNING id`,
    [`p1reg-${Date.now()}`]
  );
  tenantId = t.id;

  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('Phase1RegressionOrg', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.id;

  const hash = await bcrypt.hash('Test1234!', 12);
  await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, full_name)
     VALUES ('p1reg-admin@test.local', $1, 'ADMIN', $2, 'Phase1 Admin')`,
    [hash, tenantId]
  );

  const loginRes = await request(server)
    .post('/api/v1/auth/login')
    .send({ email: 'p1reg-admin@test.local', password: 'Test1234!' });
  adminToken = loginRes.body.token;
});

afterAll(async () => {
  if (ersConfigId) await query(`DELETE FROM ers_configurations WHERE id = $1`, [ersConfigId]);
  if (ensConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [ensConfigId]);
  await query(`DELETE FROM users WHERE email = 'p1reg-admin@test.local'`);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

// Item 6 — createConfiguration()/updateConfiguration() must set tenant_id,
// derived from the authenticated user (never left NULL, which previously
// caused "not found or wrong tenant" publish failures on every newly
// created ERS/ENS configuration).

describe('Phase 1 item 6 — ERS configuration tenant_id is set on create', () => {
  it('POST /ers/configurations sets tenant_id to the creating user\'s tenant', async () => {
    const res = await request(server)
      .post('/api/v1/ers/configurations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ organization_id: orgId, name: 'Phase1 ERS Config' });
    expect(res.status).toBe(201);
    ersConfigId = res.body.id;

    const { rows: [row] } = await query(
      `SELECT tenant_id FROM ers_configurations WHERE id = $1`, [ersConfigId]
    );
    expect(row.tenant_id).toBe(tenantId);
  });

  it('the ERS configuration is immediately visible to graph validation for this tenant (the actual downstream symptom of the old bug)', async () => {
    const { rows } = await query(
      `SELECT id FROM ers_configurations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [ersConfigId, tenantId]
    );
    expect(rows).toHaveLength(1);
  });
});

describe('Phase 1 item 6 — ENS configuration tenant_id is set on create', () => {
  it('POST /ens/configurations sets tenant_id to the creating user\'s tenant', async () => {
    const res = await request(server)
      .post('/api/v1/ens/configurations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ organization_id: orgId, name: 'Phase1 ENS Config' });
    expect(res.status).toBe(201);
    ensConfigId = res.body.id;

    const { rows: [row] } = await query(
      `SELECT tenant_id FROM ens_configurations WHERE id = $1`, [ensConfigId]
    );
    expect(row.tenant_id).toBe(tenantId);
  });

  it('the ENS configuration is immediately visible to graph validation for this tenant', async () => {
    const { rows } = await query(
      `SELECT id FROM ens_configurations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [ensConfigId, tenantId]
    );
    expect(rows).toHaveLength(1);
  });
});

// Item 9 — ivrLookup()'s version subquery must filter published_at IS NOT
// NULL. The column is NOT NULL by schema constraint (migration 010), so a
// literal NULL row can't be inserted to prove the filter's runtime effect
// — the constraint itself is the primary guarantee. This asserts the
// defense-in-depth filter is present in the query source, so a future
// schema change (e.g. relaxing the NOT NULL constraint for a draft-version
// feature) can't silently reintroduce the bug without this test catching
// the missing filter.

describe('Phase 1 item 9 — ivrLookup only ever serves published versions', () => {
  it('the lookup query filters on v.published_at IS NOT NULL', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const filePath = fileURLToPath(new URL('../../controllers/internal/ivrInternalController.js', import.meta.url));
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('v.published_at IS NOT NULL');
  });

  it('published_at is enforced NOT NULL at the schema level as the primary guarantee', async () => {
    const { rows } = await query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'ivr_flow_versions' AND column_name = 'published_at'`
    );
    expect(rows[0]?.is_nullable).toBe('NO');
  });
});

// Item 13 — completeIncidentCore() is the single reusable core both the
// HTTP endpoint (exec_ers's per-leg call) and the ESL conference-destroy
// reconciliation listener (orphan cleanup) call — it must never mark an
// already-COMPLETED incident again (which would re-emit the socket event
// and could double-promote a queue entry if called twice for the same
// incident, e.g. once from exec_ers's normal completion and again from
// the reconciliation listener firing moments later for the same room).

describe('Phase 1 item 13 — ERS incident completion is idempotent and reusable', () => {
  let incidentUuid;
  let incidentDbId;

  beforeAll(async () => {
    incidentUuid = uuidv4();
    const { rows: [inc] } = await query(
      `INSERT INTO ers_incidents
         (incident_uuid, ers_configuration_id, status, caller_number, conference_room, group_type, started_at)
       VALUES ($1, $2, 'ACTIVE', '5551234567', 'ers_test_room_p1', 'primary', now())
       RETURNING id`,
      [incidentUuid, ersConfigId]
    );
    incidentDbId = inc.id;
  });

  afterAll(async () => {
    if (incidentDbId) await query(`DELETE FROM ers_incidents WHERE id = $1`, [incidentDbId]);
  });

  it('marks the incident COMPLETED with ended_at set on first call', async () => {
    const result = await completeIncidentCore(incidentUuid, null);
    expect(result).not.toBeNull();

    const { rows: [row] } = await query(
      `SELECT status, ended_at FROM ers_incidents WHERE incident_uuid = $1`, [incidentUuid]
    );
    expect(row.status).toBe('COMPLETED');
    expect(row.ended_at).not.toBeNull();
  });

  it('is a safe no-op on a second call for the same already-completed incident', async () => {
    const result = await completeIncidentCore(incidentUuid, null);
    expect(result).toBeNull();
  });
});
