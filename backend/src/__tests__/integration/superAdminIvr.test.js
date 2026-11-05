/**
 * SUPER_ADMIN IVR administration across tenants (docs/tenant-unification/PROGRESS.md,
 * SUPER_ADMIN IVR follow-up). Continues the TU numbering of tenantUnification.test.js;
 * kept in its own file because deploy needs the FS_* scratch paths and the ESL mock
 * to be in place before the server loads.
 *
 *  TU-7   SUPER_ADMIN creates IVRs for tenant A and tenant B (plain and from template)
 *  TU-8   missing / malformed / unknown / inactive tenant and a foreign organization are
 *         rejected on create (plain and from template); nothing is written
 *  TU-9   SUPER_ADMIN edits, publishes and deletes IVRs of both tenants under All Tenants;
 *         with a tenant selected, other tenants' IVRs are out of scope
 *  TU-10  SUPER_ADMIN deploys and previews IVRs of both tenants under All Tenants using each
 *         IVR's own tenant and bindings; a selected tenant restricts deploy to that tenant
 *  TU-11  bind / unbind validate the number against the IVR's tenant, not the caller's
 *  TU-12  tenant ADMIN restrictions are unchanged
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

// Point every FS_* path at a scratch dir BEFORE config/fsConfig loads (as deployPipeline.test.js).
const scratch = mkdtempSync(path.join(tmpdir(), 'super-admin-ivr-'));
process.env.FS_CONF_DIR      = path.join(scratch, 'conf').replace(/\\/g, '/');
process.env.FS_DIALPLAN_DIR  = path.join(scratch, 'dialplan').replace(/\\/g, '/');
process.env.FS_SCRIPT_DIR    = path.join(scratch, 'scripts').replace(/\\/g, '/');
process.env.FS_SOUND_DIR     = path.join(scratch, 'sounds').replace(/\\/g, '/');
process.env.FS_RECORDING_DIR = path.join(scratch, 'recordings').replace(/\\/g, '/');

// ESL boundary mock — no FreeSWITCH in the test environment.
vi.mock('../../services/eslService.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    connect: vi.fn(),
    eslCommand: vi.fn(async (cmd) => (cmd === 'reloadxml' ? '+OK [Success]' : '')),
    verifyExtensionLoaded: vi.fn(async (name) => ({ loaded: true, raw: `<extension name="${name}"/>`, attempts: 1 })),
    getConferenceMemberCount: vi.fn(async () => 0),
  };
});

const { default: request } = await import('supertest');
const { default: bcrypt }  = await import('bcryptjs');
const { default: server }  = await import('../../../server.js');
const { query }            = await import('../../db/pool.js');

const TS  = Date.now();
const NUM = String(TS).slice(-6);
const HANGUP = { entry_node_id: 'n1', nodes: { n1: { type: 'hangup' } } };

let tenantA, tenantB, tenantOff, orgA, orgB;
let adminA = '', superAdmin = '';
let flowA = '', flowB = '';          // created by SUPER_ADMIN in TU-7, used by TU-9..TU-12
let numA, numB, numA2, numCross;      // emergency_numbers ids
let templateId;
const userIds = [];

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 4);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1,$2,$3,$4,true,'SUPER_ADMIN IVR Test') RETURNING id`,
    [email, hash, role, tenantId]
  );
  userIds.push(u.id);
  const res = await request(server).post('/api/v1/auth/login').send({ email, password: 'Test1234!' });
  return res.body.token;
}

async function makeNumber(suffix, orgId, tenantId) {
  const { rows: [n] } = await query(
    `INSERT INTO emergency_numbers (number, type, organization_id, tenant_id, is_active)
     VALUES ($1, 'IVR', $2, $3, true) RETURNING id`,
    [`9${NUM}${suffix}`, orgId, tenantId]
  );
  return n.id;
}

const flowRow = async (uuid) => (await query(
  `SELECT id, tenant_id, organization_id, name, deleted_at FROM ivr_flows WHERE flow_uuid = $1`, [uuid])).rows[0];
const boundFlowOf = async (numId) => (await query(
  `SELECT ivr_flow_id FROM emergency_numbers WHERE id = $1`, [numId])).rows[0].ivr_flow_id;
const countByName = async (name) => Number((await query(
  `SELECT COUNT(*) FROM ivr_flows WHERE name = $1`, [name])).rows[0].count);

async function publish(uuid, token) {
  const save = await request(server).put(`/api/v1/ivr/flows/${uuid}`).set(auth(token)).send({ graph: HANGUP });
  expect(save.status).toBe(200);
  const pub = await request(server).post(`/api/v1/ivr/flows/${uuid}/publish`).set(auth(token)).send({});
  expect(pub.status).toBe(201);
}

beforeAll(async () => {
  const mkTenant = async (tag, active = true) => (await query(
    `INSERT INTO tenants (name, code, is_active) VALUES ($1,$2,$3) RETURNING id`,
    [`SA-${tag}-${TS}`, `sa-${tag}-${TS}`, active])).rows[0].id;
  tenantA   = await mkTenant('a');
  tenantB   = await mkTenant('b');
  tenantOff = await mkTenant('off', false);
  ({ rows: [{ id: orgA }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('SA Org A',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgB }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('SA Org B',$1) RETURNING id`, [tenantB]));

  numA     = await makeNumber('1', orgA, tenantA);
  numA2    = await makeNumber('2', orgA, tenantA);
  numB     = await makeNumber('3', orgB, tenantB);
  numCross = await makeNumber('4', orgB, tenantB);

  adminA     = await makeUser(`sa-admin-a-${TS}@test.local`, 'ADMIN', tenantA);
  superAdmin = await makeUser(`sa-super-${TS}@test.local`, 'SUPER_ADMIN', null);

  const tpl = await request(server).get('/api/v1/ivr/flows/templates').set(auth(superAdmin));
  templateId = (tpl.body.templates || [])[0]?.id;
});

afterAll(async () => {
  const tenants = [tenantA, tenantB, tenantOff];
  await query(`DELETE FROM ivr_flow_deployments WHERE flow_uuid IN (SELECT flow_uuid FROM ivr_flows WHERE tenant_id = ANY($1))`, [tenants]).catch(() => {});
  await query(`DELETE FROM emergency_numbers WHERE tenant_id = ANY($1)`, [tenants]);
  await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id IN (SELECT id FROM ivr_flows WHERE tenant_id = ANY($1))`, [tenants]);
  await query(`DELETE FROM ivr_flows WHERE tenant_id = ANY($1)`, [tenants]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
  await query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [orgA, orgB]);
  await query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenants]);
  rmSync(scratch, { recursive: true, force: true });
});

describe('TU-7: SUPER_ADMIN creates IVRs for a selected tenant', () => {
  it('creates an IVR for tenant A with tenant A\'s organization', async () => {
    const res = await request(server).post('/api/v1/ivr/flows').set(auth(superAdmin))
      .send({ name: `SA Flow A ${TS}`, organization_id: orgA, tenant_id: tenantA });
    expect(res.status).toBe(201);
    flowA = res.body.flow.flow_uuid;
    expect(await flowRow(flowA)).toMatchObject({ tenant_id: tenantA, organization_id: orgA });
  });

  it('creates an IVR for tenant B (tenant selected via ?tenant_id)', async () => {
    const res = await request(server).post(`/api/v1/ivr/flows?tenant_id=${tenantB}`).set(auth(superAdmin))
      .send({ name: `SA Flow B ${TS}`, organization_id: orgB });
    expect(res.status).toBe(201);
    flowB = res.body.flow.flow_uuid;
    expect(await flowRow(flowB)).toMatchObject({ tenant_id: tenantB, organization_id: orgB });
  });

  it('creates from a template for tenant A and for tenant B', async () => {
    expect(templateId).toBeTruthy();
    for (const [tenant, org] of [[tenantA, orgA], [tenantB, orgB]]) {
      const res = await request(server).post(`/api/v1/ivr/flows/templates/${templateId}/create`).set(auth(superAdmin))
        .send({ name: `SA Tpl ${tenant} ${TS}`, tenant_id: tenant, organization_id: org });
      expect(res.status).toBe(201);
      expect(await flowRow(res.body.flow_uuid)).toMatchObject({ tenant_id: tenant, organization_id: org });
    }
  });
});

describe('TU-8: invalid or missing tenant selection is rejected on create', () => {
  const plain = (body, qs = '') => request(server).post(`/api/v1/ivr/flows${qs}`).set(auth(superAdmin)).send(body);
  const tpl   = (body) => request(server).post(`/api/v1/ivr/flows/templates/${templateId}/create`).set(auth(superAdmin)).send(body);

  it('missing or malformed tenant → 400, nothing written', async () => {
    const name = `SA bad ${TS}`;
    for (const t of [undefined, 'abc', 0, -1, '1.5']) {
      const res = await plain(t === undefined ? { name } : { name, tenant_id: t });
      expect(res.status, `tenant_id=${t}`).toBe(400);
      const tr = await tpl(t === undefined ? { name } : { name, tenant_id: t });
      expect(tr.status, `template tenant_id=${t}`).toBe(400);
    }
    expect(await countByName(name)).toBe(0);
  });

  it('unknown tenant → 400 with a clear message, nothing written', async () => {
    const name = `SA unknown ${TS}`;
    const res = await plain({ name, tenant_id: 2147483000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenant not found or inactive/i);
    expect((await tpl({ name, tenant_id: 2147483000 })).status).toBe(400);
    expect(await countByName(name)).toBe(0);
  });

  it('inactive tenant → 400, nothing written', async () => {
    const name = `SA inactive ${TS}`;
    const res = await plain({ name, tenant_id: tenantOff });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenant not found or inactive/i);
    expect((await tpl({ name, tenant_id: tenantOff })).status).toBe(400);
    expect(await countByName(name)).toBe(0);
  });

  it('organization of another tenant → 400, nothing written (plain and template)', async () => {
    const name = `SA foreign org ${TS}`;
    const res = await plain({ name, tenant_id: tenantA, organization_id: orgB });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/organization/i);
    expect((await tpl({ name, tenant_id: tenantA, organization_id: orgB })).status).toBe(400);
    expect((await plain({ name, tenant_id: tenantA, organization_id: 2147483000 })).status).toBe(400);
    expect(await countByName(name)).toBe(0);
  });
});

describe('TU-9: SUPER_ADMIN edits and manages IVRs across tenants', () => {
  it('under All Tenants: reads, renames and publishes IVRs of both tenants', async () => {
    for (const [uuid, tenant] of [[flowA, tenantA], [flowB, tenantB]]) {
      const get = await request(server).get(`/api/v1/ivr/flows/${uuid}`).set(auth(superAdmin));
      expect(get.status).toBe(200);
      expect(get.body.flow.tenant_id).toBe(tenant);
      const put = await request(server).put(`/api/v1/ivr/flows/${uuid}`).set(auth(superAdmin)).send({ name: `SA renamed ${uuid}` });
      expect(put.status).toBe(200);
      await publish(uuid, superAdmin);
      expect(await flowRow(uuid)).toMatchObject({ tenant_id: tenant, name: `SA renamed ${uuid}` });
    }
  });

  it('with tenant A selected, tenant B\'s IVR is out of scope (404) and untouched', async () => {
    const qs = `?tenant_id=${tenantA}`;
    expect((await request(server).get(`/api/v1/ivr/flows/${flowB}${qs}`).set(auth(superAdmin))).status).toBe(404);
    expect((await request(server).put(`/api/v1/ivr/flows/${flowB}${qs}`).set(auth(superAdmin)).send({ name: 'x' })).status).toBe(404);
    expect((await request(server).delete(`/api/v1/ivr/flows/${flowB}${qs}`).set(auth(superAdmin))).status).toBe(404);
    expect(await flowRow(flowB)).toMatchObject({ name: `SA renamed ${flowB}`, deleted_at: null });
  });

  it('under All Tenants: deletes an IVR of either tenant', async () => {
    for (const tenant of [tenantA, tenantB]) {
      const c = await request(server).post('/api/v1/ivr/flows').set(auth(superAdmin)).send({ name: `SA del ${TS}`, tenant_id: tenant });
      expect(c.status).toBe(201);
      const del = await request(server).delete(`/api/v1/ivr/flows/${c.body.flow.flow_uuid}`).set(auth(superAdmin));
      expect([200, 204]).toContain(del.status);
      expect((await flowRow(c.body.flow.flow_uuid)).deleted_at).not.toBeNull();
    }
  });
});

describe('TU-11: bind / unbind validate the number against the IVR\'s tenant', () => {
  it('SUPER_ADMIN (All Tenants) cannot bind tenant A\'s IVR to tenant B\'s number', async () => {
    const res = await request(server).patch(`/api/v1/ivr/flows/${flowA}/bind`).set(auth(superAdmin)).send({ emergency_number_id: numB });
    expect(res.status).toBe(404);
    expect(await boundFlowOf(numB)).toBeNull();
  });

  it('SUPER_ADMIN binds each IVR to its own tenant\'s number', async () => {
    const a = await request(server).patch(`/api/v1/ivr/flows/${flowA}/bind`).set(auth(superAdmin)).send({ emergency_number_id: numA });
    const b = await request(server).patch(`/api/v1/ivr/flows/${flowB}/bind`).set(auth(superAdmin)).send({ emergency_number_id: numB });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await boundFlowOf(numA)).toBe((await flowRow(flowA)).id);
    expect(await boundFlowOf(numB)).toBe((await flowRow(flowB)).id);
  });

  it('unbind of a number from another tenant is refused; own number unbinds', async () => {
    const idA = (await flowRow(flowA)).id;
    // A pre-existing cross-tenant binding (as the old bind allowed): B's number on A's IVR.
    await query(`UPDATE emergency_numbers SET ivr_flow_id = $1 WHERE id = $2`, [idA, numCross]);
    const cross = await request(server).patch(`/api/v1/ivr/flows/${flowA}/unbind`).set(auth(superAdmin)).send({ emergency_number_id: numCross });
    expect(cross.status).toBe(404);
    await query(`UPDATE emergency_numbers SET ivr_flow_id = NULL WHERE id = $1`, [numCross]);

    await query(`UPDATE emergency_numbers SET ivr_flow_id = $1 WHERE id = $2`, [idA, numA2]);
    const own = await request(server).patch(`/api/v1/ivr/flows/${flowA}/unbind`).set(auth(superAdmin)).send({ emergency_number_id: numA2 });
    expect(own.status).toBe(200);
    expect(await boundFlowOf(numA2)).toBeNull();
  });

  it('the numbers list carries each number\'s tenant (used by the bind dialog filter)', async () => {
    const res = await request(server).get('/api/v1/settings/emergency-numbers').set(auth(superAdmin));
    expect(res.status).toBe(200);
    const mine = res.body.numbers.filter(n => [numA, numB].includes(n.id));
    expect(Object.fromEntries(mine.map(n => [n.id, n.tenant_id]))).toEqual({ [numA]: tenantA, [numB]: tenantB });
  });
});

describe('TU-10: SUPER_ADMIN deploys IVRs of both tenants', () => {
  it('under All Tenants: deploys tenant A\'s and tenant B\'s IVR', async () => {
    for (const uuid of [flowA, flowB]) {
      const res = await request(server).post(`/api/v1/deployment/flows/${uuid}/deploy`).set(auth(superAdmin)).send({});
      expect(res.status, JSON.stringify(res.body.errors || res.body.error)).toBe(200);
      expect(res.body.status).toBe('success');
    }
  });

  it('under All Tenants: preview resolves each IVR\'s own bindings', async () => {
    const a = await request(server).get(`/api/v1/deployment/flows/${flowA}/preview`).set(auth(superAdmin));
    const b = await request(server).get(`/api/v1/deployment/flows/${flowB}/preview`).set(auth(superAdmin));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.bound_numbers).toEqual([`9${NUM}1`]);
    expect(b.body.bound_numbers).toEqual([`9${NUM}3`]);
  });

  it('tenant bindings are unchanged by deployment', async () => {
    expect(await boundFlowOf(numA)).toBe((await flowRow(flowA)).id);
    expect(await boundFlowOf(numB)).toBe((await flowRow(flowB)).id);
    expect(await boundFlowOf(numCross)).toBeNull();
  });

  it('with tenant B selected, tenant A\'s IVR cannot be deployed or previewed', async () => {
    const dep = await request(server).post(`/api/v1/deployment/flows/${flowA}/deploy?tenant_id=${tenantB}`).set(auth(superAdmin)).send({});
    expect(dep.status).not.toBe(200);
    const pre = await request(server).get(`/api/v1/deployment/flows/${flowA}/preview?tenant_id=${tenantB}`).set(auth(superAdmin));
    expect(pre.status).toBe(404);
  });

  it('unknown IVR under All Tenants → 404', async () => {
    const res = await request(server).post('/api/v1/deployment/flows/00000000-0000-4000-8000-000000000000/deploy').set(auth(superAdmin)).send({});
    expect(res.status).toBe(404);
  });
});

describe('TU-12: tenant ADMIN restrictions are unchanged', () => {
  it('create ignores a forged body tenant and stores the caller\'s tenant', async () => {
    const res = await request(server).post('/api/v1/ivr/flows').set(auth(adminA)).send({ name: `SA forged ${TS}`, tenant_id: tenantB });
    expect(res.status).toBe(201);
    expect((await flowRow(res.body.flow.flow_uuid)).tenant_id).toBe(tenantA);
  });

  it('create with another tenant\'s organization → 400', async () => {
    const res = await request(server).post('/api/v1/ivr/flows').set(auth(adminA)).send({ name: `SA admin foreign org ${TS}`, organization_id: orgB });
    expect(res.status).toBe(400);
    expect(await countByName(`SA admin foreign org ${TS}`)).toBe(0);
  });

  it('another tenant\'s IVR: read, edit, delete, preview, bind → 404; deploy refused', async () => {
    const h = auth(adminA);
    expect((await request(server).get(`/api/v1/ivr/flows/${flowB}`).set(h)).status).toBe(404);
    expect((await request(server).put(`/api/v1/ivr/flows/${flowB}`).set(h).send({ name: 'x' })).status).toBe(404);
    expect((await request(server).delete(`/api/v1/ivr/flows/${flowB}`).set(h)).status).toBe(404);
    expect((await request(server).get(`/api/v1/deployment/flows/${flowB}/preview`).set(h)).status).toBe(404);
    expect((await request(server).patch(`/api/v1/ivr/flows/${flowB}/bind`).set(h).send({ emergency_number_id: numA })).status).toBe(404);
    const dep = await request(server).post(`/api/v1/deployment/flows/${flowB}/deploy`).set(h).send({});
    expect(dep.status).not.toBe(200);
    expect(await flowRow(flowB)).toMatchObject({ tenant_id: tenantB, deleted_at: null });
  });

  it('own IVR: bind to another tenant\'s number → 404', async () => {
    const res = await request(server).patch(`/api/v1/ivr/flows/${flowA}/bind`).set(auth(adminA)).send({ emergency_number_id: numB });
    expect(res.status).toBe(404);
    expect(await boundFlowOf(numB)).toBe((await flowRow(flowB)).id);
  });

  it('a forged ?tenant_id does not widen the IVR list or the numbers list', async () => {
    const list = await request(server).get(`/api/v1/ivr/flows?tenant_id=${tenantB}&limit=200`).set(auth(adminA));
    expect(list.body.flows.map(f => f.flow_uuid)).not.toContain(flowB);
    const nums = await request(server).get(`/api/v1/settings/emergency-numbers?tenant_id=${tenantB}`).set(auth(adminA));
    expect(nums.body.numbers.map(n => n.id)).not.toContain(numB);
  });
});
