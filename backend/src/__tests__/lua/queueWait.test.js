// queue_wait — bounded pre-transfer eligibility wait.
// Schema validation (server-side) + deterministic behaviour via the Fengari
// harness with a CONTROLLABLE CLOCK (os.time injected; advanceOnPoll bumps the
// clock on each eligibility poll). Mocked session/HTTP — this proves control
// flow, deadline logic, branch routing and fail-closed behaviour. It does NOT
// prove real FreeSWITCH/LuaJIT timing, playback interruption, or HTTP timeout;
// those require a DEV live-call (documented).
import { describe, it, expect } from 'vitest';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';
import { getNodeType } from '../../nodeTypes/registry.js';
import { runExecutor, appsExecuted } from './executorHarness.js';

// Terminal transfers reveal the branch taken.
const T = { e: { type: 'transfer', destination: '201' },   // ELIGIBLE
            o: { type: 'transfer', destination: '202' },   // OVERFLOW
            c: { type: 'transfer', destination: '203' } }; // CHECK_ERROR
const BR = { ELIGIBLE: 'e', OVERFLOW: 'o', CHECK_ERROR: 'c' };
const dest = (calls) => appsExecuted(calls).filter(a => a[0] === 'transfer').map(a => a[1].split(' ')[0]);
const run = (wait, opts) => runExecutor({
  graph: { entry_node_id: 'w', nodes: { w: { type: 'queue_wait', queue: 'Sales@ACME', branches: BR, ...wait }, ...T } },
  vars: { destination_number: '1222' }, ...opts,
});
const NOTELIG = () => ({ reason: 'NO_AVAILABLE_AGENTS', available: 0 });

describe('queue_wait — behaviour (harness, controllable clock)', () => {
  it('ELIGIBLE on the first check routes immediately (one poll)', () => {
    const r = run({ max_wait_seconds: 60 }, { http: { '/ivr/queue-eligibility': [{ reason: 'ELIGIBLE', available: 1 }] } });
    expect(dest(r.calls)).toEqual(['201']);
    expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
  });

  it('ELIGIBLE after several unsuccessful checks (clock advances per poll)', () => {
    const r = run({ max_wait_seconds: 120, recheck_interval_seconds: 5 }, {
      advanceOnPoll: 5,
      http: { '/ivr/queue-eligibility': [{ reason: 'NO_AGENTS_LOGGED_IN' }, { reason: 'ALL_AGENTS_PAUSED' }, { reason: 'ELIGIBLE', available: 1 }] },
    });
    expect(dest(r.calls)).toEqual(['201']);
    expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(3);
  });

  it('deadline expiry routes to OVERFLOW exactly once', () => {
    const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5 }, { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': NOTELIG } });
    expect(dest(r.calls)).toEqual(['202']);              // OVERFLOW, and only once
  });

  it('deadline does not reset between polls (terminates in a bounded number of polls)', () => {
    const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5 }, { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': NOTELIG } });
    const polls = r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length;
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThanOrEqual(Math.ceil(20 / 5) + 1); // if the deadline reset, this would loop unbounded
    expect(dest(r.calls)).toEqual(['202']);
  });

  it('deadline that expires DURING a check does not start another cycle (one poll → OVERFLOW)', () => {
    const r = run({ max_wait_seconds: 10, recheck_interval_seconds: 5 }, { advanceOnPoll: 20, http: { '/ivr/queue-eligibility': NOTELIG } });
    expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
    expect(dest(r.calls)).toEqual(['202']);
  });

  it('API error (empty/failed response) routes to CHECK_ERROR, not OVERFLOW/ELIGIBLE', () => {
    const r = run({ max_wait_seconds: 60 }, { http: { '/ivr/queue-eligibility': null } });
    expect(dest(r.calls)).toEqual(['203']);
  });

  it('malformed response (no reason) routes to CHECK_ERROR', () => {
    const r = run({ max_wait_seconds: 60 }, { http: { '/ivr/queue-eligibility': [{ nonsense: true }] } });
    expect(dest(r.calls)).toEqual(['203']);
  });

  it('caller hangup / session not ready terminates safely (no branch transfer)', () => {
    const r = run({ max_wait_seconds: 60, recheck_interval_seconds: 5 }, { advanceOnPoll: 5, readyAfter: 1, http: { '/ivr/queue-eligibility': NOTELIG } });
    expect(dest(r.calls)).not.toContain('202');
    expect(dest(r.calls)).not.toContain('201');
  });

  it('announcement respects cadence (plays periodically, never every cycle, not at t=0)', () => {
    const r = run(
      { max_wait_seconds: 60, recheck_interval_seconds: 5, announcement_source_type: 'audio', announcement_audio_url: '/media/a.wav', announcement_every_seconds: 10 },
      { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': NOTELIG } },
    );
    const anns = r.calls.filter(c => c[0] === 'streamFile').length;
    const polls = r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length;
    expect(anns).toBeGreaterThan(0);          // it did announce
    expect(anns).toBeLessThan(polls);         // but not on every cycle (cadence gated)
  });
});

describe('queue_wait — server-side validation', () => {
  const base = { type: 'queue_wait', queue: 'Sales@ACME', max_wait_seconds: 120, branches: { ELIGIBLE: 'e', OVERFLOW: 'o', CHECK_ERROR: 'c' } };
  it('valid minimal config passes', () => {
    expect(AnyNodeSchema.safeParse(base).success).toBe(true);
  });
  it('missing queue is rejected (never inherited)', () => {
    const { queue, ...noQ } = base;
    expect(AnyNodeSchema.safeParse(noQ).success).toBe(false);
  });
  it('max_wait_seconds must be a positive bounded integer', () => {
    for (const v of [0, 4, -1, 3601, 2.5, '60', null]) {
      expect(AnyNodeSchema.safeParse({ ...base, max_wait_seconds: v }).success).toBe(false);
    }
    for (const v of [5, 120, 3600]) {
      expect(AnyNodeSchema.safeParse({ ...base, max_wait_seconds: v }).success).toBe(true);
    }
  });
  it('recheck/check timeouts are bounded server-side', () => {
    expect(AnyNodeSchema.safeParse({ ...base, recheck_interval_seconds: 0 }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, recheck_interval_seconds: 61 }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, check_timeout_seconds: 16 }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, recheck_interval_seconds: 5, check_timeout_seconds: 5 }).success).toBe(true);
  });
  it('hold/announcement source requires the matching asset', () => {
    expect(AnyNodeSchema.safeParse({ ...base, hold_source_type: 'audio' }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, hold_source_type: 'audio', hold_audio_url: '/media/h.wav' }).success).toBe(true);
    expect(AnyNodeSchema.safeParse({ ...base, hold_source_type: 'tts' }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, announcement_source_type: 'tts', announcement_text: 'x', announcement_every_seconds: 10 }).success).toBe(true);
  });
  it('an announcement source requires a positive cadence', () => {
    expect(AnyNodeSchema.safeParse({ ...base, announcement_source_type: 'audio', announcement_audio_url: '/media/a.wav' }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...base, announcement_source_type: 'audio', announcement_audio_url: '/media/a.wav', announcement_every_seconds: 10 }).success).toBe(true);
  });
  it('rejects an external (non /media/) hold/announcement url', () => {
    expect(AnyNodeSchema.safeParse({ ...base, hold_source_type: 'audio', hold_audio_url: 'http://evil/x.wav' }).success).toBe(false);
  });
  it('exposes exactly ELIGIBLE/OVERFLOW/CHECK_ERROR as reserved outcomes', () => {
    expect(getNodeType('queue_wait').branchKeys).toEqual(['ELIGIBLE', 'OVERFLOW', 'CHECK_ERROR']);
  });
});

describe('queue_eligibility remains unchanged', () => {
  it('still one-shot with its 7 outcomes and still validates', () => {
    expect(getNodeType('queue_eligibility').branchKeys).toEqual(
      ['ELIGIBLE', 'NO_MEMBERS', 'NO_AGENTS_LOGGED_IN', 'ALL_AGENTS_PAUSED', 'NO_AVAILABLE_AGENTS', 'QUEUE_NOT_FOUND', 'CHECK_ERROR']);
    expect(AnyNodeSchema.safeParse({ type: 'queue_eligibility', queue: 'Sales@ACME', branches: { ELIGIBLE: 'e', _default: 'd' } }).success).toBe(true);
  });
});

// ── Per-reason BUSINESS POLICY (admin-configurable) — harness behaviour ──────
describe('queue_wait — per-reason policy routing', () => {
  const reasonResp = (reason) => () => ({ reason, available: 0 });
  // Recoverable reasons under WAIT keep polling (→ deadline → OVERFLOW here);
  // under OVERFLOW they exit immediately on the first non-eligible check.
  for (const [reason, field] of [
    ['NO_AVAILABLE_AGENTS', 'policy_no_available_agents'],
    ['ALL_AGENTS_PAUSED', 'policy_all_agents_paused'],
    ['NO_AGENTS_LOGGED_IN', 'policy_no_agents_logged_in'],
  ]) {
    it(`${reason}: policy=wait keeps waiting until the deadline → OVERFLOW`, () => {
      const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5, [field]: 'wait' },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp(reason) } });
      expect(dest(r.calls)).toEqual(['202']);
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBeGreaterThan(1); // actually waited
    });
    it(`${reason}: policy=overflow exits immediately on the first check (one poll)`, () => {
      const r = run({ max_wait_seconds: 600, recheck_interval_seconds: 5, [field]: 'overflow' },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp(reason) } });
      expect(dest(r.calls)).toEqual(['202']);
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
    });
  }

  for (const [reason, field] of [['NO_MEMBERS', 'policy_no_members'], ['QUEUE_NOT_FOUND', 'policy_queue_not_found']]) {
    it(`${reason}: policy=error routes CHECK_ERROR immediately (no pointless wait)`, () => {
      const r = run({ max_wait_seconds: 600, [field]: 'error' },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp(reason) } });
      expect(dest(r.calls)).toEqual(['203']);
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
    });
    it(`${reason}: policy=overflow routes OVERFLOW immediately`, () => {
      const r = run({ max_wait_seconds: 600, [field]: 'overflow' },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp(reason) } });
      expect(dest(r.calls)).toEqual(['202']);
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
    });
  }

  it('unexpected/unknown reason fails closed to CHECK_ERROR (never waits as if busy)', () => {
    const r = run({ max_wait_seconds: 600 }, { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': () => ({ reason: 'SOMETHING_NEW' }) } });
    expect(dest(r.calls)).toEqual(['203']);
    expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1);
  });

  it('BACKWARD COMPAT: legacy node with NO policy fields keeps waiting on every recoverable/structural reason', () => {
    // Absent policy fields → Lua defaults to "wait" (preserves the original
    // pre-policy behaviour) → structural reason waits to the deadline → OVERFLOW.
    const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5 },
      { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('QUEUE_NOT_FOUND') } });
    expect(dest(r.calls)).toEqual(['202']);   // waited then OVERFLOW (unchanged legacy behaviour)
  });
});

describe('queue_wait — announcement initial cadence (explicit)', () => {
  it('does NOT announce before the configured interval has elapsed', () => {
    // ann_every=30, poll advances 5s each: first announce only at elapsed>=30
    // (i.e. not on the first several polls). Stop early by making poll 3 eligible
    // so we can assert "no announcement in the first 10s".
    const r = run(
      { max_wait_seconds: 600, recheck_interval_seconds: 5, announcement_source_type: 'audio', announcement_audio_url: '/media/a.wav', announcement_every_seconds: 30 },
      { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': [{ reason: 'NO_AVAILABLE_AGENTS' }, { reason: 'NO_AVAILABLE_AGENTS' }, { reason: 'ELIGIBLE', available: 1 }] } });
    expect(dest(r.calls)).toContain('201');                  // became eligible at ~10s
    expect(r.calls.filter(c => c[0] === 'streamFile').length).toBe(0); // no announcement before 30s
  });
});

// ── M-2: defensive handling of PRESENT-BUT-INVALID policy values (runtime) ───
// A published graph can never carry an out-of-enum value (Zod, below), but an
// imported/hand-crafted graph might. policy_pick() coerces present-but-invalid
// to the field's SAFE default (recoverable→wait, structural→error) while leaving
// an ABSENT field at the legacy "wait" for BOTH classes.
describe('queue_wait — invalid policy values are normalised at runtime (M-2)', () => {
  const reasonResp = (reason) => () => ({ reason, available: 0 });
  // Values the runtime could actually receive from a non-validated importer.
  for (const bad of ['bogus', '', 'WAIT', 'overflow ', 42, true]) {
    it(`structural NO_MEMBERS with invalid policy ${JSON.stringify(bad)} → CHECK_ERROR (never silent wait)`, () => {
      const r = run({ max_wait_seconds: 600, policy_no_members: bad },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('NO_MEMBERS') } });
      expect(dest(r.calls)).toEqual(['203']);                                        // safe default = error
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBe(1); // no pointless wait
    });
    it(`recoverable NO_AVAILABLE_AGENTS with invalid policy ${JSON.stringify(bad)} → wait then OVERFLOW`, () => {
      const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5, policy_no_available_agents: bad },
        { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('NO_AVAILABLE_AGENTS') } });
      expect(dest(r.calls)).toEqual(['202']);                                        // safe default = wait → deadline
      expect(r.httpLog.filter(h => h.url.includes('/ivr/queue-eligibility')).length).toBeGreaterThan(1);
    });
  }

  it('an ABSENT structural policy is NEVER upgraded to error (stays legacy wait)', () => {
    // Guards the one risk the approval called out explicitly: nil must resolve to
    // "wait" (legacy), not to the structural safe default "error".
    const r = run({ max_wait_seconds: 20, recheck_interval_seconds: 5 /* no policy_no_members */ },
      { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('NO_MEMBERS') } });
    expect(dest(r.calls)).toEqual(['202']);   // waited to the deadline → OVERFLOW (unchanged)
  });
});

// ── M-2: schema rejects out-of-enum policy values at publish ─────────────────
describe('queue_wait — schema rejects invalid policy values (M-2, publish-time)', () => {
  const base = { type: 'queue_wait', queue: 'Sales@ACME', max_wait_seconds: 120, branches: { ELIGIBLE: 'e', OVERFLOW: 'o', CHECK_ERROR: 'c' } };
  it('recoverable policies accept only wait|overflow', () => {
    for (const f of ['policy_no_available_agents', 'policy_all_agents_paused', 'policy_no_agents_logged_in']) {
      expect(AnyNodeSchema.safeParse({ ...base, [f]: 'wait' }).success).toBe(true);
      expect(AnyNodeSchema.safeParse({ ...base, [f]: 'overflow' }).success).toBe(true);
      for (const bad of ['error', 'bogus', '', 'WAIT', 1]) {
        expect(AnyNodeSchema.safeParse({ ...base, [f]: bad }).success).toBe(false);
      }
    }
  });
  it('structural policies accept only error|overflow (never wait)', () => {
    for (const f of ['policy_no_members', 'policy_queue_not_found']) {
      expect(AnyNodeSchema.safeParse({ ...base, [f]: 'error' }).success).toBe(true);
      expect(AnyNodeSchema.safeParse({ ...base, [f]: 'overflow' }).success).toBe(true);
      for (const bad of ['wait', 'bogus', '', 2]) {
        expect(AnyNodeSchema.safeParse({ ...base, [f]: bad }).success).toBe(false);
      }
    }
  });
});

// ── Low-1: queue_wait_reason set on applicable CHECK_ERROR paths ─────────────
describe('queue_wait — error observability (Low-1)', () => {
  const reasonResp = (reason) => () => ({ reason, available: 0 });
  it('unknown reason sets queue_wait_reason=<reason>:CHECK_ERROR and still routes CHECK_ERROR', () => {
    const r = run({ max_wait_seconds: 600 }, { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('SOMETHING_NEW') } });
    expect(dest(r.calls)).toEqual(['203']);                               // branch unchanged
    expect(r.vars.queue_wait_reason).toBe('SOMETHING_NEW:CHECK_ERROR');   // diagnostic set
  });
  it('structural policy=error sets queue_wait_reason=<reason>:CHECK_ERROR', () => {
    const r = run({ max_wait_seconds: 600, policy_no_members: 'error' },
      { advanceOnPoll: 5, http: { '/ivr/queue-eligibility': reasonResp('NO_MEMBERS') } });
    expect(dest(r.calls)).toEqual(['203']);
    expect(r.vars.queue_wait_reason).toBe('NO_MEMBERS:CHECK_ERROR');
  });
  it('nil/malformed response CHECK_ERROR has no reason to report (no variable set)', () => {
    const r = run({ max_wait_seconds: 60 }, { http: { '/ivr/queue-eligibility': null } });
    expect(dest(r.calls)).toEqual(['203']);
    expect(r.vars.queue_wait_reason).toBeUndefined();   // no reason available → no diagnostic var
  });
});

describe('queue_wait — inspector grouping', () => {
  it('declares explicit sections (max_wait_seconds is NOT in a collapsed Timeouts section)', () => {
    const schema = getNodeType('queue_wait').configSchema;
    const sec = (k) => schema.find(f => f.key === k)?.section;
    expect(sec('max_wait_seconds')).toBe('Wait timing');
    expect(sec('policy_no_available_agents')).toBe('Business policy');
    expect(sec('announcement_every_seconds')).toBe('Hold & announcements');
    expect(sec('queue')).toBe('Queue');
  });
});
