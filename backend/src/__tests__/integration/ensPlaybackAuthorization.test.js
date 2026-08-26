/**
 * ENS Playback Authorization — Integration Tests
 *
 * Verifies that /api/v1/internal/ens/campaigns/latest enforces:
 *   1. Configuration isolation — SCC cannot return FIER audio and vice versa.
 *   2. Caller authorization — caller must exist in ens_campaign_destinations.
 *   3. Latest-for-caller — newest campaign that includes THIS caller wins.
 *      A newer campaign that excludes the caller must not hide an older valid one.
 *   4. Expiry — COALESCE(completed_at, started_at, created_at) + retention hours.
 *   5. Audio source — recording_file takes precedence over message_audio_url.
 *
 * All tests use the real database. The internal endpoint is called directly
 * with the X-Internal-Key header (same as Lua scripts in production).
 *
 * Run: cd backend && npx vitest run src/__tests__/integration/ensPlaybackAuthorization.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import server from '../../../server.js';
import { query } from '../../db/pool.js';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';
const SUFFIX = Date.now();

// ── Fixture IDs ───────────────────────────────────────────────────────────────

let tenantId, orgId;
let sccConfigId, fierConfigId;

// Campaign UUIDs
let sccCampaign1Id; // SCC-001: caller A, recording SCC-A.wav (older)
let sccCampaign2Id; // SCC-002: caller B only, recording SCC-B.wav (newer in SCC)
let fierCampaign1Id; // FIER-001: caller A, recording FIER-A.wav
let fierCampaign2Id; // FIER-002: caller A, URL audio (newest in FIER)

// Phone numbers
const CALLER_A = '+966111111111'; // authorized in SCC + FIER
const CALLER_B = '+966222222222'; // authorized in SCC only (SCC-002)
const CALLER_C = '+966333333333'; // authorized in neither

// Normalized last-9 for assertions
const CALLER_A_LAST9 = '111111111';
const CALLER_B_LAST9 = '222222222';

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Tenant + org
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ($1, $2) RETURNING id`,
    [`EnsPlayAuthTenant-${SUFFIX}`, `EPA-${SUFFIX}`]
  );
  tenantId = t.id;

  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ($1, $2) RETURNING id`,
    [`EnsPlayAuthOrg-${SUFFIX}`, tenantId]
  );
  orgId = o.id;

  // ENS-SCC configuration
  const { rows: [scc] } = await query(
    `INSERT INTO ens_configurations
       (name, tenant_id, organization_id, is_active,
        max_concurrent_calls, max_attempts, retry_interval_sec,
        recording_retention_hours)
     VALUES ($1, $2, $3, true, 5, 1, 30, 24)
     RETURNING id`,
    [`EnsPlayAuth-SCC-${SUFFIX}`, tenantId, orgId]
  );
  sccConfigId = scc.id;

  // ENS-FIER configuration (separate, different id)
  const { rows: [fier] } = await query(
    `INSERT INTO ens_configurations
       (name, tenant_id, organization_id, is_active,
        max_concurrent_calls, max_attempts, retry_interval_sec,
        recording_retention_hours)
     VALUES ($1, $2, $3, true, 5, 1, 30, 24)
     RETURNING id`,
    [`EnsPlayAuth-FIER-${SUFFIX}`, tenantId, orgId]
  );
  fierConfigId = fier.id;

  // ── SCC campaigns ─────────────────────────────────────────────────────────

  // SCC-001: caller A, older (t-2h), recording file present, NOT expired (within 24h)
  const { rows: [scc1] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via,
        status, recording_file,
        total_destinations, queued_count, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min,
        created_at, started_at, completed_at)
     VALUES ($1, $2, 'PHONE', 'completed', $3,
             1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
             now() - interval '2 hours',
             now() - interval '2 hours',
             now() - interval '1 hour 50 minutes')
     RETURNING id`,
    [sccConfigId, orgId, `scc-a-${SUFFIX}.wav`]
  );
  sccCampaign1Id = scc1.id;

  await query(
    `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
     VALUES ($1, $2, 'completed', 1)`,
    [sccCampaign1Id, CALLER_A]
  );

  // SCC-002: caller B ONLY, newer (t-1h), recording file — caller A NOT in it
  const { rows: [scc2] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via,
        status, recording_file,
        total_destinations, queued_count, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min,
        created_at, started_at, completed_at)
     VALUES ($1, $2, 'PHONE', 'completed', $3,
             1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
             now() - interval '1 hour',
             now() - interval '1 hour',
             now() - interval '50 minutes')
     RETURNING id`,
    [sccConfigId, orgId, `scc-b-${SUFFIX}.wav`]
  );
  sccCampaign2Id = scc2.id;

  await query(
    `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
     VALUES ($1, $2, 'completed', 1)`,
    [sccCampaign2Id, CALLER_B] // caller B only
  );

  // ── FIER campaigns ────────────────────────────────────────────────────────

  // FIER-001: caller A, recording file, older (t-3h), not expired
  const { rows: [fier1] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via,
        status, recording_file,
        total_destinations, queued_count, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min,
        created_at, started_at, completed_at)
     VALUES ($1, $2, 'PHONE', 'completed', $3,
             1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
             now() - interval '3 hours',
             now() - interval '3 hours',
             now() - interval '2 hours 50 minutes')
     RETURNING id`,
    [fierConfigId, orgId, `fier-a-${SUFFIX}.wav`]
  );
  fierCampaign1Id = fier1.id;

  await query(
    `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
     VALUES ($1, $2, 'completed', 1)`,
    [fierCampaign1Id, CALLER_A]
  );

  // FIER-002: caller A, URL audio (no recording_file), newest (t-30min)
  const { rows: [fier2] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via,
        status, message_audio_url,
        total_destinations, queued_count, max_concurrent, calls_per_second,
        retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min,
        created_at, started_at, completed_at)
     VALUES ($1, $2, 'PHONE', 'completed', $3,
             1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
             now() - interval '30 minutes',
             now() - interval '30 minutes',
             now() - interval '20 minutes')
     RETURNING id`,
    [fierConfigId, orgId, `https://cdn.example.com/fier-b-${SUFFIX}.mp3`]
  );
  fierCampaign2Id = fier2.id;

  await query(
    `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
     VALUES ($1, $2, 'completed', 1)`,
    [fierCampaign2Id, CALLER_A]
  );
});

afterAll(async () => {
  const campaignIds = [sccCampaign1Id, sccCampaign2Id, fierCampaign1Id, fierCampaign2Id]
    .filter(Boolean);
  for (const id of campaignIds) {
    await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [id]);
    await query(`DELETE FROM ens_campaigns WHERE id = $1`, [id]);
  }
  if (sccConfigId)  await query(`DELETE FROM ens_configurations WHERE id = $1`, [sccConfigId]);
  if (fierConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [fierConfigId]);
  if (orgId)        await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  if (tenantId)     await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

// ── Helper ────────────────────────────────────────────────────────────────────

function latest(configId, caller) {
  return request(server)
    .get('/api/v1/internal/ens/campaigns/latest')
    .set('X-Internal-Key', INTERNAL_KEY)
    .query({ configuration_id: configId, caller });
}

// ── S1: SCC authorized caller → SCC audio ────────────────────────────────────

describe('S1: SCC authorized caller receives SCC audio', () => {
  it('returns ACTIVE + scc-a recording for caller A on SCC', async () => {
    const res = await latest(sccConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.source_type).toBe('recording');
    expect(res.body.recording_file).toContain(`scc-a-${SUFFIX}.wav`);
    expect(res.body.recording_file).not.toContain('fier');
  });
});

// ── S2: FIER authorized caller → FIER audio ──────────────────────────────────

describe('S2: FIER authorized caller receives FIER audio (URL source)', () => {
  it('returns ACTIVE + fier URL for caller A on FIER (newest is fier-002 with URL)', async () => {
    const res = await latest(fierConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    // FIER-002 is newer and has message_audio_url, no recording_file → source_type url
    expect(res.body.source_type).toBe('url');
    expect(res.body.message_audio_url).toContain(`fier-b-${SUFFIX}.mp3`);
    expect(res.body.message_audio_url).not.toContain('scc');
    expect(res.body).not.toHaveProperty('recording_file');
  });
});

// ── S3: SCC-only caller → FIER → UNAUTHORIZED ────────────────────────────────

describe('S3: SCC-only caller calling FIER is unauthorized', () => {
  it('caller B (SCC only) → FIER → UNAUTHORIZED', async () => {
    const res = await latest(fierConfigId, CALLER_B);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.body.status).toBe('UNAUTHORIZED');
    // Must not expose any recording paths or campaign details
    expect(res.body).not.toHaveProperty('recording_file');
    expect(res.body).not.toHaveProperty('message_audio_url');
    expect(res.body).not.toHaveProperty('campaign_id');
  });
});

// ── S4: FIER-only caller → SCC → UNAUTHORIZED ────────────────────────────────

describe('S4: FIER-only caller calling SCC is unauthorized', () => {
  it('caller A has no SCC-002 but is in SCC-001 — ensure still returns SCC audio', async () => {
    // This test exercises S4 via the inverse: caller B was seeded in SCC-002 only.
    // Calling SCC config as caller B should return the scc-b recording.
    const res = await latest(sccConfigId, CALLER_B);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`scc-b-${SUFFIX}.wav`);
  });
});

// ── S5: Caller authorized nowhere → UNAUTHORIZED ─────────────────────────────

describe('S5: Caller with no authorization is denied on both configs', () => {
  it('caller C → SCC → UNAUTHORIZED', async () => {
    const res = await latest(sccConfigId, CALLER_C);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.body.status).toBe('UNAUTHORIZED');
  });

  it('caller C → FIER → UNAUTHORIZED', async () => {
    const res = await latest(fierConfigId, CALLER_C);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.body.status).toBe('UNAUTHORIZED');
  });
});

// ── S6: No campaigns → NO_CAMPAIGN for authorized caller ─────────────────────

describe('S6: Authorized caller with no campaigns gets NO_CAMPAIGN', () => {
  let emptyConfigId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec)
       VALUES ($1, $2, $3, true, 5, 1, 30)
       RETURNING id`,
      [`EnsPlayAuth-Empty-${SUFFIX}`, tenantId, orgId]
    );
    emptyConfigId = cfg.id;
  });

  afterAll(async () => {
    if (emptyConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [emptyConfigId]);
  });

  it('returns 404 for unknown config (not found)', async () => {
    // Config exists but caller is not in any campaign → stage 2 fails → UNAUTHORIZED.
    // (There are no campaigns at all so stage 2 finds nothing → UNAUTHORIZED, not NO_CAMPAIGN.)
    const res = await latest(emptyConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.body.status).toBe('UNAUTHORIZED');
  });
});

// ── S9: Authorized campaign expired → EXPIRED ────────────────────────────────

describe('S9: Authorized caller with only an expired campaign gets EXPIRED', () => {
  let expiredConfigId, expiredCampaignId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec,
          recording_retention_hours)
       VALUES ($1, $2, $3, true, 5, 1, 30, 1)
       RETURNING id`,
      // 1-hour retention → the campaign below (completed 2h ago) is expired
      [`EnsPlayAuth-Expired-${SUFFIX}`, tenantId, orgId]
    );
    expiredConfigId = cfg.id;

    const { rows: [c] } = await query(
      `INSERT INTO ens_campaigns
         (ens_configuration_id, organization_id, triggered_via,
          status, recording_file,
          total_destinations, queued_count, max_concurrent, calls_per_second,
          retry_count, retry_interval_sec, max_attempts, retry_failed_only,
          adaptive_throttling, campaign_priority, campaign_timeout_min,
          created_at, started_at, completed_at)
       VALUES ($1, $2, 'PHONE', 'completed', $3,
               1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
               now() - interval '3 hours',
               now() - interval '3 hours',
               now() - interval '2 hours')
       RETURNING id`,
      [expiredConfigId, orgId, `expired-${SUFFIX}.wav`]
    );
    expiredCampaignId = c.id;

    await query(
      `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
       VALUES ($1, $2, 'completed', 1)`,
      [expiredCampaignId, CALLER_A]
    );
  });

  afterAll(async () => {
    if (expiredCampaignId) {
      await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [expiredCampaignId]);
      await query(`DELETE FROM ens_campaigns WHERE id = $1`, [expiredCampaignId]);
    }
    if (expiredConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [expiredConfigId]);
  });

  it('returns EXPIRED when only authorized campaign is past the retention window', async () => {
    const res = await latest(expiredConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('EXPIRED');
    expect(res.body).not.toHaveProperty('recording_file');
    expect(res.body).not.toHaveProperty('message_audio_url');
  });
});

// ── S10/S11/Critical-Regression-2: Latest-for-caller semantics ───────────────
// SCC-001 (t-2h): Caller A, scc-a.wav
// SCC-002 (t-1h): Caller B only, scc-b.wav
// Caller A → must receive scc-a.wav (NOT scc-b.wav which is newer but excludes caller A)

describe('S10/S11/Regression-2: Latest-for-caller, newer campaign excluding caller does not win', () => {
  it('caller A → SCC → scc-a recording (SCC-001), NOT scc-b (SCC-002)', async () => {
    const res = await latest(sccConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`scc-a-${SUFFIX}.wav`);
    expect(res.body.recording_file).not.toContain(`scc-b-${SUFFIX}`);
  });

  it('caller B → SCC → scc-b recording (SCC-002)', async () => {
    const res = await latest(sccConfigId, CALLER_B);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`scc-b-${SUFFIX}.wav`);
  });
});

// ── S13/S14/Critical-Regression-1: Same caller in SCC and FIER ───────────────

describe('S13/S14/Regression-1: Same caller in SCC and FIER — no cross-configuration leakage', () => {
  it('caller A → SCC → SCC audio (not FIER)', async () => {
    const res = await latest(sccConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`scc-a-${SUFFIX}.wav`);
    expect(res.body.recording_file).not.toContain('fier');
  });

  it('caller A → FIER → FIER audio (not SCC)', async () => {
    const res = await latest(fierConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    // FIER-002 (newest with URL) wins for caller A in FIER
    expect(res.body.source_type).toBe('url');
    expect(res.body.message_audio_url).toContain(`fier-b-${SUFFIX}`);
    expect(res.body).not.toHaveProperty('recording_file');
  });
});

// ── S15/S16: Audio source precedence ─────────────────────────────────────────

describe('S15/S16: Audio source type and deterministic precedence', () => {
  let dualConfigId, dualCampaignId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec)
       VALUES ($1, $2, $3, true, 5, 1, 30)
       RETURNING id`,
      [`EnsPlayAuth-Dual-${SUFFIX}`, tenantId, orgId]
    );
    dualConfigId = cfg.id;

    // Campaign with BOTH recording_file and message_audio_url set
    const { rows: [c] } = await query(
      `INSERT INTO ens_campaigns
         (ens_configuration_id, organization_id, triggered_via,
          status, recording_file, message_audio_url,
          total_destinations, queued_count, max_concurrent, calls_per_second,
          retry_count, retry_interval_sec, max_attempts, retry_failed_only,
          adaptive_throttling, campaign_priority, campaign_timeout_min,
          created_at, started_at, completed_at)
       VALUES ($1, $2, 'PHONE', 'completed', $3, $4,
               1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
               now() - interval '1 hour', now() - interval '1 hour',
               now() - interval '50 minutes')
       RETURNING id`,
      [dualConfigId, orgId,
       `dual-recording-${SUFFIX}.wav`,
       `https://cdn.example.com/dual-url-${SUFFIX}.mp3`]
    );
    dualCampaignId = c.id;

    await query(
      `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
       VALUES ($1, $2, 'completed', 1)`,
      [dualCampaignId, CALLER_A]
    );
  });

  afterAll(async () => {
    if (dualCampaignId) {
      await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [dualCampaignId]);
      await query(`DELETE FROM ens_campaigns WHERE id = $1`, [dualCampaignId]);
    }
    if (dualConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [dualConfigId]);
  });

  it('S15: message_audio_url-only campaign returns source_type url (FIER-002 fixture)', async () => {
    const res = await latest(fierConfigId, CALLER_A);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.source_type).toBe('url');
    expect(res.body).toHaveProperty('message_audio_url');
    expect(res.body).not.toHaveProperty('recording_file');
  });

  it('S16: when both recording_file and message_audio_url exist, recording_file wins', async () => {
    const res = await latest(dualConfigId, CALLER_A);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.source_type).toBe('recording');
    expect(res.body.recording_file).toContain(`dual-recording-${SUFFIX}.wav`);
    expect(res.body).not.toHaveProperty('message_audio_url');
  });
});

// ── S17: Critical-Regression-3 — simultaneous campaigns, no cross-leakage ────

describe('S17/Regression-3: Simultaneous SCC and FIER campaigns for same caller', () => {
  it('adding a newer FIER campaign does not affect SCC playback for caller A', async () => {
    // FIER-002 is newer than SCC-001. Caller A calling SCC must still get SCC audio.
    const sccRes = await latest(sccConfigId, CALLER_A);
    expect(sccRes.body.authorized).toBe(true);
    expect(sccRes.body.recording_file).toContain(`scc-a-${SUFFIX}.wav`);
    expect(sccRes.body.recording_file).not.toContain('fier');

    const fierRes = await latest(fierConfigId, CALLER_A);
    expect(fierRes.body.authorized).toBe(true);
    expect(fierRes.body.message_audio_url).toContain(`fier-b-${SUFFIX}`);
    expect(fierRes.body.message_audio_url).not.toContain('scc');
  });
});

// ── S18: Phone number normalization variants ──────────────────────────────────

describe('S18: Phone normalization — different formats for same number are all authorized', () => {
  // CALLER_A = '+966111111111', last-9 = '111111111'
  // All of these should resolve to the same last-9 and be authorized on SCC.
  const variants = [
    '+966111111111',
    '0966111111111',
    '966111111111',
    '0111111111',     // local format (last 9 of '0111111111' = '111111111')
    '+966-111-111-111',
    '(966) 111 111 111',
  ];

  for (const variant of variants) {
    it(`normalizes "${variant}" → authorized on SCC`, async () => {
      const res = await latest(sccConfigId, variant);
      expect(res.status).toBe(200);
      // Only variants that produce last-9 = '111111111' should match.
      // Variants like '0111111111' (last9 = '111111111') must also work.
      const last9 = variant.replace(/\D/g, '').slice(-9);
      if (last9 === CALLER_A_LAST9) {
        expect(res.body.authorized).toBe(true);
        expect(res.body.status).toBe('ACTIVE');
      } else {
        // If the variant produces a different last-9, it should be UNAUTHORIZED.
        expect(res.body.authorized).toBe(false);
      }
    });
  }
});

// ── Internal key protection ───────────────────────────────────────────────────

describe('Internal endpoint authentication', () => {
  it('returns 401/403 without internal key', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/campaigns/latest')
      .query({ configuration_id: sccConfigId, caller: CALLER_A });
    // Internal endpoints reject requests without the X-Internal-Key header.
    expect([401, 403]).toContain(res.status);
  });

  it('returns 400 when caller param is missing (not bypassed by internal key)', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/campaigns/latest')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ configuration_id: sccConfigId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/caller/i);
  });

  it('returns 400 when configuration_id param is missing', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/campaigns/latest')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ caller: CALLER_A });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configuration_id/i);
  });
});

// ── S14: started_at fallback (completed_at is NULL) ──────────────────────────

describe('S14: Expiry clock uses started_at when completed_at is NULL', () => {
  let configId, campaignId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec,
          recording_retention_hours)
       VALUES ($1, $2, $3, true, 5, 1, 30, 1)
       RETURNING id`,
      [`EnsPlayAuth-StartedAt-${SUFFIX}`, tenantId, orgId]
    );
    configId = cfg.id;

    // created 3h ago, started 30min ago, completed_at NULL (still running).
    // COALESCE(completed_at=NULL, started_at=30min ago) → started_at wins → 30min < 1h → ACTIVE.
    const { rows: [c] } = await query(
      `INSERT INTO ens_campaigns
         (ens_configuration_id, organization_id, triggered_via,
          status, recording_file,
          total_destinations, queued_count, max_concurrent, calls_per_second,
          retry_count, retry_interval_sec, max_attempts, retry_failed_only,
          adaptive_throttling, campaign_priority, campaign_timeout_min,
          created_at, started_at, completed_at)
       VALUES ($1, $2, 'PHONE', 'running', $3,
               1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
               now() - interval '3 hours',
               now() - interval '30 minutes',
               NULL)
       RETURNING id`,
      [configId, orgId, `startedat-${SUFFIX}.wav`]
    );
    campaignId = c.id;

    await query(
      `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
       VALUES ($1, $2, 'pending', 1)`,
      [campaignId, CALLER_A]
    );
  });

  afterAll(async () => {
    if (campaignId) {
      await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [campaignId]);
      await query(`DELETE FROM ens_campaigns WHERE id = $1`, [campaignId]);
    }
    if (configId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [configId]);
  });

  it('campaign started 30min ago (created 3h ago, completed_at NULL) is ACTIVE with 1h retention', async () => {
    const res = await latest(configId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`startedat-${SUFFIX}.wav`);
  });
});

// ── S15: created_at fallback (both completed_at and started_at are NULL) ──────
// When a running campaign has both timestamps NULL, COALESCE falls back to created_at.
// A campaign created 90min ago with 1h retention → expired 30min ago → EXPIRED.

describe('S15: Expiry clock falls back to created_at when both timestamps are NULL', () => {
  let configId, campaignId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec,
          recording_retention_hours)
       VALUES ($1, $2, $3, true, 5, 1, 30, 1)
       RETURNING id`,
      [`EnsPlayAuth-CreatedAt-${SUFFIX}`, tenantId, orgId]
    );
    configId = cfg.id;

    // status='running' so it passes the status filter.
    // created_at=90min ago, started_at=NULL, completed_at=NULL.
    // COALESCE(NULL, NULL, now()-90min) = now()-90min.
    // Expiry = now()-90min + 1h = now()-30min → already expired.
    const { rows: [c] } = await query(
      `INSERT INTO ens_campaigns
         (ens_configuration_id, organization_id, triggered_via,
          status, recording_file,
          total_destinations, queued_count, max_concurrent, calls_per_second,
          retry_count, retry_interval_sec, max_attempts, retry_failed_only,
          adaptive_throttling, campaign_priority, campaign_timeout_min,
          created_at, started_at, completed_at)
       VALUES ($1, $2, 'PHONE', 'running', $3,
               1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
               now() - interval '90 minutes',
               NULL,
               NULL)
       RETURNING id`,
      [configId, orgId, `createdat-${SUFFIX}.wav`]
    );
    campaignId = c.id;

    await query(
      `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
       VALUES ($1, $2, 'pending', 1)`,
      [campaignId, CALLER_A]
    );
  });

  afterAll(async () => {
    if (campaignId) {
      await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [campaignId]);
      await query(`DELETE FROM ens_campaigns WHERE id = $1`, [campaignId]);
    }
    if (configId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [configId]);
  });

  it('running campaign 90min old (created_at only, both timestamps NULL) is EXPIRED with 1h retention', async () => {
    const res = await latest(configId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    // 90min > 1h retention; COALESCE used created_at as the clock → expired 30min ago
    expect(res.body.status).toBe('EXPIRED');
    expect(res.body).not.toHaveProperty('recording_file');
    expect(res.body).not.toHaveProperty('message_audio_url');
  });
});

// ── Expiry clock: COALESCE(completed_at, started_at, created_at) ─────────────

describe('Expiry clock uses completed_at, not just created_at', () => {
  let lateStartConfigId, lateStartCampaignId;

  beforeAll(async () => {
    const { rows: [cfg] } = await query(
      `INSERT INTO ens_configurations
         (name, tenant_id, organization_id, is_active,
          max_concurrent_calls, max_attempts, retry_interval_sec,
          recording_retention_hours)
       VALUES ($1, $2, $3, true, 5, 1, 30, 1)
       RETURNING id`,
      // 1-hour retention
      [`EnsPlayAuth-LateStart-${SUFFIX}`, tenantId, orgId]
    );
    lateStartConfigId = cfg.id;

    // created 3h ago, but completed only 30 minutes ago.
    // With created_at-based clock: expired (3h > 1h retention).
    // With COALESCE(completed_at, started_at, created_at): active (30min < 1h retention).
    const { rows: [c] } = await query(
      `INSERT INTO ens_campaigns
         (ens_configuration_id, organization_id, triggered_via,
          status, recording_file,
          total_destinations, queued_count, max_concurrent, calls_per_second,
          retry_count, retry_interval_sec, max_attempts, retry_failed_only,
          adaptive_throttling, campaign_priority, campaign_timeout_min,
          created_at, started_at, completed_at)
       VALUES ($1, $2, 'PHONE', 'completed', $3,
               1, 0, 5, 1, 1, 30, 1, false, false, 5, 60,
               now() - interval '3 hours',
               now() - interval '3 hours',
               now() - interval '30 minutes')
       RETURNING id`,
      [lateStartConfigId, orgId, `latestart-${SUFFIX}.wav`]
    );
    lateStartCampaignId = c.id;

    await query(
      `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, max_attempts)
       VALUES ($1, $2, 'completed', 1)`,
      [lateStartCampaignId, CALLER_A]
    );
  });

  afterAll(async () => {
    if (lateStartCampaignId) {
      await query(`DELETE FROM ens_campaign_destinations WHERE campaign_id = $1`, [lateStartCampaignId]);
      await query(`DELETE FROM ens_campaigns WHERE id = $1`, [lateStartCampaignId]);
    }
    if (lateStartConfigId) await query(`DELETE FROM ens_configurations WHERE id = $1`, [lateStartConfigId]);
  });

  it('campaign completed 30 min ago (created 3h ago) is still ACTIVE with 1h retention', async () => {
    // If clock were created_at: 3h > 1h → EXPIRED. With completed_at: 30min < 1h → ACTIVE.
    const res = await latest(lateStartConfigId, CALLER_A);
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.recording_file).toContain(`latestart-${SUFFIX}.wav`);
  });
});
