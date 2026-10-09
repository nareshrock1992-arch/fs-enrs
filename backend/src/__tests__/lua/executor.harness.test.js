// Phase 0 — proves the Lua behaviour harness exercises the REAL generated
// executor against existing nodes. Logic/branch/dispatch only; FreeSWITCH app
// behaviour (bridge, barge-in, TTS, gateways) still needs DEV live-call tests.
import { describe, it, expect } from 'vitest';
import { runExecutor, appsExecuted } from './executorHarness.js';

const flow = (entry, nodes) => ({ entry_node_id: entry, nodes });

describe('Lua harness — real executor, mocked deps', () => {
  it('transfer node: captures the exact dial string passed to session:execute', () => {
    const graph = flow('n1', { n1: { type: 'transfer', destination: '100' } });
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222' } });
    expect(appsExecuted(calls)).toContainEqual(['transfer', '100 XML default']);
  });

  it('transfer interpolates ${var} in the destination', () => {
    const graph = flow('n1', { n1: { type: 'transfer', destination: '${agent_ext}', context: 'default' } });
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222', agent_ext: '2050' } });
    expect(appsExecuted(calls)).toContainEqual(['transfer', '2050 XML default']);
  });

  it('queue_eligibility: ELIGIBLE reason routes to the ELIGIBLE branch', () => {
    const graph = flow('q', {
      q: { type: 'queue_eligibility', queue: 'support@default', branches: { ELIGIBLE: 't', CHECK_ERROR: 'h' } },
      t: { type: 'transfer', destination: '100' },
      h: { type: 'hangup' },
    });
    const { calls } = runExecutor({
      graph,
      vars: { destination_number: '1222' },
      http: { '/ivr/queue-eligibility': { queue: 'support@default', reason: 'ELIGIBLE', available: 1, eligible: true } },
    });
    expect(appsExecuted(calls)).toContainEqual(['transfer', '100 XML default']);
  });

  it('queue_eligibility: FAILS CLOSED — empty API response routes to CHECK_ERROR (never ELIGIBLE)', () => {
    const graph = flow('q', {
      q: { type: 'queue_eligibility', queue: 'support@default', branches: { ELIGIBLE: 't', CHECK_ERROR: 'h' } },
      t: { type: 'transfer', destination: '100' },
      h: { type: 'hangup' },
    });
    const { calls } = runExecutor({
      graph,
      vars: { destination_number: '1222' },
      http: { '/ivr/queue-eligibility': null }, // simulated backend failure → nil in Lua
    });
    // CHECK_ERROR branch is the hangup node; the ELIGIBLE transfer must NOT run.
    expect(appsExecuted(calls)).not.toContainEqual(['transfer', '100 XML default']);
    expect(calls.some(c => c[0] === 'hangup')).toBe(true);
  });

  it('condition node: true branch taken when variable matches', () => {
    const graph = flow('c', {
      c: { type: 'condition', variable: 'pin_ok', operator: '==', expected_value: '1', true_node: 't', false_node: 'f' },
      t: { type: 'transfer', destination: '111' },
      f: { type: 'transfer', destination: '222' },
    });
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222', pin_ok: '1' } });
    expect(appsExecuted(calls)).toContainEqual(['transfer', '111 XML default']);
    expect(appsExecuted(calls)).not.toContainEqual(['transfer', '222 XML default']);
  });

  it('caller disconnect: session:ready()=false stops flow execution early', () => {
    // say → next say → transfer; hang up after the first recorded session call.
    const graph = flow('s1', {
      s1: { type: 'say', text: 'one', next: 's2' },
      s2: { type: 'say', text: 'two', next: 't' },
      t: { type: 'transfer', destination: '100' },
    });
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222' }, readyAfter: 1 });
    // The transfer must never run because the caller "hung up" after 1 call.
    expect(appsExecuted(calls)).not.toContainEqual(['transfer', '100 XML default']);
  });

  it('unknown lookup (no flow bound) → failsafe path, never a crash', () => {
    const { calls } = runExecutor({
      graph: undefined,
      vars: { destination_number: '9999' },
      http: { '/ivr/lookup': null },     // no published flow
      globalVars: {},                     // no ENRS_FAILSAFE_EXT configured
    });
    // With no failsafe ext configured the executor hangs up — never dead-air crash.
    expect(calls.some(c => c[0] === 'hangup')).toBe(true);
  });
});
