/**
 * Tenant scoping — gaps not covered by the existing isolation suites
 * (docs/tenant-unification/PLAN.md, Part 1, Steps 1–4).
 *
 *  TU-1  ERS configuration list (the IVR picker's endpoint) / get / update are tenant-scoped
 *  TU-2  a tenant_id sent in the request body is ignored on create
 *  TU-3  flow validate / publish reject another tenant's ERS configuration
 *  TU-4  SUPER_ADMIN validating a tenant's flow is checked against the FLOW's tenant
 *  TU-5  overflow-queued incidents carry the configuration's tenant and appear in that
 *        tenant's ERS report only
 *  TU-6  migration 050 backfills only NULL incident tenants, from the incident's own
 *        configuration, and is idempotent
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

import server from '../../../server.js';
import { query } from '../../db/pool.js';

const TS = Date.now();
const MIGRATION_050 = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations/050_ers_incident_tenant_backfill.sql');

let tenantA, tenantB, orgA, orgB, cfgA, cfgB, cfgNoTenant;
let adminA = '', adminB = '', superAdmin = '';
let flowUuidA = '';
const userIds = [];

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 4);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1,$2,$3,$4,true,'Tenant Unification Test') RETURNING id`,
    [email, hash, role, tenantId]
  );
  userIds.push(u.id);
  const res = await request(server).post('/api/v1/auth/login').send({ email, password: 'Test1234!' });
  return res.body.token;
}

async function makeConfig(name, orgId, tenantId) {
  const { rows: [c] } = await query(
    `INSERT INTO ers_configurations (name, organization_id, tenant_id, max_concurrent_conferences, queue_enabled, is_active)
     VALUES ($1,$2,$3,1,true,true) RETURNING id`,
    [name, orgId, tenantId]
  );
  return c.id;
}

const ringAll = (cfgId) => ({
  entry_node_id: 'n1',
  nodes: { n1: { type: 'ers_ring_all', ers_configuration_id: cfgId, tier: 'primary' } },
});
const wrongTenant = (errors = []) => errors.filter(e => /wrong tenant/.test(e));

beforeAll(async () => {
  ({ rows: [{ id: tenantA }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`TU-A-${TS}`, `tu-a-${TS}`]));
  ({ rows: [{ id: tenantB }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`TU-B-${TS}`, `tu-b-${TS}`]));
  ({ rows: [{ id: orgA }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('TU Org A',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgB }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('TU Org B',$1) RETURNING id`, [tenantB]));

  cfgA = await makeConfig(`TU ERS A ${TS}`, orgA, tenantA);
  cfgB = await makeConfig(`TU ERS B ${TS}`, orgB, tenantB);
  cfgNoTenant = await makeConfig(`TU ERS legacy ${TS}`, orgA, null);

  adminA = await makeUser(`tu-admin-a-${TS}@test.local`, 'ADMIN', tenantA);
  adminB = await makeUser(`tu-admin-b-${TS}@test.local`, 'ADMIN', tenantB);
  superAdmin = await makeUser(`tu-super-${TS}@test.local`, 'SUPER_ADMIN', null);

  const res = await request(server).post('/api/v1/ivr/flows')
    .set('Authorization', `Bearer ${adminA}`)
    .send({ name: `TU Flow A ${TS}` });
  flowUuidA = res.body.flow?.flow_uuid || '';
});

afterAll(async () => {
  const cfgs = [cfgA, cfgB, cfgNoTenant];
  await query(`DELETE FROM ers_queues WHERE ers_configuration_id = ANY($1)`, [cfgs]);
  await query(`DELETE FROM ers_incidents WHERE ers_configuration_id = ANY($1)`, [cfgs]);
  await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id IN (SELECT id FROM ivr_flows WHERE tenant_id IN ($1,$2))`, [tenantA, tenantB]);
  await query(`DELETE FROM ivr_flows WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  await query(`DELETE FROM ers_configurations WHERE tenant_id IN ($1,$2) OR id = ANY($3)`, [tenantA, tenantB, cfgs]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
  await query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [orgA, orgB]);
  await query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenantA, tenantB]);
});

describe('TU-1: ERS configuration endpoints are tenant-scoped', () => {
  it('the list used by the IVR picker returns only the caller\'s tenant, both directions', async () => {
    const a = await request(server).get('/api/v1/ers/configurations?limit=200&page=1').set('Authorization', `Bearer ${adminA}`);
    const b = await request(server).get('/api/v1/ers/configurations?limit=200&page=1').set('Authorization', `Bearer ${adminB}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const idsA = a.body.configurations.map(c => c.id);
    const idsB = b.body.configurations.map(c => c.id);
    expect(idsA).toContain(cfgA);
    expect(idsA).not.toContain(cfgB);
    expect(idsB).toContain(cfgB);
    expect(idsB).not.toContain(cfgA);
    expect(a.body.configurations.every(c => c.tenant_id === tenantA)).toBe(true);
  });

  it('a forged ?tenant_id does not widen a tenant admin\'s list', async () => {
    const res = await request(server).get(`/api/v1/ers/configurations?tenant_id=${tenantB}`).set('Authorization', `Bearer ${adminA}`);
    expect(res.body.configurations.map(c => c.id)).not.toContain(cfgB);
  });

  it('get / update of another tenant\'s configuration → 404, row untouched', async () => {
    const get = await request(server).get(`/api/v1/ers/configurations/${cfgB}`).set('Authorization', `Bearer ${adminA}`);
    expect(get.status).toBe(404);
    const put = await request(server).put(`/api/v1/ers/configurations/${cfgB}`)
      .set('Authorization', `Bearer ${adminA}`).send({ organization_id: orgA, name: 'hijacked' });
    expect(put.status).toBe(404);
    const { rows: [row] } = await query(`SELECT name, tenant_id FROM ers_configurations WHERE id = $1`, [cfgB]);
    expect(row).toEqual({ name: `TU ERS B ${TS}`, tenant_id: tenantB });
  });
});

describe('TU-2: request-body tenant identity is ignored', () => {
  it('create stores the caller\'s tenant even when the body names another tenant', async () => {
    const res = await request(server).post('/api/v1/ers/configurations')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ organization_id: orgA, name: `TU forged ${TS}`, tenant_id: tenantB });
    expect(res.status).toBe(201);
    const { rows: [row] } = await query(`SELECT tenant_id FROM ers_configurations WHERE id = $1`, [res.body.id]);
    expect(row.tenant_id).toBe(tenantA);
  });
});

describe('TU-3: flows cannot reference another tenant\'s configuration', () => {
  it('validate: own config accepted, other tenant\'s config rejected', async () => {
    const own = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/validate`)
      .set('Authorization', `Bearer ${adminA}`).send({ graph: ringAll(cfgA) });
    expect(own.status).toBe(200);
    expect(wrongTenant(own.body.errors)).toEqual([]);

    const other = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/validate`)
      .set('Authorization', `Bearer ${adminA}`).send({ graph: ringAll(cfgB) });
    expect(wrongTenant(other.body.errors).length).toBeGreaterThan(0);
  });

  it('publish of a saved flow referencing another tenant\'s config → 400, nothing published', async () => {
    const save = await request(server).put(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminA}`).send({ graph: ringAll(cfgB) });
    expect(save.status).toBe(200);
    const pub = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/publish`)
      .set('Authorization', `Bearer ${adminA}`).send({});
    expect(pub.status).toBe(400);
    expect(wrongTenant(pub.body.errors).length).toBeGreaterThan(0);
    const { rows } = await query(
      `SELECT 1 FROM ivr_flow_versions v JOIN ivr_flows f ON f.id = v.ivr_flow_id WHERE f.flow_uuid = $1`, [flowUuidA]);
    expect(rows).toHaveLength(0);
  });
});

describe('TU-4: SUPER_ADMIN editing a tenant\'s flow is validated against the flow\'s tenant', () => {
  it('the flow tenant\'s config is accepted (no ?tenant_id needed)', async () => {
    const res = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/validate`)
      .set('Authorization', `Bearer ${superAdmin}`).send({ graph: ringAll(cfgA) });
    expect(res.status).toBe(200);
    expect(wrongTenant(res.body.errors)).toEqual([]);
  });

  it('another tenant\'s config is still rejected, even with ?tenant_id of that other tenant', async () => {
    const res = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/validate`)
      .set('Authorization', `Bearer ${superAdmin}`).send({ graph: ringAll(cfgB) });
    expect(wrongTenant(res.body.errors).length).toBeGreaterThan(0);
    const forged = await request(server).post(`/api/v1/ivr/flows/${flowUuidA}/validate?tenant_id=${tenantB}`)
      .set('Authorization', `Bearer ${superAdmin}`).send({ graph: ringAll(cfgB) });
    // With ?tenant_id=B the flow (tenant A) is out of scope → 404; either way cfgB is never accepted for it.
    if (forged.status === 200) expect(wrongTenant(forged.body.errors).length).toBeGreaterThan(0);
    else expect(forged.status).toBe(404);
  });
});

describe('TU-5: overflow-queued incidents carry their tenant', () => {
  let incidentUuid;

  it('enqueue stores the configuration\'s tenant on the incident', async () => {
    const res = await request(server).post('/api/v1/internal/ers/overflow/enqueue')
      .set('X-Internal-Key', process.env.INTERNAL_API_KEY)
      .send({ configuration_id: cfgA, caller_number: '+15550001111', caller_name: 'Queued Caller' });
    expect(res.status).toBe(201);
    incidentUuid = res.body.incident_uuid;
    const { rows: [row] } = await query(
      `SELECT tenant_id, status, queued_at IS NOT NULL AS queued FROM ers_incidents WHERE incident_uuid = $1`, [incidentUuid]);
    expect(row).toEqual({ tenant_id: tenantA, status: 'QUEUED', queued: true });
  });

  it('the queued incident appears in its tenant\'s ERS report and not in the other tenant\'s', async () => {
    const a = await request(server).get('/api/v1/reports/ers?limit=200').set('Authorization', `Bearer ${adminA}`);
    const b = await request(server).get('/api/v1/reports/ers?limit=200').set('Authorization', `Bearer ${adminB}`);
    expect(a.status).toBe(200);
    expect(a.body.incidents.map(i => i.incident_uuid)).toContain(incidentUuid);
    expect(b.body.incidents.map(i => i.incident_uuid)).not.toContain(incidentUuid);
  });
});

describe('TU-6: migration 050 (ers_incidents tenant backfill)', () => {
  it('backfills NULL tenants from the incident\'s configuration only, leaves the rest, and is idempotent', async () => {
    const ins = (cfg, tenant) => query(
      `INSERT INTO ers_incidents (incident_uuid, ers_configuration_id, tenant_id, status, caller_number, group_type, started_at, queued_at)
       VALUES (gen_random_uuid(), $1, $2, 'COMPLETED', '+15550002222', 'primary', now(), now()) RETURNING id`, [cfg, tenant]);
    const { rows: [nullA] }  = await ins(cfgA, null);          // repairable → tenant A
    const { rows: [nullB] }  = await ins(cfgB, null);          // repairable → tenant B
    const { rows: [legacy] } = await ins(cfgNoTenant, null);   // config has no tenant → left NULL
    const { rows: [setA] }   = await ins(cfgA, tenantA);       // already set → untouched

    const tenants = async () => Object.fromEntries((await query(
      `SELECT id, tenant_id FROM ers_incidents WHERE id = ANY($1)`,
      [[nullA.id, nullB.id, legacy.id, setA.id]])).rows.map(r => [r.id, r.tenant_id]));

    const sql = readFileSync(MIGRATION_050, 'utf8');
    await query(sql);
    const first = await tenants();
    expect(first).toEqual({ [nullA.id]: tenantA, [nullB.id]: tenantB, [legacy.id]: null, [setA.id]: tenantA });

    await query(sql);                                           // second run: no change
    expect(await tenants()).toEqual(first);
  });
});
