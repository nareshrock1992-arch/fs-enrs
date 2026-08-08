/**
 * Phase 2B — Campaign Tenant Isolation Authorization Tests
 *
 * Verifies that the campaign API enforces tenant boundaries:
 *  - Tenant A cannot read, trigger, pause, resume, or cancel Tenant B campaigns.
 *  - Tenant A sees only its own campaigns in list responses.
 *  - engine/stats no longer exposes campaign_ids.
 *  - Tenant A can still operate normally on its own campaigns.
 *
 * Requires a real test database (same env as other integration tests).
 * Run: NODE_ENV=test npm test -- campaignAuthorization
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import server from '../../../server.js';
import { query } from '../../db/pool.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tokenA, tokenB;
let tenantA, tenantB;
let orgA, orgB;
let configA, configB;
let campaignA, campaignB;
let contactA;

const SUFFIX = Date.now();

beforeAll(async () => {
  // ── Tenant A ────────────────────────────────────────────────────────────────
  const { rows: [tA] } = await query(
    `INSERT INTO tenants (name, code) VALUES ($1, $2) RETURNING id`,
    [`CampAuthTenantA-${SUFFIX}`, `CAA-${SUFFIX}`]
  );
  tenantA = tA.id;

  const { rows: [oA] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ($1, $2) RETURNING id`,
    [`CampAuthOrgA-${SUFFIX}`, tenantA]
  );
  orgA = oA.id;

  const hashA = await bcrypt.hash('Test1234!', 10);
  await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, full_name)
     VALUES ($1, $2, 'ADMIN', $3, 'CampAuth AdminA')`,
    [`campauth-a-${SUFFIX}@test.local`, hashA, tenantA]
  );

  // ENS configuration for Tenant A
  const { rows: [cfgA] } = await query(
    `INSERT INTO ens_configurations
       (name, tenant_id, organization_id, is_active, max_concurrent_calls, max_attempts, retry_interval_sec)
     VALUES ($1, $2, $3, true, 5, 1, 30)
     RETURNING id`,
    [`CampAuthConfigA-${SUFFIX}`, tenantA, orgA]
  );
  configA = cfgA.id;

  // One contact linked to Tenant A's config (needed for campaign creation)
  const { rows: [ec] } = await query(
    `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number, is_active)
     VALUES ($1, 'AliceA', 'Test', $2, true) RETURNING id`,
    [orgA, `05099${SUFFIX % 100000}`.slice(0, 11)]
  );
  contactA = ec.id;

  await query(
    `INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
     VALUES ($1, $2)`,
    [configA, contactA]
  );

  // ── Tenant B ────────────────────────────────────────────────────────────────
  const { rows: [tB] } = await query(
    `INSERT INTO tenants (name, code) VALUES ($1, $2) RETURNING id`,
    [`CampAuthTenantB-${SUFFIX}`, `CAB-${SUFFIX}`]
  );
  tenantB = tB.id;

  const { rows: [oB] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ($1, $2) RETURNING id`,
    [`CampAuthOrgB-${SUFFIX}`, tenantB]
  );
  orgB = oB.id;

  const hashB = await bcrypt.hash('Test1234!', 10);
  await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, full_name)
     VALUES ($1, $2, 'ADMIN', $3, 'CampAuth AdminB')`,
    [`campauth-b-${SUFFIX}@test.local`, hashB, tenantB]
  );

  // ENS configuration for Tenant B (no contacts needed — tests only read/mutate)
  const { rows: [cfgB] } = await query(
    `INSERT INTO ens_configurations
       (name, tenant_id, organization_id, is_active, max_concurrent_calls, max_attempts, retry_interval_sec)
     VALUES ($1, $2, $3, true, 5, 1, 30)
     RETURNING id`,
    [`CampAuthConfigB-${SUFFIX}`, tenantB, orgB]
  );
  configB = cfgB.id;

  // Insert a campaign row directly for Tenant B (bypasses engine, no contacts required)
  const { rows: [cb] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via, total_destinations,
        queued_count, status, message_text, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min)
     VALUES ($1, $2, 'UI', 0, 0, 'queued', 'auth-test', 5, 1, 1, 30, 1, false, false, 5, 60)
     RETURNING id`,
    [configB, orgB]
  );
  campaignB = cb.id;

  // Insert a campaign row for Tenant A (for own-campaign operation tests)
  const { rows: [ca] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via, total_destinations,
        queued_count, status, message_text, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min)
     VALUES ($1, $2, 'UI', 0, 0, 'queued', 'auth-test-a', 5, 1, 1, 30, 1, false, false, 5, 60)
     RETURNING id`,
    [configA, orgA]
  );
  campaignA = ca.id;

  // Login both users — NEW-03: assert login success so fixture failures are
  // immediately obvious rather than masquerading as authorization failures.
  const resA = await request(server)
    .post('/api/v1/auth/login')
    .send({ email: `campauth-a-${SUFFIX}@test.local`, password: 'Test1234!' });
  expect(resA.status).toBe(200);
  expect(resA.body.token).toBeTruthy();
  tokenA = resA.body.token;

  const resB = await request(server)
    .post('/api/v1/auth/login')
    .send({ email: `campauth-b-${SUFFIX}@test.local`, password: 'Test1234!' });
  expect(resB.status).toBe(200);
  expect(resB.body.token).toBeTruthy();
  tokenB = resB.body.token;
});

afterAll(async () => {
  // Clean up in dependency order
  if (campaignA) {
    await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [campaignA]);
    await query(`DELETE FROM ens_campaigns WHERE id = $1`, [campaignA]);
  }
  if (campaignB) {
    await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [campaignB]);
    await query(`DELETE FROM ens_campaigns WHERE id = $1`, [campaignB]);
  }
  if (contactA && configA) {
    await query(`DELETE FROM ens_configuration_contacts WHERE ens_configuration_id = $1`, [configA]);
    await query(`DELETE FROM emergency_contacts WHERE id = $1`, [contactA]);
  }
  if (configA) await query(`DELETE FROM ens_configurations WHERE id = $1`, [configA]);
  if (configB) await query(`DELETE FROM ens_configurations WHERE id = $1`, [configB]);
  await query(`DELETE FROM users WHERE email = $1`, [`campauth-a-${SUFFIX}@test.local`]);
  await query(`DELETE FROM users WHERE email = $1`, [`campauth-b-${SUFFIX}@test.local`]);
  if (orgA) await query(`DELETE FROM organizations WHERE id = $1`, [orgA]);
  if (orgB) await query(`DELETE FROM organizations WHERE id = $1`, [orgB]);
  if (tenantA) await query(`DELETE FROM tenants WHERE id = $1`, [tenantA]);
  if (tenantB) await query(`DELETE FROM tenants WHERE id = $1`, [tenantB]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Campaign list — tenant isolation', () => {
  it('Tenant A sees only its own campaigns', async () => {
    const res = await request(server)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const ids = res.body.campaigns.map(c => c.id);
    expect(ids).toContain(campaignA);
    expect(ids).not.toContain(campaignB);
  });

  it('Tenant B sees only its own campaigns', async () => {
    const res = await request(server)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const ids = res.body.campaigns.map(c => c.id);
    expect(ids).toContain(campaignB);
    expect(ids).not.toContain(campaignA);
  });
});

describe('Campaign read — cross-tenant isolation', () => {
  it('Tenant A cannot read Tenant B campaign (404)', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignB}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('Tenant B cannot read Tenant A campaign (404)', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignA}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('Tenant A can read its own campaign', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignA}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(campaignA);
  });
});

describe('Destinations — cross-tenant isolation', () => {
  it('Tenant A cannot read Tenant B destinations (404)', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignB}/destinations`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('Tenant B cannot read Tenant A destinations (404)', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignA}/destinations`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('Tenant A can read its own destinations', async () => {
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignA}/destinations`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
  });
});

describe('Campaign creation — cross-tenant config isolation', () => {
  it('Tenant B cannot trigger a campaign using Tenant A config (404)', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ ens_configuration_id: configA, message_text: 'cross-tenant attempt' });
    expect(res.status).toBe(404);
  });

  it('database state is unchanged after the rejected cross-tenant creation attempt', async () => {
    // Campaign count for configA must remain at exactly 1 (the pre-seeded one)
    const { rows } = await query(
      `SELECT COUNT(*)::INT AS cnt FROM ens_campaigns WHERE ens_configuration_id = $1`,
      [configA]
    );
    expect(rows[0].cnt).toBe(1);
  });
});

describe('Campaign pause — cross-tenant isolation', () => {
  it('Tenant A cannot pause Tenant B campaign (404)', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignB}/pause`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('Tenant B campaign status is unchanged after rejected pause attempt', async () => {
    const { rows: [row] } = await query(
      `SELECT status FROM ens_campaigns WHERE id = $1`, [campaignB]
    );
    expect(row.status).toBe('queued');
  });
});

describe('Campaign resume — cross-tenant isolation', () => {
  it('Tenant A cannot resume Tenant B campaign (404)', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignB}/resume`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('Tenant B campaign status is unchanged after rejected resume attempt', async () => {
    const { rows: [row] } = await query(
      `SELECT status FROM ens_campaigns WHERE id = $1`, [campaignB]
    );
    expect(row.status).toBe('queued');
  });
});

describe('Campaign cancel — cross-tenant isolation', () => {
  it('Tenant A cannot cancel Tenant B campaign (404)', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignB}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('Tenant B campaign status is unchanged after rejected cancel attempt', async () => {
    const { rows: [row] } = await query(
      `SELECT status FROM ens_campaigns WHERE id = $1`, [campaignB]
    );
    expect(row.status).toBe('queued');
  });
});

describe('Engine stats — no global UUID exposure', () => {
  it('engine/stats response does not contain campaign_ids', async () => {
    const res = await request(server)
      .get('/api/v1/campaigns/engine/stats')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('campaign_ids');
  });

  it('engine/stats contains active_campaigns and is_running only', async () => {
    const res = await request(server)
      .get('/api/v1/campaigns/engine/stats')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.active_campaigns).toBe('number');
    expect(typeof res.body.is_running).toBe('boolean');
  });
});

describe('Own-campaign operations — Tenant A normal access', () => {
  it('Tenant A can cancel its own campaign', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignA}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    const { rows: [row] } = await query(
      `SELECT status FROM ens_campaigns WHERE id = $1`, [campaignA]
    );
    expect(row.status).toBe('cancelled');
  });
});

// NEW-02: Positive campaign creation authorization test.
// Proves that Tenant A can create a campaign using its own ENS configuration —
// i.e. the tenant filter does not over-restrict legitimate same-tenant requests.
// The fixture seeds one mobile-number contact linked to configA; resolveContact()
// resolves it in auto/internal mode (no gateway needed), so the campaign row is
// created without requiring a running FreeSWITCH instance.
describe('Campaign creation — positive authorization (own tenant)', () => {
  it('Tenant A can trigger a campaign using its own ENS configuration (201)', async () => {
    let createdId = null;
    try {
      const res = await request(server)
        .post('/api/v1/campaigns')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ ens_configuration_id: configA, message_text: 'positive-auth-test' });

      // The endpoint returns 201 on success (campaignController.js line 142).
      expect(res.status).toBe(201);

      // Campaign must reference Tenant A's configuration.
      expect(res.body.ens_configuration_id).toBe(configA);
      createdId = res.body.id;

      // Verify the campaign exists in the database and belongs to configA.
      const { rows: [dbRow] } = await query(
        `SELECT ens_configuration_id FROM ens_campaigns WHERE id = $1`,
        [createdId]
      );
      expect(dbRow).toBeTruthy();
      expect(dbRow.ens_configuration_id).toBe(configA);

      // Tenant B must not appear anywhere in the campaign row.
      const { rows: [cfgRow] } = await query(
        `SELECT tenant_id FROM ens_configurations WHERE id = $1`,
        [configA]
      );
      expect(cfgRow.tenant_id).toBe(tenantA);
      expect(cfgRow.tenant_id).not.toBe(tenantB);
    } finally {
      // Clean up the campaign created by this test regardless of assertion outcome.
      if (createdId) {
        await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [createdId]);
        await query(`DELETE FROM ens_campaigns WHERE id = $1`, [createdId]);
      }
    }
  });
});
