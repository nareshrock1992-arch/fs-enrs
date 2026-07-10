/**
 * Sprint B3 — IVR Flow Engine Integration Tests
 *
 * Tests public API (JWT) and internal API (X-Internal-Key) for IVR flows.
 * Runs sequentially (singleFork: true) to avoid DB race conditions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import server from '../../../server.js';
import { query } from '../../db/pool.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';
let adminToken   = '';
let viewerToken  = '';
let tenantId     = null;
let orgId        = null;
let adminUserId  = null;
let flowUuid     = '';
let flowId       = null;
let emergNumId   = null;

// ── Simple graph fixtures ─────────────────────────────────────────────────────

const VALID_GRAPH = {
  entry_node_id: 'node_1',
  nodes: {
    node_1: { type: 'play', audio_url: '/media/welcome.wav', next: 'node_2' },
    node_2: {
      type: 'gather',
      max_digits: 1,
      timeout_seconds: 5,
      branches: { '1': 'node_3', timeout: 'node_4', invalid: 'node_4' },
    },
    node_3: { type: 'hangup' },
    node_4: { type: 'hangup' },
  },
};

const CYCLIC_GRAPH = {
  entry_node_id: 'node_a',
  nodes: {
    node_a: { type: 'say', text: 'Hello', next: 'node_b' },
    node_b: { type: 'say', text: 'World', next: 'node_a' }, // cycle
  },
};

const DANGLING_GRAPH = {
  entry_node_id: 'node_1',
  nodes: {
    node_1: { type: 'play', audio_url: '/media/test.wav', next: 'node_99' }, // node_99 missing
  },
};

// ── Seed + teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create tenant
  const t = await query(
    `INSERT INTO tenants (name, code) VALUES ('IVR Test Tenant', $1) RETURNING id`,
    [`ivr-test-${Date.now()}`]
  );
  tenantId = t.rows[0].id;

  // Create org
  const o = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('IVR Test Org', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.rows[0].id;

  // Admin user
  const hash = await bcrypt.hash('Admin1234!', 12);
  const u = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ('ivr-admin@test.local', $1, 'ADMIN', $2, true, 'IVR Admin') RETURNING id`,
    [hash, tenantId]
  );
  adminUserId = u.rows[0].id;

  const viewerHash = await bcrypt.hash('Viewer1234!', 12);
  await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ('ivr-viewer@test.local', $1, 'VIEWER', $2, true, 'IVR Viewer') RETURNING id`,
    [viewerHash, tenantId]
  );

  // Emergency number (unbound initially)
  const en = await query(
    `INSERT INTO emergency_numbers (number, type, tenant_id)
     VALUES ('+61299990099', 'ENS', $1) RETURNING id`,
    [tenantId]
  );
  emergNumId = en.rows[0].id;

  // Login
  const adminRes = await request(server)
    .post('/api/v1/auth/login')
    .send({ email: 'ivr-admin@test.local', password: 'Admin1234!' });
  adminToken = adminRes.body.token;

  const viewerRes = await request(server)
    .post('/api/v1/auth/login')
    .send({ email: 'ivr-viewer@test.local', password: 'Viewer1234!' });
  viewerToken = viewerRes.body.token;
});

afterAll(async () => {
  if (flowId)    await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id = $1`, [flowId]);
  if (flowId)    await query(`DELETE FROM ivr_flows WHERE id = $1`, [flowId]);
  if (emergNumId) await query(`DELETE FROM emergency_numbers WHERE id = $1`, [emergNumId]);
  if (orgId)     await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
  if (tenantId)  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe('IVR auth guards', () => {
  it('GET /ivr/flows → 401 without token', async () => {
    const res = await request(server).get('/api/v1/ivr/flows');
    expect(res.status).toBe(401);
  });

  it('POST /ivr/flows → 403 for VIEWER role', async () => {
    const res = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Viewer should not create' });
    expect(res.status).toBe(403);
  });
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

describe('IVR CRUD', () => {
  it('POST /ivr/flows → creates flow', async () => {
    const res = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test IVR Flow', description: 'B3 integration test', organization_id: orgId });

    expect(res.status).toBe(201);
    expect(res.body.flow.name).toBe('Test IVR Flow');
    expect(res.body.flow.flow_uuid).toBeTruthy();
    flowUuid = res.body.flow.flow_uuid;
    flowId   = res.body.flow.id;
  });

  it('POST /ivr/flows → 400 if name missing', async () => {
    const res = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'No name' });
    expect(res.status).toBe(400);
  });

  it('GET /ivr/flows → lists flows (VIEWER can read)', async () => {
    const res = await request(server)
      .get('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flows)).toBe(true);
    expect(res.body.flows.some(f => f.flow_uuid === flowUuid)).toBe(true);
  });

  it('GET /ivr/flows/:uuid → returns flow detail', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.flow.flow_uuid).toBe(flowUuid);
    expect(res.body.flow.bound_numbers).toEqual([]);
    expect(res.body.flow.latest_version).toBeNull();
  });

  it('GET /ivr/flows/nonexistent → 404', async () => {
    const res = await request(server)
      .get('/api/v1/ivr/flows/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /ivr/flows/:uuid → updates name and graph', async () => {
    const res = await request(server)
      .put(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated IVR', graph: VALID_GRAPH });
    expect(res.status).toBe(200);
    expect(res.body.flow.name).toBe('Updated IVR');
  });

  it('PUT /ivr/flows/:uuid → 400 for cyclic graph', async () => {
    const res = await request(server)
      .put(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graph: CYCLIC_GRAPH });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.includes('never reach an end of call'))).toBe(true);
  });

  it('PUT /ivr/flows/:uuid → 400 for dangling ref', async () => {
    const res = await request(server)
      .put(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graph: DANGLING_GRAPH });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.includes('node_99'))).toBe(true);
  });
});

// ── Validate endpoint ─────────────────────────────────────────────────────────

describe('IVR validate', () => {
  it('POST /ivr/flows/:uuid/validate → valid graph passes', async () => {
    // Ensure the flow has VALID_GRAPH first
    await request(server)
      .put(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graph: VALID_GRAPH });

    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuid}/validate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.stats.node_count).toBe(4);
  });

  it('POST /ivr/flows/:uuid/validate → candidate graph checked without saving', async () => {
    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuid}/validate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graph: CYCLIC_GRAPH });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some(e => e.includes('never reach an end of call'))).toBe(true);
  });
});

// ── Publish ───────────────────────────────────────────────────────────────────

describe('IVR publish', () => {
  it('POST /ivr/flows/:uuid/publish → publishes v1', async () => {
    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuid}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ change_notes: 'Initial publish from B3 test' });
    expect(res.status).toBe(201);
    expect(res.body.version.version_number).toBe(1);
    expect(res.body.version.graph).toBeTruthy();
  });

  it('POST /ivr/flows/:uuid/publish → publishes v2 after edit', async () => {
    await request(server)
      .put(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated for v2' });

    const res = await request(server)
      .post(`/api/v1/ivr/flows/${flowUuid}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ change_notes: 'Second publish' });
    expect(res.status).toBe(201);
    expect(res.body.version.version_number).toBe(2);
  });

  it('GET /ivr/flows/:uuid/versions → lists both versions', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuid}/versions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.versions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.versions[0].version_number).toBe(2); // descending
  });

  it('GET /ivr/flows/:uuid/versions/1 → returns v1 frozen graph', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuid}/versions/1`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.version.version_number).toBe(1);
    expect(res.body.version.graph.entry_node_id).toBe('node_1');
  });

  it('GET /ivr/flows/:uuid/versions/999 → 404', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuid}/versions/999`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('POST publish → 400 if graph is empty', async () => {
    const { rows: [tempFlow] } = await query(
      `INSERT INTO ivr_flows (name, tenant_id, graph, created_by, updated_by)
       VALUES ('Empty', $1, '{"entry_node_id":"","nodes":{}}', $2, $2) RETURNING flow_uuid`,
      [tenantId, adminUserId]
    );
    const res = await request(server)
      .post(`/api/v1/ivr/flows/${tempFlow.flow_uuid}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    await query(`DELETE FROM ivr_flows WHERE flow_uuid = $1`, [tempFlow.flow_uuid]);
  });
});

// ── Number binding ────────────────────────────────────────────────────────────

describe('IVR number binding', () => {
  it('PATCH /ivr/flows/:uuid/bind → binds emergency number', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuid}/bind`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ emergency_number_id: emergNumId });
    expect(res.status).toBe(200);
    expect(res.body.number.id).toBe(emergNumId);
  });

  it('GET /ivr/flows/:uuid → bound_numbers includes the bound number', async () => {
    const res = await request(server)
      .get(`/api/v1/ivr/flows/${flowUuid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.flow.bound_numbers.some(n => n.id === emergNumId)).toBe(true);
  });

  it('PATCH /ivr/flows/:uuid/bind → 404 if number from wrong tenant', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuid}/bind`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ emergency_number_id: 99999999 });
    expect(res.status).toBe(404);
  });

  it('PATCH /ivr/flows/:uuid/unbind → unbinds number', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuid}/unbind`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ emergency_number_id: emergNumId });
    expect(res.status).toBe(200);
  });

  it('PATCH unbind → 404 if number not bound', async () => {
    const res = await request(server)
      .patch(`/api/v1/ivr/flows/${flowUuid}/unbind`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ emergency_number_id: emergNumId });
    expect(res.status).toBe(404);
  });
});

// ── Internal API — Lua lookup ─────────────────────────────────────────────────

describe('IVR internal lookup', () => {
  beforeAll(async () => {
    // Re-bind number so lookup can find it
    await query(
      `UPDATE emergency_numbers SET ivr_flow_id = $1 WHERE id = $2`,
      [flowId, emergNumId]
    );
  });

  afterAll(async () => {
    await query(
      `UPDATE emergency_numbers SET ivr_flow_id = NULL WHERE id = $1`,
      [emergNumId]
    );
  });

  it('GET /internal/ivr/lookup → 403 without X-Internal-Key', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=+61299990099');
    expect(res.status).toBe(403);
  });

  it('GET /internal/ivr/lookup → 400 without number param', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup')
      .set('x-internal-key', INTERNAL_KEY);
    expect(res.status).toBe(400);
  });

  it('GET /internal/ivr/lookup → returns published graph for bound number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=%2B61299990099')
      .set('x-internal-key', INTERNAL_KEY);
    expect(res.status).toBe(200);
    expect(res.body.flow_uuid).toBe(flowUuid);
    expect(res.body.entry_node_id).toBe('node_1');
    expect(typeof res.body.nodes).toBe('object');
    expect(res.body.version_number).toBeGreaterThanOrEqual(1);
  });

  it('GET /internal/ivr/lookup → 404 for unbound number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=%2B61200000000')
      .set('x-internal-key', INTERNAL_KEY);
    expect(res.status).toBe(404);
  });

  it('GET /internal/ivr/lookup → 400 for invalid number format', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ivr/lookup?number=INVALID')
      .set('x-internal-key', INTERNAL_KEY);
    expect(res.status).toBe(400);
  });
});

// ── Soft delete ───────────────────────────────────────────────────────────────

describe('IVR soft delete', () => {
  let tempUuid = '';

  it('DELETE /ivr/flows/:uuid → soft-deletes and unbinds numbers', async () => {
    // Create a temp flow and bind the number
    const created = await request(server)
      .post('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Temp Delete Flow' });
    tempUuid = created.body.flow.flow_uuid;
    const tempId = created.body.flow.id;

    await query(
      `UPDATE emergency_numbers SET ivr_flow_id = $1 WHERE id = $2`,
      [tempId, emergNumId]
    );

    const del = await request(server)
      .delete(`/api/v1/ivr/flows/${tempUuid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    // emergency_number should now have ivr_flow_id = NULL
    const { rows: [en] } = await query(
      `SELECT ivr_flow_id FROM emergency_numbers WHERE id = $1`,
      [emergNumId]
    );
    expect(en.ivr_flow_id).toBeNull();

    // Flow should no longer appear in list
    const list = await request(server)
      .get('/api/v1/ivr/flows')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.flows.some(f => f.flow_uuid === tempUuid)).toBe(false);
  });
});
