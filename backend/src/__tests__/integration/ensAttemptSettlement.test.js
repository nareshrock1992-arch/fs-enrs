/**
 * ENS attempt settlement — every recipient outcome on a REAL PostgreSQL database.
 *
 * Drives the campaign engine's own event handlers (onCallAnswer, onCallHangup, the
 * originate-rejection settle, cancelCampaign, processCampaign's expiry / completion gate)
 * against real rows, then reads the result back with the same outcome SQL the reports and
 * the campaign dashboard use. No call is placed: ESL events are simulated by calling the
 * handlers the ESL listener calls.
 *
 * Requires a real test database (same env as other integration tests). Rows created here
 * carry the ENSSettle-<suffix> names and are left in terminal states; nothing is deleted.
 * Run: NODE_ENV=test npx vitest run src/__tests__/integration/ensAttemptSettlement.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from '../../db/pool.js';
import {
  onCallAnswer, onCallHangup, settleAttempt, cancelCampaign, processCampaign,
} from '../../services/campaignEngine.js';
import { CAMPAIGN_OUTCOMES_JOIN } from '../../services/ensOutcomes.js';

const SUFFIX = Date.now();
const RETRY_SEC = 60;
let orgId, cfgId;
const created = [];

// Leave no fixture campaign that a running engine could pick up (cancel, never delete).
afterAll(async () => {
  for (const id of created) await cancelCampaign(id).catch(() => {});
});

beforeAll(async () => {
  const { rows: [t] } = await query(`INSERT INTO tenants (name, code) VALUES ($1, $2) RETURNING id`,
    [`ENSSettle-${SUFFIX}`, `ESET-${SUFFIX}`]);
  const { rows: [o] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ($1, $2) RETURNING id`,
    [`ENSSettleOrg-${SUFFIX}`, t.id]);
  orgId = o.id;
  const { rows: [c] } = await query(
    `INSERT INTO ens_configurations (name, tenant_id, organization_id, is_active, max_concurrent_calls, max_attempts, retry_interval_sec)
     VALUES ($1, $2, $3, true, 5, 3, $4) RETURNING id`,
    [`ENSSettleCfg-${SUFFIX}`, t.id, orgId, RETRY_SEC]);
  cfgId = c.id;
});

async function campaign({ status = 'running', timeoutMin = 60, startedMinAgo = 0 } = {}) {
  const { rows: [c] } = await query(
    `INSERT INTO ens_campaigns
       (ens_configuration_id, organization_id, triggered_via, total_destinations, queued_count, status, message_text,
        max_concurrent, calls_per_second, retry_count, retry_interval_sec, max_attempts, retry_failed_only,
        adaptive_throttling, campaign_priority, campaign_timeout_min, started_at)
     VALUES ($1, $2, 'UI', 0, 0, $3, 'settle-test', 5, 1, 2, $4, 3, false, false, 5, $5, now() - ($6 || ' minutes')::interval)
     RETURNING *`,
    [cfgId, orgId, status, RETRY_SEC, timeoutMin, startedMinAgo]);
  created.push(c.id);
  return c;
}

// A recipient whose attempt is in flight, as the engine's claim leaves it.
async function dialing(campaignId, { attempt = 1, max = 3 } = {}) {
  const uuid = randomUUID();
  const { rows: [d] } = await query(
    `INSERT INTO ens_campaign_destinations (campaign_id, phone_number, status, call_uuid, attempt_count, max_attempts, last_attempt_at)
     VALUES ($1, $2, 'dialing', $3, $4, $5, now()) RETURNING id`,
    [campaignId, `555${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, uuid, attempt, max]);
  await query(`UPDATE ens_campaigns SET total_destinations = total_destinations + 1, dialing_count = dialing_count + 1 WHERE id = $1`, [campaignId]);
  return { id: d.id, uuid };
}

// The engine's claim of a queued recipient for its next attempt (same statement shape as processCampaign).
async function claimAgain(destId) {
  const uuid = randomUUID();
  const { rows: [d] } = await query(
    `UPDATE ens_campaign_destinations
     SET status = 'dialing', attempt_count = attempt_count + 1, last_attempt_at = now(), next_attempt_at = null, call_uuid = $2, updated_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id`, [destId, uuid]);
  expect(d).toBeTruthy();
  return uuid;
}

const dest = async (id) => (await query(
  `SELECT status, hangup_cause, attempt_count, call_uuid, answered_at, completed_at,
          EXTRACT(EPOCH FROM (next_attempt_at - now()))::INT AS retry_in
   FROM ens_campaign_destinations WHERE id = $1`, [id])).rows[0];
const counters = async (id) => (await query(
  `SELECT status, answered_count, completed_count, failed_count, busy_count, no_answer_count, retried_count, dialing_count
   FROM ens_campaigns WHERE id = $1`, [id])).rows[0];
const outcomes = async (id) => (await query(
  `SELECT to_jsonb(x) AS o FROM ens_campaigns c ${CAMPAIGN_OUTCOMES_JOIN} WHERE c.id = $1`, [id])).rows[0].o;

describe('ENS recipient outcomes (real PostgreSQL)', () => {
  it('answered: answer then hangup completes the recipient once', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallAnswer(d.uuid);
    await onCallHangup(d.uuid, 'NORMAL_CLEARING');
    expect(await dest(d.id)).toMatchObject({ status: 'completed', hangup_cause: 'NORMAL_CLEARING' });
    expect(await counters(c.id)).toMatchObject({ answered_count: 1, completed_count: 1, failed_count: 0, retried_count: 0, dialing_count: 0 });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, answered: 1, failed: 0 });
  });

  it.each([
    ['busy', 'USER_BUSY', 'busy_count'],
    ['no answer', 'NO_ANSWER', 'no_answer_count'],
  ])('%s with attempts left: retry scheduled after retry_interval_sec', async (_, cause, col) => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallHangup(d.uuid, cause);
    const row = await dest(d.id);
    expect(row).toMatchObject({ status: 'queued', hangup_cause: cause, call_uuid: null });
    expect(row.retry_in).toBeGreaterThan(RETRY_SEC - 5);
    expect(row.retry_in).toBeLessThanOrEqual(RETRY_SEC);
    expect(await counters(c.id)).toMatchObject({ [col]: 1, retried_count: 1, failed_count: 0 });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, pending: 1 });
  });

  it('failed: a non-retryable cause fails the recipient without retry', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallHangup(d.uuid, 'UNALLOCATED_NUMBER');
    const row = await dest(d.id);
    expect(row).toMatchObject({ status: 'failed', hangup_cause: 'UNALLOCATED_NUMBER', retry_in: null });
    expect(row.completed_at).not.toBeNull();
    expect(await counters(c.id)).toMatchObject({ failed_count: 1, retried_count: 0 });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, failed: 1 });
  });

  it('retry exhausted: a busy last attempt is final, reported as busy', async () => {
    const c = await campaign();
    const d = await dialing(c.id, { attempt: 3, max: 3 });
    await onCallHangup(d.uuid, 'USER_BUSY');
    expect(await dest(d.id)).toMatchObject({ status: 'failed', hangup_cause: 'USER_BUSY', retry_in: null });
    expect(await counters(c.id)).toMatchObject({ failed_count: 1, retried_count: 0 });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, busy: 1, failed: 0 });
  });

  it('retry successful: busy, re-dialled, answered — one recipient, answered, two attempts', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallHangup(d.uuid, 'USER_BUSY');
    const uuid2 = await claimAgain(d.id);
    await onCallAnswer(uuid2);
    await onCallHangup(uuid2, 'NORMAL_CLEARING');
    expect(await dest(d.id)).toMatchObject({ status: 'completed', attempt_count: 2 });
    expect(await counters(c.id)).toMatchObject({ answered_count: 1, completed_count: 1, busy_count: 1, retried_count: 1, failed_count: 0 });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, answered: 1, attempts: 2, retries: 1 });
  });

  it('a queued retry keeps the campaign open; it completes once nothing is left', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallHangup(d.uuid, 'NO_ANSWER');
    await processCampaign({ ...(await counters(c.id)), ...c, status: 'running' });
    expect((await counters(c.id)).status).toBe('running');
    const uuid2 = await claimAgain(d.id);
    await onCallHangup(uuid2, 'UNALLOCATED_NUMBER');
    await processCampaign({ ...c, status: 'running' });
    expect((await counters(c.id)).status).toBe('completed');
  });

  it('campaign cancelled: queued recipients and an in-flight retryable attempt end as skipped; nothing retries', async () => {
    const c = await campaign();
    const inFlight = await dialing(c.id);
    const waiting = await dialing(c.id);
    await onCallHangup(waiting.uuid, 'USER_BUSY');             // queued for retry before the cancel
    await cancelCampaign(c.id);
    await onCallHangup(inFlight.uuid, 'NO_ANSWER');            // its hangup arrives after the cancel
    expect(await dest(waiting.id)).toMatchObject({ status: 'skipped' });
    expect(await dest(inFlight.id)).toMatchObject({ status: 'skipped', hangup_cause: 'NO_ANSWER', call_uuid: null });
    const { rows: [q] } = await query(`SELECT COUNT(*)::INT AS n FROM ens_campaign_destinations WHERE campaign_id = $1 AND status IN ('queued','dialing')`, [c.id]);
    expect(q.n).toBe(0);
    expect(await outcomes(c.id)).toMatchObject({ recipients: 2, skipped: 2, pending: 0 });
  });

  it('campaign cancelled: a non-retryable failure still fails, an answered call still completes', async () => {
    const c = await campaign();
    const f = await dialing(c.id);
    const a = await dialing(c.id);
    await onCallAnswer(a.uuid);
    await cancelCampaign(c.id);
    await onCallHangup(f.uuid, 'UNALLOCATED_NUMBER');
    await onCallHangup(a.uuid, 'NORMAL_CLEARING');
    expect(await dest(f.id)).toMatchObject({ status: 'failed' });
    expect(await dest(a.id)).toMatchObject({ status: 'completed' });
  });

  it('campaign expired by its timeout: an in-flight retryable attempt ends as expired', async () => {
    const c = await campaign({ timeoutMin: 1, startedMinAgo: 5 });
    const d = await dialing(c.id);
    await processCampaign({ ...c });                           // the engine's own timeout path
    await onCallHangup(d.uuid, 'NO_ANSWER');
    expect(await dest(d.id)).toMatchObject({ status: 'expired', call_uuid: null });
    expect(await outcomes(c.id)).toMatchObject({ recipients: 1, expired: 1, pending: 0 });
  });

  it('duplicate hangup event: settled and counted once', async () => {
    const c = await campaign();
    const a = await dialing(c.id);
    const b = await dialing(c.id);
    await onCallAnswer(a.uuid);
    for (let i = 0; i < 3; i++) await onCallHangup(a.uuid, 'NORMAL_CLEARING');
    for (let i = 0; i < 3; i++) await onCallHangup(b.uuid, 'UNALLOCATED_NUMBER');
    expect(await counters(c.id)).toMatchObject({ completed_count: 1, failed_count: 1 });
  });

  it('originate rejection while still dialing: failed, ORIGINATE_ERROR, no retry (unchanged)', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR NO_ROUTE_DESTINATION', { fromOriginate: true });
    expect(await dest(d.id)).toMatchObject({ status: 'failed', hangup_cause: 'ORIGINATE_ERROR', retry_in: null });
    expect(await counters(c.id)).toMatchObject({ failed_count: 1, retried_count: 0 });
  });

  it('originate result after the hangup already scheduled the retry: the retry stands, nothing double-counted', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallHangup(d.uuid, 'USER_BUSY');
    await settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR USER_BUSY', { fromOriginate: true });
    expect(await dest(d.id)).toMatchObject({ status: 'queued', hangup_cause: 'USER_BUSY' });
    expect(await counters(c.id)).toMatchObject({ failed_count: 0, retried_count: 1, busy_count: 1 });
  });

  it('originate result for an answered call: left to its hangup, which records it delivered', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    await onCallAnswer(d.uuid);
    await settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR NORMAL_CLEARING', { fromOriginate: true });
    expect((await dest(d.id)).status).toBe('answered');
    await onCallHangup(d.uuid, 'NORMAL_CLEARING');
    expect(await dest(d.id)).toMatchObject({ status: 'completed' });
    expect(await counters(c.id)).toMatchObject({ completed_count: 1, failed_count: 0 });
  });

  // Cycle 5 staging: on the real switch the hangup arrives first and the originate result
  // milliseconds later, while the hangup is still being settled. The configured retry must
  // stand every time (before, the originate path often won and failed the recipient).
  it('real-switch order, settled concurrently: hangup then originate result → the configured retry, every time', async () => {
    const c = await campaign();
    const ds = [];
    for (let i = 0; i < 15; i++) ds.push(await dialing(c.id));
    await Promise.all(ds.flatMap((d) => [
      onCallHangup(d.uuid, 'USER_BUSY'),
      settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR USER_BUSY', { fromOriginate: true }),
    ]));
    const k = await counters(c.id);
    expect(k).toMatchObject({ retried_count: 15, failed_count: 0, busy_count: 15 });
    for (const d of ds) expect(await dest(d.id)).toMatchObject({ status: 'queued', hangup_cause: 'USER_BUSY' });
  });

  it('originate result first, hangup within the grace period: the hangup still decides', async () => {
    const c = await campaign();
    const d = await dialing(c.id);
    const result = settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR NO_ANSWER', { fromOriginate: true });
    await new Promise((r) => setTimeout(r, 300));
    await onCallHangup(d.uuid, 'NO_ANSWER');
    await result;
    expect(await dest(d.id)).toMatchObject({ status: 'queued', hangup_cause: 'NO_ANSWER' });
    expect(await counters(c.id)).toMatchObject({ failed_count: 0, retried_count: 1, no_answer_count: 1 });
  });

  it('concurrent status updates: hangup and originate result racing settle each attempt exactly once', async () => {
    const c = await campaign();
    const ds = [];
    for (let i = 0; i < 15; i++) ds.push(await dialing(c.id));
    await Promise.all(ds.flatMap((d) => [
      onCallHangup(d.uuid, 'USER_BUSY'),
      settleAttempt(d.uuid, 'ORIGINATE_ERROR', '-ERR USER_BUSY', { fromOriginate: true }),
      onCallHangup(d.uuid, 'USER_BUSY'),
    ]));
    const k = await counters(c.id);
    expect(k.retried_count + k.failed_count).toBe(15);        // one settlement per attempt
    const { rows } = await query(`SELECT status, COUNT(*)::INT AS n FROM ens_campaign_destinations WHERE campaign_id = $1 GROUP BY status`, [c.id]);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect((by.queued || 0) + (by.failed || 0)).toBe(15);
    expect(by.queued || 0).toBe(k.retried_count);
    expect(by.failed || 0).toBe(k.failed_count);
    const o = await outcomes(c.id);
    expect(o.recipients).toBe(15);
    expect(o.pending + o.answered + o.busy + o.no_answer + o.failed + o.expired + o.skipped).toBe(15);
  });
});
