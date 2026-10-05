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

const ag = (name, status, state) => ({ name, status, state });
const tr = (queue, agent, state = 'Ready') => ({ queue, agent, state, level: '1', position: '1' });
const Q = (...names) => names.map(name => ({ name }));

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
