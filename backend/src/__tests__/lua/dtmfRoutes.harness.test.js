// DTMF redesign — Digits-mode routes and separate failure exits, run through
// the REAL generated executor in the Fengari harness with a mocked session.
// Each exit is a Transfer to a distinct extension so the route taken is visible.
import { describe, it, expect } from 'vitest';
import { runExecutor } from './executorHarness.js';

const xfer = ext => ({ type: 'transfer', destination: ext, dialplan: 'XML', context: 'default' });
const transfersOf = calls => calls.filter(c => c[0] === 'execute' && c[1] === 'transfer').map(c => c[2].split(' ')[0]);

function digitsNode(extra = {}) {
  return {
    type: 'gather', config_version: 2, retry_mode: 'internal', max_attempts: 3,
    min_digits: 4, max_digits: 4, timeout_seconds: 5, variable_name: 'account',
    prompt_source_type: 'none', retry_on_invalid_option: 'yes',
    routes: [
      { id: 'a', type: 'equals', value: '1234' },
      { id: 'b', type: 'range', value: '2000', value2: '2999' },
    ],
    branches: {
      route_a: 'to_transfer', route_b: 'to_say', _default: 'to_hangup', max_attempts_exceeded: 'to_failed',
    },
    ...extra,
  };
}

function graph(node) {
  return {
    entry_node_id: 'pin',
    nodes: {
      pin: node,
      to_transfer: xfer('1111'),
      to_say: xfer('2222'),
      to_hangup: xfer('9999'),
      to_failed: xfer('0000'),
      to_no_input: xfer('7001'),
      to_invalid: xfer('7002'),
    },
  };
}

const run = (node, digits) => runExecutor({ graph: graph(node), digits, vars: { destination_number: '100' } });

describe('Digits routes: each input takes the expected exit (brief Phase 4 scenario)', () => {
  it('1234 → Equals route (Transfer)', () => {
    const { calls, vars } = run(digitsNode(), ['1234']);
    expect(transfersOf(calls)).toEqual(['1111']);
    expect(vars.account).toBe('1234');           // digits still saved to the variable
  });
  it('2500 → Range 2000–2999 route (Say)', () => {
    expect(transfersOf(run(digitsNode(), ['2500']).calls)).toEqual(['2222']);
  });
  it('5555 → Any valid entry (Hangup)', () => {
    expect(transfersOf(run(digitsNode(), ['5555']).calls)).toEqual(['9999']);
  });
  it('no input three times → Failed', () => {
    expect(transfersOf(run(digitsNode(), ['', '', '']).calls)).toEqual(['0000']);
  });
  it('too short three times → Failed', () => {
    expect(transfersOf(run(digitsNode(), ['12', '1', '123']).calls)).toEqual(['0000']);
  });
  it('a retry then a valid entry is routed by the route', () => {
    expect(transfersOf(run(digitsNode(), ['', '2999']).calls)).toEqual(['2222']);
  });
  it('no route matches and Any valid entry is not connected → invalid → retries → Failed', () => {
    const node = digitsNode();
    delete node.branches._default;
    expect(transfersOf(run(node, ['5555', '6666', '7777']).calls)).toEqual(['0000']);
    expect(transfersOf(run(node, ['5555', '1234']).calls)).toEqual(['1111']);
  });
  it('first match wins (top to bottom)', () => {
    const node = digitsNode({ routes: [
      { id: 'a', type: 'starts_with', value: '12' },
      { id: 'b', type: 'equals', value: '1234' },
    ] });
    expect(transfersOf(run(node, ['1234']).calls)).toEqual(['1111']);
  });
  it('a matching route with no connected exit is skipped', () => {
    const node = digitsNode();
    delete node.branches.route_a;
    expect(transfersOf(run(node, ['1234']).calls)).toEqual(['9999']);
  });
});

describe('every rule type in the runtime', () => {
  const cases = [
    [{ type: 'equals', value: '1234' }, ['1234'], ['1235']],
    [{ type: 'one_of', value: '1001, 1002,1005' }, ['1001', '1005'], ['1003']],
    [{ type: 'range', value: '1000', value2: '1999' }, ['1000', '1999', '1500'], ['0999', '2000']],
    [{ type: 'starts_with', value: '9' }, ['9000', '9123'], ['8999']],
    [{ type: 'length', value: '4' }, ['4321'], []],
    [{ type: 'pattern', value: '^[2-4]\\d{3}$' }, ['2000', '4999'], ['5000', '1999']],
    [{ type: 'pattern', value: '^1\\d{1,2}#?$' }, ['12', '123', '12#'], ['1', '1234']],
  ];
  for (const [rule, hits, misses] of cases) {
    it(`${rule.type} ${rule.value}${rule.value2 ? '–' + rule.value2 : ''}`, () => {
      const node = digitsNode({
        min_digits: 1, max_digits: 6,
        routes: [{ id: 'a', ...rule }],
        branches: { route_a: 'to_transfer', _default: 'to_hangup', max_attempts_exceeded: 'to_failed' },
      });
      for (const d of hits) expect(transfersOf(run(node, [d]).calls), `${d} should match`).toEqual(['1111']);
      for (const d of misses) expect(transfersOf(run(node, [d]).calls), `${d} should not match`).toEqual(['9999']);
    });
  }
  it('an unsupported pattern never matches (and validation rejects it)', () => {
    const node = digitsNode({ min_digits: 1, max_digits: 6, routes: [{ id: 'a', type: 'pattern', value: '^(12|34)$' }] });
    expect(transfersOf(run(node, ['12']).calls)).toEqual(['9999']);
  });
});

describe('separate failure exits (opt-in) route by the last reason after the retries', () => {
  const sep = extra => digitsNode({
    failure_exits: 'separate',
    branches: { route_a: 'to_transfer', no_input: 'to_no_input', invalid_option: 'to_invalid', max_attempts_exceeded: 'to_failed' },
    ...extra,
  });
  it('no input after retries → No input', () => {
    expect(transfersOf(run(sep(), ['', '', '']).calls)).toEqual(['7001']);
  });
  it('wrong entries after retries → Invalid', () => {
    expect(transfersOf(run(sep(), ['5555', '6666', '7777']).calls)).toEqual(['7002']);
  });
  it('too short after retries → Invalid (invalid_length falls back to invalid_option)', () => {
    expect(transfersOf(run(sep(), ['1', '12', '123']).calls)).toEqual(['7002']);
  });
  it('mixed reasons: the LAST one decides', () => {
    expect(transfersOf(run(sep(), ['5555', '5555', '']).calls)).toEqual(['7001']);
  });
  it('without a connected separate exit it still ends at Failed', () => {
    const n = sep();
    delete n.branches.no_input;
    expect(transfersOf(run(n, ['', '', '']).calls)).toEqual(['0000']);
  });
  it('the field is ignored when absent (previous behaviour: Failed)', () => {
    const n = sep();
    delete n.failure_exits;
    expect(transfersOf(run(n, ['', '', '']).calls)).toEqual(['0000']);
  });
});

describe('routes in the one-attempt and classic paths', () => {
  it('external: route, then _default, then invalid', () => {
    const node = { ...digitsNode(), retry_mode: 'external', branches: { route_a: 'to_transfer', invalid: 'to_invalid', timeout: 'to_no_input' } };
    expect(transfersOf(run(node, ['1234']).calls)).toEqual(['1111']);
    expect(transfersOf(run(node, ['5555']).calls)).toEqual(['7002']);
    expect(transfersOf(run(node, ['']).calls)).toEqual(['7001']);
  });
  it('classic: route, then the old lookup', () => {
    const node = { type: 'gather', min_digits: 4, max_digits: 4, prompt_text: 'Enter',
      routes: [{ id: 'a', type: 'equals', value: '1234' }],
      branches: { route_a: 'to_transfer', _default: 'to_hangup', timeout: 'to_no_input' } };
    expect(transfersOf(run(node, ['1234']).calls)).toEqual(['1111']);
    expect(transfersOf(run(node, ['5555']).calls)).toEqual(['9999']);
  });
});
