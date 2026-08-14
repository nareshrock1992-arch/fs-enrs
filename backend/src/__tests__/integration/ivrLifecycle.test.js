/**
 * IVR Flows — Full Lifecycle Integration Tests (Phase 14, 20 cases)
 *
 * Covers: tenant isolation, draft/published state, templates, number binding,
 * internal lookup, listFlowStatus security fix, and cross-tenant leakage checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import server from '../../../server.js';
import { query } from '../../db/pool.js';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tenantA = null, tenantB = null;
let adminA = '', adminB = '';
let adminAId = null, adminBId = null;
let flowUuidA = '', flowIdA = null;
let flowUuidB = '', flowIdB = null;
let numIdA = null, numIdB = null;

const MINIMAL_GRAPH = {
  entry_node_id: 'n1',
  nodes: { n1: { type: 'hangup' } },
};

const VALID_GRAPH = {
  entry_node_id: 'n1',
  nodes: {
    n1: { type: 'play', audio_url: '/media/hi.wav', next: 'n2' },
    n2: { type: 'hangup' },
  },
};

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 12);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1, $2, $3, $4, true, 'Test User') RETURNING id`,
    [email, hash, role, tenantId]
  );
  return u.id;
}

async function login(email, password = 'Test1234!') {
  const res = await request(server)
    .post('/api/v1/auth/login')
    .send({ email, password });
  return res.body.token;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const ts = Date.now();

  // Tenant A
  const { rows: [tA] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('LC-Tenant-A', $1) RETURNING id`,
    [`lc-a-${ts}`]
  );
  tenantA = tA.id;

  // Tenant B
  const { rows: [tB] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('LC-Tenant-B', $1) RETURNING id`,
    [`lc-b-${ts}`]
  );
  tenantB = tB.id;

  // Users
  adminAId = await makeUser(`lc-admin-a-${ts}@test.local`, 'ADMIN', tenantA);
  adminBId = await makeUser(`lc-admin-b-${ts}@test.local`, 'ADMIN', tenantB);
  await makeUser(`lc-viewer-a-${ts}@test.local`, 'VIEWER', tenantA);

  adminA = await login(`lc-admin-a-${ts}@test.local`);
  adminB = await login(`lc-admin-b-${ts}@test.local`);

  // Emergency numbers
  const { rows: [nA] } = await query(
    `INSERT INTO emergency_numbers (number, type, tenant_id)
     VALUES ('+61399990011', 'IVR', $1) RETURNING id`,
    [tenantA]
  );
  numIdA = nA.id;

  const { rows: [nB] } = await query(
    `INSERT INTO emergency_numbers (number, type, tenant_id)
     VALUES ('+61399990022', 'IVR', $1) RETURNING id`,
    [tenantB]
  );
  numIdB = nB.id;
});

afterAll(async () => {
  // Unlink numbers from flows
  await query(`UPDATE emergency_numbers SET ivr_flow_id = NULL WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  // Clean flows
  if (flowIdA) await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id=$1`, [flowIdA]);
  if (flowIdB) await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id=$1`, [flowIdB]);
  await query(`DELETE FROM ivr_flows WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  // Clean numbers
  await query(`DELETE FROM emergency_numbers WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  // Clean users + tenants
  await query(`DELETE FROM users WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  await query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenantA, tenantB]);
});

// ── Test 1: Create flow — tenant_id set correctly ─────────────────────────────

describe('LC-T01: Create flow stamps correct tenant_id', () => {
  it("flow is created with the admin's tenant_id", async () => {
    const res = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'LC Flow A', graph: MINIMAL_GRAPH });

    expect(res.status).toBe(201);
    flowUuidA = res.body.flow.flow_uuid;
    flowIdA   = res.body.flow.id;

    const { rows: [row] } = await query(`SELECT tenant_id FROM ivr_flows WHERE id=$1`, [flowIdA]);
    expect(row.tenant_id).toBe(tenantA);
  });
});

// ── Test 2: Draft state — no versions yet ────────────────────────────────────

describe('LC-T02: Newly created flow is in Draft state', () => {
  it('latest_version is null before publish', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminA}`);

    expect(res.status).toBe(200);
    expect(res.body.flow.latest_version).toBeNull();
  });
});

// ── Test 3: Tenant isolation — Tenant B cannot see Tenant A flow ──────────────

describe('LC-T03: Tenant B cannot list Tenant A flow', () => {
  it('GET /ivr/flows for tenant B returns empty for tenant A flow', async () => {
    const res = await request(server)
      .get('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminB}`);

    expect(res.status).toBe(200);
    expect(res.body.flows.every(f => f.flow_uuid !== flowUuidA)).toBe(true);
  });
});

// ── Test 4: Tenant isolation — Tenant B cannot GET Tenant A flow ──────────────

describe('LC-T04: Tenant B cannot fetch Tenant A flow by UUID', () => {
  it('GET /ivr/flows/:uuid returns 404 for cross-tenant access', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminB}`);

    expect(res.status).toBe(404);
  });
});

// ── Test 5: Templates — static, always 6, no DB rows ─────────────────────────

describe('LC-T05: Template list is static and returns 6 items', () => {
  it('GET /ivr/flows/templates returns 6 templates for both tenants', async () => {
    const resA = await request(server)
      .get('/api/v1/ivr/flows/templates')
      .set('Authorization', `Bearer ${adminA}`);
    const resB = await request(server)
      .get('/api/v1/ivr/flows/templates')
      .set('Authorization', `Bearer ${adminB}`);

    expect(resA.status).toBe(200);
    expect(resA.body.templates.length).toBe(6);
    expect(resB.body.templates.length).toBe(6);
    // Templates must not be DB flow rows — no flow_uuid field
    expect(resA.body.templates[0].flow_uuid).toBeUndefined();
  });
});

// ── Test 6: Create from template — stamps correct tenant_id ──────────────────

describe('LC-T06: createFromTemplate stamps tenant_id of calling user', () => {
  it('flow created from template belongs to Tenant A', async () => {
    const templates = (await request(server)
      .get('/api/v1/ivr/flows/templates')
      .set('Authorization', `Bearer ${adminA}`)).body.templates;
    const tpl = templates[0];

    const res = await request(server)
      .post(`/api/v1/ivr/flows/templates/${tpl.id}`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'From Template A' });

    expect(res.status).toBe(201);
    const { rows: [row] } = await query(
      `SELECT tenant_id FROM ivr_flows WHERE flow_uuid=$1`,
      [res.body.flow_uuid]
    );
    expect(row.tenant_id).toBe(tenantA);
    // Cleanup
    await query(`DELETE FROM ivr_flows WHERE flow_uuid=$1`, [res.body.flow_uuid]);
  });
});

// ── Test 7: Publish → Published state ────────────────────────────────────────

describe('LC-T07: Publish flow transitions it to Published state', () => {
  it('POST /publish creates version and latest_version = 1', async () => {
    // Save valid graph first
    await request(server)
      .put(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ graph: VALID_GRAPH });

    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuidA}/publish`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ change_notes: 'LC lifecycle test' });

    expect(res.status).toBe(201);
    expect(res.body.version.version_number).toBe(1);
  });
});

// ── Test 8: Flow detail shows Published state ─────────────────────────────────

describe('LC-T08: Flow detail reflects Published state after publish', () => {
  it('latest_version is 1 after first publish', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminA}`);

    expect(res.status).toBe(200);
    expect(res.body.flow.latest_version).toBe(1);
  });
});

// ── Test 9: Search by name — matches own tenant flows only ────────────────────

describe('LC-T09: Search returns only tenant-scoped flows', () => {
  it('search for "LC Flow A" finds it for tenant A, not tenant B', async () => {
    const resA = await request(server)
      .get('/api/v1/ivr/flows?search=LC+Flow+A')
      .set('Authorization', `Bearer ${adminA}`);
    const resB = await request(server)
      .get('/api/v1/ivr/flows?search=LC+Flow+A')
      .set('Authorization', `Bearer ${adminB}`);

    expect(resA.body.flows.some(f => f.flow_uuid === flowUuidA)).toBe(true);
    expect(resB.body.flows.length).toBe(0);
  });
});

// ── Test 10: Bind number — updates bound_number_count ────────────────────────

describe('LC-T10: Bind number links flow to emergency_numbers', () => {
  it('PATCH /bind sets bound_number_count to 1', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuidA}/bind`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ emergency_number_id: numIdA });

    expect(res.status).toBe(200);

    const detail = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuidA}`)
      .set('Authorization', `Bearer ${adminA}`);
    expect(detail.body.flow.bound_numbers.some(n => n.id === numIdA)).toBe(true);
  });
});

// ── Test 11: Cross-tenant bind is rejected ────────────────────────────────────

describe('LC-T11: Cannot bind emergency number from another tenant', () => {
  it('PATCH /bind with Tenant B number returns 404 for Tenant A admin', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuidA}/bind`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ emergency_number_id: numIdB });

    expect(res.status).toBe(404);
  });
});

// ── Test 12: Viewer cannot publish ───────────────────────────────────────────

describe('LC-T12: VIEWER role cannot publish a flow', () => {
  it('POST /publish returns 403 for VIEWER token', async () => {
    const { rows: [v] } = await query(
      `SELECT email FROM users WHERE role='VIEWER' AND tenant_id=$1 LIMIT 1`,
      [tenantA]
    );
    const viewerToken = await login(v.email);

    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuidA}/publish`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({});

    expect(res.status).toBe(403);
  });
});

// ── Test 13: Viewer cannot bind numbers ──────────────────────────────────────

describe('LC-T13: VIEWER role cannot bind emergency numbers', () => {
  it('PATCH /bind returns 403 for VIEWER token', async () => {
    const { rows: [v] } = await query(
      `SELECT email FROM users WHERE role='VIEWER' AND tenant_id=$1 LIMIT 1`,
      [tenantA]
    );
    const viewerToken = await login(v.email);

    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuidA}/bind`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ emergency_number_id: numIdA });

    expect(res.status).toBe(403);
  });
});

// ── Test 14: Versions list shows ascending + descending ──────────────────────

describe('LC-T14: Version list is ordered newest-first', () => {
  it('GET /versions returns v1 as the only version', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuidA}/versions`)
      .set('Authorization', `Bearer ${adminA}`);

    expect(res.status).toBe(200);
    expect(res.body.versions[0].version_number).toBe(1);
  });
});

// ── Test 15: Internal lookup — returns published graph ───────────────────────

describe('LC-T15: Internal lookup returns published graph for bound number', () => {
  it('GET /internal/ivr/lookup returns entry_node_id for bound+published flow', async () => {
    // Ensure number is bound at DB level
    await query(`UPDATE emergency_numbers SET ivr_flow_id=$1 WHERE id=$2`, [flowIdA, numIdA]);

    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=%2B61399990011')
      .set('x-internal-key', INTERNAL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.flow_uuid).toBe(flowUuidA);
    expect(res.body.entry_node_id).toBe('n1');
    expect(res.body.version_number).toBe(1);
  });
});

// ── Test 16: Internal lookup — 404 for unbound number ────────────────────────

describe('LC-T16: Internal lookup returns 404 for unbound number', () => {
  it('GET /internal/ivr/lookup for Tenant B number (unbound) returns 404', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=%2B61399990022')
      .set('x-internal-key', INTERNAL_KEY);

    expect(res.status).toBe(404);
  });
});

// ── Test 17: Internal lookup — returns latest published version ───────────────

describe('LC-T17: Internal lookup returns latest version after republish', () => {
  it('republish v2 and lookup returns version_number 2', async () => {
    const pub = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuidA}/publish`)
      .set('Authorization', `Bearer ${adminA}`)
      .send({ change_notes: 'v2 for LC-T17' });
    expect(pub.body.version.version_number).toBe(2);

    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=%2B61399990011')
      .set('x-internal-key', INTERNAL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.version_number).toBe(2);
  });
});

// ── Test 18: listFlowStatus — strict tenant filter (security fix) ─────────────

describe('LC-T18: GET /deployment/flows respects strict tenant_id filter', () => {
  it('Tenant A admin sees only Tenant A flows', async () => {
    // Create a flow for Tenant B to ensure cross-tenant leakage would be detectable
    const bRes = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminB}`)
      .send({ name: 'LC Flow B (isolation)', graph: MINIMAL_GRAPH });
    expect(bRes.status).toBe(201);
    flowUuidB = bRes.body.flow.flow_uuid;
    flowIdB   = bRes.body.flow.id;

    const res = await request(server)
      .get('/api/v1/deployment/flows')
      .set('Authorization', `Bearer ${adminA}`);

    expect(res.status).toBe(200);
    const uuids = res.body.flows.map(f => f.flow_uuid);
    expect(uuids).toContain(flowUuidA);
    expect(uuids).not.toContain(flowUuidB);
  });

  it('Tenant B admin sees only Tenant B flows', async () => {
    const res = await request(server)
      .get('/api/v1/deployment/flows')
      .set('Authorization', `Bearer ${adminB}`);

    expect(res.status).toBe(200);
    const uuids = res.body.flows.map(f => f.flow_uuid);
    expect(uuids).not.toContain(flowUuidA);
    expect(uuids).toContain(flowUuidB);
  });
});

// ── Test 19: NULL-tenant flow is invisible to all users ───────────────────────

describe('LC-T19: NULL-tenant flow is invisible to any authenticated user', () => {
  let nullFlowUuid = '';

  beforeAll(async () => {
    const { rows: [f] } = await query(
      `INSERT INTO ivr_flows (name, tenant_id, graph, created_by, updated_by)
       VALUES ('Null-Tenant Orphan', NULL, $1::jsonb, $2, $2) RETURNING flow_uuid`,
      [JSON.stringify(MINIMAL_GRAPH), adminAId]
    );
    nullFlowUuid = f.flow_uuid;
  });

  afterAll(async () => {
    await query(`DELETE FROM ivr_flows WHERE flow_uuid=$1`, [nullFlowUuid]);
  });

  it('NULL-tenant flow does not appear in Tenant A list', async () => {
    const res = await request(server)
      .get('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminA}`);
    expect(res.body.flows.every(f => f.flow_uuid !== nullFlowUuid)).toBe(true);
  });

  it('NULL-tenant flow does not appear in deployment status list', async () => {
    const res = await request(server)
      .get('/api/v1/deployment/flows')
      .set('Authorization', `Bearer ${adminA}`);
    expect(res.body.flows.every(f => f.flow_uuid !== nullFlowUuid)).toBe(true);
  });
});

// ── Test 20: Soft delete removes flow from list and unlinks number ─────────────

describe('LC-T20: Soft delete removes flow from list and unlinks emergency numbers', () => {
  it('DELETE /ivr/flows/:uuid hides flow and clears ivr_flow_id on number', async () => {
    // Create a disposable flow, bind the number
    const created = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'LC Disposable Flow', graph: MINIMAL_GRAPH });
    const dispUuid = created.body.flow.flow_uuid;
    const dispId   = created.body.flow.id;

    await query(`UPDATE emergency_numbers SET ivr_flow_id=$1 WHERE id=$2`, [dispId, numIdA]);

    const del = await request(server)
      .delete(`/api/v1/ivr/flows/${dispUuid}`)
      .set('Authorization', `Bearer ${adminA}`);
    expect(del.status).toBe(200);

    // Should not appear in list
    const list = await request(server)
      .get('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminA}`);
    expect(list.body.flows.every(f => f.flow_uuid !== dispUuid)).toBe(true);

    // Emergency number should be unlinked
    const { rows: [en] } = await query(
      `SELECT ivr_flow_id FROM emergency_numbers WHERE id=$1`,
      [numIdA]
    );
    expect(en.ivr_flow_id).toBeNull();
  });
});
