/**
 * Queue Eligibility (Phase 2) — parser + pure evaluator.
 *
 * Tests the two pure, I/O-free building blocks exported by eslService:
 *   parseCcTable()            — the pipe-delimited callcenter_config list parser
 *   evaluateQueueEligibility()— the tier↔agent join + deterministic reason logic
 *
 * Heavy deps (modesl, db pool, config) are mocked so importing eslService has no
 * side effects. The evaluator is pure, so this covers the full state matrix and
 * the fail-closed (inconsistent-data) case without touching a live FreeSWITCH.
 *
 * Run: cd backend && npx vitest run src/__tests__/unit/queueEligibility.test.js
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('modesl', () => ({ default: { Connection: class {} } }));
vi.mock('../../db/pool.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));
vi.mock('../../config/index.js', () => ({ config: {}, default: {} }));

const { parseCcTable, evaluateQueueEligibility } = await import('../../services/eslService.js');
const { getNodeType, publicNodeTypes } = await import('../../nodeTypes/registry.js');

// ── node registry: stable branch IDs + display-only labels ──────────────────────
describe('queue_eligibility node — branch IDs stable, labels display-only', () => {
  const EXPECTED_IDS = ['ELIGIBLE', 'NO_MEMBERS', 'NO_AGENTS_LOGGED_IN', 'ALL_AGENTS_PAUSED', 'NO_AVAILABLE_AGENTS', 'QUEUE_NOT_FOUND', 'CHECK_ERROR'];
  it('keeps the 7 persisted branch keys exactly (saved-flow compatibility)', () => {
    expect(getNodeType('queue_eligibility').branchKeys).toEqual(EXPECTED_IDS);
  });
  it('publicNodeTypes surfaces the same branch keys to the frontend', () => {
    const n = publicNodeTypes().find(t => t.type === 'queue_eligibility');
    expect(n.branchKeys).toEqual(EXPECTED_IDS);
  });
  it('applies the approved business-facing labels (display only)', () => {
    expect(getNodeType('queue_eligibility').portLabels).toEqual({
      ELIGIBLE: 'Agent available',
      NO_MEMBERS: 'No agents assigned',
      NO_AGENTS_LOGGED_IN: 'All agents logged out',
      ALL_AGENTS_PAUSED: 'All agents on break',
      NO_AVAILABLE_AGENTS: 'Agents busy / unavailable',
      QUEUE_NOT_FOUND: 'Queue not configured',
      CHECK_ERROR: 'Check failed (route safely)',
    });
  });
  it('every label key is a real branch key (no label drift)', () => {
    const n = getNodeType('queue_eligibility');
    expect(Object.keys(n.portLabels).sort()).toEqual([...n.branchKeys].sort());
  });
});

// ── Lua routing contract (string assertions on the generated handler) ───────────
describe('queue_eligibility luaHandler — fail-safe routing', () => {
  const lua = getNodeType('queue_eligibility').luaHandler;
  it('routes on the reason key with _default fallthrough (unknown reason cannot select ELIGIBLE)', () => {
    // br[resp.reason] — an unrecognized reason indexes nil → falls to _default, never ELIGIBLE.
    expect(lua).toContain('br[resp.reason] or br["_default"]');
  });
  it('a nil/invalid response fails closed to CHECK_ERROR/_default (never ELIGIBLE)', () => {
    expect(lua).toContain('br["CHECK_ERROR"] or br["_default"]');
    expect(lua).toMatch(/resp == nil or resp\.reason == nil/);
  });
  it('the node never issues a transfer itself', () => {
    expect(lua).not.toMatch(/execute\(\s*["']transfer["']/);
  });
});

const ag = (name, status, state) => ({ name, status, state });
const tr = (queue, agent, state = 'Ready') => ({ queue, agent, state, level: '1', position: '1' });
const Q = (...names) => names.map(name => ({ name }));
// Module-scope single-queue fixture for the regression/diagnostics blocks below
// (the state-matrix describe defines its own local `queues`, which shadows this).
const queues = Q('q@y');

// ── parser ────────────────────────────────────────────────────────────────────
describe('parseCcTable', () => {
  it('parses a normal pipe table (header → rows), trimming the trailing +OK', () => {
    const raw = 'name|status|state\nA|Available|Waiting\nB|Logged Out|Waiting\n+OK';
    const r = parseCcTable(raw);
    expect(r.err).toBeUndefined();
    expect(r.header).toEqual(['name', 'status', 'state']);
    expect(r.rows).toEqual([
      { name: 'A', status: 'Available', state: 'Waiting' },
      { name: 'B', status: 'Logged Out', state: 'Waiting' },
    ]);
  });
  it('reports -ERR as an error', () => { expect(parseCcTable('-ERR Invalid!').err).toBeTruthy(); });
  it('reports empty response as an error', () => { expect(parseCcTable('').err).toBeTruthy(); });
  it('treats a bare +OK (no table) as a valid empty set', () => {
    const r = parseCcTable('+OK'); expect(r.err).toBeUndefined(); expect(r.rows).toEqual([]);
  });
  it('reports a missing header row as an error', () => { expect(parseCcTable('just text\nmore').err).toBeTruthy(); });
});

// ── evaluator: existence / membership ──────────────────────────────────────────
describe('evaluateQueueEligibility — existence & membership', () => {
  it('QUEUE_NOT_FOUND when the queue is absent from queue list', () => {
    const r = evaluateQueueEligibility('X@y', { queues: Q('other@y'), agents: [], tiers: [] });
    expect(r).toMatchObject({ queue_exists: false, eligible: false, reason: 'QUEUE_NOT_FOUND', members: 0 });
  });
  it('NO_MEMBERS when the queue exists but has zero tiers', () => {
    const r = evaluateQueueEligibility('q@y', { queues: Q('q@y'), agents: [ag('a', 'Available', 'Waiting')], tiers: [] });
    expect(r).toMatchObject({ queue_exists: true, members: 0, eligible: false, reason: 'NO_MEMBERS' });
  });
});

// ── evaluator: state matrix ────────────────────────────────────────────────────
describe('evaluateQueueEligibility — agent/tier state matrix', () => {
  const queues = Q('q@y');
  it('ELIGIBLE: Available + Waiting + tier Ready', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a')] });
    expect(r).toMatchObject({ reason: 'ELIGIBLE', eligible: true, members: 1, logged_in: 1, available: 1, busy: 0, paused: 0 });
  });
  it('ELIGIBLE: Available + Idle + tier Ready', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Idle')], tiers: [tr('q@y', 'a')] });
    expect(r.reason).toBe('ELIGIBLE');
  });
  it('NO_AVAILABLE_AGENTS: Available + Receiving (being offered) counts as busy', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Receiving')], tiers: [tr('q@y', 'a')] });
    expect(r).toMatchObject({ reason: 'NO_AVAILABLE_AGENTS', available: 0, busy: 1, logged_in: 1 });
  });
  it('NO_AVAILABLE_AGENTS: Available + In a queue call counts as busy', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'In a queue call')], tiers: [tr('q@y', 'a')] });
    expect(r).toMatchObject({ reason: 'NO_AVAILABLE_AGENTS', busy: 1 });
  });
  it('NO_AVAILABLE_AGENTS: Available + Waiting but tier state NOT Ready is not routable', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a', 'Standby')] });
    expect(r).toMatchObject({ reason: 'NO_AVAILABLE_AGENTS', available: 0, busy: 1 });
  });
  it('NO_AGENTS_LOGGED_IN: all members Logged Out', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Logged Out', 'Waiting')], tiers: [tr('q@y', 'a')] });
    expect(r).toMatchObject({ reason: 'NO_AGENTS_LOGGED_IN', logged_in: 0, members: 1 });
  });
  it('ALL_AGENTS_PAUSED: logged-in members all On Break', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'On Break', 'Waiting'), ag('b', 'On Break', 'Idle')], tiers: [tr('q@y', 'a'), tr('q@y', 'b')] });
    expect(r).toMatchObject({ reason: 'ALL_AGENTS_PAUSED', logged_in: 2, paused: 2, available: 0 });
  });
  it('multiple members, one eligible → ELIGIBLE with correct counters', () => {
    const agents = [ag('a', 'Logged Out', 'Waiting'), ag('b', 'On Break', 'Waiting'), ag('c', 'Available', 'In a queue call'), ag('d', 'Available', 'Waiting')];
    const tiers = [tr('q@y', 'a'), tr('q@y', 'b'), tr('q@y', 'c'), tr('q@y', 'd')];
    const r = evaluateQueueEligibility('q@y', { queues, agents, tiers });
    expect(r).toMatchObject({ reason: 'ELIGIBLE', eligible: true, members: 4, logged_in: 3, paused: 1, available: 1, busy: 1 });
  });
  it('only counts members of the requested queue (a global available agent elsewhere is ignored)', () => {
    const agents = [ag('a', 'Available', 'Waiting'), ag('b', 'Logged Out', 'Waiting')];
    const tiers = [tr('other@y', 'a'), tr('q@y', 'b')]; // 'a' is available but member of a DIFFERENT queue
    const r = evaluateQueueEligibility('q@y', { queues: Q('q@y', 'other@y'), agents, tiers });
    expect(r).toMatchObject({ reason: 'NO_AGENTS_LOGGED_IN', members: 1, available: 0 });
  });
});

// ── evaluator: fail closed on inconsistent data ─────────────────────────────────
describe('evaluateQueueEligibility — inconsistent data fails closed', () => {
  it('throws when a tier member has no matching agent record (never counted available)', () => {
    expect(() => evaluateQueueEligibility('q@y', { queues: Q('q@y'), agents: [], tiers: [tr('q@y', 'ghost')] }))
      .toThrow(/no agent record/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase "D+A" regression coverage — the incident-shape + diagnostics contract.
// These LOCK the CURRENT policy and the additive diagnostics; they do NOT
// introduce or assert any new reason code, routing change, or policy change.
// ════════════════════════════════════════════════════════════════════════════
describe('queue-eligibility regression — incident shape & current policy', () => {
  // (1) One agent Ready in one queue, No Answer in another → eligibility is
  // strictly per-queue. monday mirrors the live incident across 3 queues.
  const monday = ag('monday_1001@YASREF', 'Available', 'Waiting');
  const others = [ag('sunday_1000@YASREF', 'On Break', 'Waiting')];
  const tiers3 = [
    tr('ComputerCommunication@YASREF', 'monday_1001@YASREF', 'Ready'),
    tr('RadioPAGA@YASREF',             'monday_1001@YASREF', 'Ready'),
    tr('SAPAPPS@YASREF',              'monday_1001@YASREF', 'No Answer'),
    tr('SAPAPPS@YASREF',              'sunday_1000@YASREF', 'Ready'),
  ];
  const queues3 = Q('ComputerCommunication@YASREF', 'RadioPAGA@YASREF', 'SAPAPPS@YASREF');
  const agents3 = [monday, ...others];

  it('Ready-tier queue → ELIGIBLE for the same agent (ComputerCommunication)', () => {
    const r = evaluateQueueEligibility('ComputerCommunication@YASREF', { queues: queues3, agents: agents3, tiers: tiers3 });
    expect(r).toMatchObject({ reason: 'ELIGIBLE', eligible: true, members: 1, available: 1 });
  });
  it('Ready-tier queue → ELIGIBLE (RadioPAGA) — queue-specific, not global', () => {
    const r = evaluateQueueEligibility('RadioPAGA@YASREF', { queues: queues3, agents: agents3, tiers: tiers3 });
    expect(r).toMatchObject({ reason: 'ELIGIBLE', eligible: true, available: 1 });
  });
  // (2) No Answer in the REQUESTED queue → preserve the ineligible result/reason.
  it('No-Answer tier in the requested queue → NO_AVAILABLE_AGENTS (monday not routable, sunday paused)', () => {
    const r = evaluateQueueEligibility('SAPAPPS@YASREF', { queues: queues3, agents: agents3, tiers: tiers3 });
    // monday: logged in, Available but tier No Answer → busy; sunday: logged in, On Break → paused.
    expect(r).toMatchObject({ reason: 'NO_AVAILABLE_AGENTS', eligible: false, members: 2, logged_in: 2, paused: 1, busy: 1, available: 0 });
  });
  it('No-Answer is treated exactly like any non-Ready tier (same as Standby)', () => {
    const na = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a', 'No Answer')] });
    const sb = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a', 'Standby')] });
    expect(na.reason).toBe('NO_AVAILABLE_AGENTS');
    expect(na.reason).toBe(sb.reason);
  });

  // (4) Reason-set invariant → guarantees unknown reasons can't appear, so the
  // Lua `br[reason] or _default` contract and saved flows stay compatible.
  it('only ever emits one of the 7 persisted reason codes across the matrix', () => {
    const KNOWN = new Set(['ELIGIBLE', 'NO_MEMBERS', 'NO_AGENTS_LOGGED_IN', 'ALL_AGENTS_PAUSED', 'NO_AVAILABLE_AGENTS', 'QUEUE_NOT_FOUND', 'CHECK_ERROR']);
    const cases = [
      evaluateQueueEligibility('missing@y', { queues: Q('other@y'), agents: [], tiers: [] }),
      evaluateQueueEligibility('q@y', { queues, agents: [], tiers: [] }),
      evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Logged Out', 'Waiting')], tiers: [tr('q@y', 'a')] }),
      evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'On Break', 'Waiting')], tiers: [tr('q@y', 'a')] }),
      evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a', 'No Answer')] }),
      evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a')] }),
    ];
    for (const r of cases) expect(KNOWN.has(r.reason)).toBe(true);
  });

  // (5) Generic domains / queue names — no customer-specific hardcoding.
  it('works identically for a generic non-YASREF domain', () => {
    const r = evaluateQueueEligibility('sales@acme.com', {
      queues: Q('sales@acme.com'), agents: [ag('rep@acme.com', 'Available', 'Idle')], tiers: [tr('sales@acme.com', 'rep@acme.com', 'Ready')],
    });
    expect(r).toMatchObject({ reason: 'ELIGIBLE', eligible: true });
  });
});

// ── Additive diagnostics (Option D) — explain, never alter, the decision ───────
describe('queue-eligibility diagnostics (additive, non-semantic)', () => {
  it('per-agent detail reports status/state/tier_state/classification without contact/PII', () => {
    const r = evaluateQueueEligibility('q@y', {
      queues, agents: [ag('a', 'Available', 'Waiting'), ag('b', 'On Break', 'Waiting'), ag('c', 'Available', 'Waiting')],
      tiers: [tr('q@y', 'a', 'Ready'), tr('q@y', 'b', 'Ready'), tr('q@y', 'c', 'No Answer')],
    });
    expect(r.detail).toHaveLength(3);
    expect(r.detail.find(d => d.agent === 'a')).toMatchObject({ status: 'Available', state: 'Waiting', tier_state: 'Ready', classification: 'routable' });
    expect(r.detail.find(d => d.agent === 'b')).toMatchObject({ classification: 'paused' });
    expect(r.detail.find(d => d.agent === 'c')).toMatchObject({ tier_state: 'No Answer', classification: 'not_routable' });
    // PII-safe: no contact/endpoint/secret fields leak into detail.
    for (const d of r.detail) expect(Object.keys(d).sort()).toEqual(['agent', 'classification', 'state', 'status', 'tier_state']);
  });
  it('classification counts are consistent with the aggregate counts (detail explains, never changes)', () => {
    const r = evaluateQueueEligibility('q@y', {
      queues, agents: [ag('a', 'Available', 'Waiting'), ag('b', 'On Break', 'Waiting'), ag('c', 'Logged Out', 'Waiting'), ag('d', 'Available', 'In a queue call')],
      tiers: [tr('q@y', 'a'), tr('q@y', 'b'), tr('q@y', 'c'), tr('q@y', 'd')],
    });
    const byClass = (k) => r.detail.filter(d => d.classification === k).length;
    expect(byClass('routable')).toBe(r.available);
    expect(byClass('paused')).toBe(r.paused);
    expect(byClass('not_routable')).toBe(r.busy);
    expect(byClass('logged_out')).toBe(r.members - r.logged_in);
  });
  it('snapshot flags the three lists as NON-atomic and consistent on a clean evaluate', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a')] });
    expect(r.snapshot).toMatchObject({ atomic: false, consistent: true });
  });
  it('adding diagnostics did not change the decision contract (reason/eligible/counts intact)', () => {
    const r = evaluateQueueEligibility('q@y', { queues, agents: [ag('a', 'Available', 'Waiting')], tiers: [tr('q@y', 'a')] });
    expect(r).toMatchObject({ queue: 'q@y', queue_exists: true, members: 1, logged_in: 1, available: 1, busy: 0, paused: 0, eligible: true, reason: 'ELIGIBLE' });
  });
});

// (6) Static-only: eligibility `queue` and Transfer `destination` are INDEPENDENT
// fields — divergence is possible by design. This documents the gap; it asserts
// NO runtime rejection (none is added in this phase).
describe('queue-eligibility vs transfer destination — independent fields (static)', () => {
  it('queue_eligibility has a `queue` field; transfer has an independent `destination`', () => {
    const elig = getNodeType('queue_eligibility').configSchema.map(f => f.key);
    const xfer = getNodeType('transfer').configSchema.map(f => f.key);
    expect(elig).toContain('queue');
    expect(xfer).toContain('destination');
    expect(xfer).not.toContain('queue'); // transfer does not inherit the checked queue → they CAN diverge
  });
});
