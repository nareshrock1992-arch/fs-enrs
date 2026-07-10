import { describe, it, expect } from 'vitest';
import { validateGraph } from '../../utils/ivrGraphValidator.js';

// Regression guard for D2: "some nodes may legitimately be reachable via a
// gather node's branch and were miscounted as unreachable." refsOf() must
// include every value in node.branches (not just node.next), or a multi-
// level menu's deeper branches get flagged as dead code that doesn't exist.
// Uses only say/gather/hangup nodes — no ens/ers/audio DB lookups — so this
// runs with zero DB dependency.

describe('ivrGraphValidator — reachability via gather-node branches', () => {
  it('counts a node reachable only through a non-default digit branch (e.g. "2")', async () => {
    const graph = {
      entry_node_id: 'main_menu',
      nodes: {
        main_menu: {
          type: 'gather',
          prompt_text: 'Press 1 for sales, 2 for support',
          branches: { '1': 'sales', '2': 'level2_menu', invalid: 'main_menu' },
        },
        sales:       { type: 'hangup' },
        // level2_menu is reachable ONLY via main_menu's "2" branch —
        // this is exactly the shape the live "1222 Multi-Level Response"
        // flow uses and that an earlier audit miscounted as unreachable.
        level2_menu: {
          type: 'gather',
          prompt_text: 'Press 1 for billing, 2 for technical',
          branches: { '1': 'billing', '2': 'technical' },
        },
        billing:   { type: 'hangup' },
        technical: { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    expect(result.warnings.filter(w => w.includes('not reachable'))).toHaveLength(0);
    expect(result.stats.unreachable).toBe(0);
    expect(result.stats.reachable).toBe(6);
  });

  it('still flags a genuinely orphaned node not referenced by any branch', async () => {
    const graph = {
      entry_node_id: 'main_menu',
      nodes: {
        main_menu: { type: 'gather', branches: { '1': 'sales' } },
        sales:     { type: 'hangup' },
        orphan:    { type: 'hangup' }, // no node references this
      },
    };

    const result = await validateGraph(graph, 1);
    const unreachable = result.warnings.filter(w => w.includes('not reachable'));
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]).toContain('orphan');
  });
});

// Regression guard for Phase 1 item 12: publishing a genuinely valid ENS
// operator flow returned 400 because the OLD cycle detector flagged any
// single-ref node ("invalid PIN, try again") that looped back into an
// ancestor gather node — even though that gather node has other branches
// that reach hangup. The escape existed one level up from the node being
// checked, which the old same-node-only back-edge check could never see.
// The fix replaces back-edge detection with a proper reachability-to-
// terminal analysis: a node is only an error if NO path from it, however
// indirect, ever reaches a terminal node (hangup/ers/transfer).

describe('ivrGraphValidator — dead-end detection vs. valid retry chains', () => {
  it('does not flag a single-ref retry chain that loops back into a gather with an escape branch', async () => {
    // Exact shape of the ENS operator PIN-retry flow that triggered the
    // real 400: node_bad_pin has only ONE ref (back to node_collect_pin),
    // but node_collect_pin's OTHER branches reach node_hangup.
    const graph = {
      entry_node_id: 'node_collect_pin',
      nodes: {
        node_collect_pin: {
          type: 'gather',
          branches: { _default: 'node_check_pin', timeout: 'node_hangup', invalid: 'node_bad_pin' },
        },
        node_check_pin: {
          type: 'condition', variable: 'x', operator: '==', expected_value: '1',
          true_node: 'node_confirm', false_node: 'node_bad_pin',
        },
        node_bad_pin: { type: 'say', text: 'Invalid. Try again.', next: 'node_collect_pin' },
        node_confirm: { type: 'say', text: 'OK', next: 'node_hangup' },
        node_hangup:  { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    expect(result.errors.filter(e => e.includes('never reach an end of call'))).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('still flags a loop where no node anywhere can reach a terminal node', async () => {
    const graph = {
      entry_node_id: 'node_a',
      nodes: {
        node_a: { type: 'say', text: 'Hello', next: 'node_b' },
        node_b: { type: 'say', text: 'World', next: 'node_a' }, // no hangup/transfer/ers anywhere
      },
    };

    const result = await validateGraph(graph, 1);
    const deadEnds = result.errors.filter(e => e.includes('never reach an end of call'));
    expect(deadEnds.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('flags only the truly stuck branch when part of the graph has an exit and part does not', async () => {
    const graph = {
      entry_node_id: 'node_a',
      nodes: {
        node_a: {
          type: 'condition', variable: 'x', operator: '==', expected_value: '1',
          true_node: 'node_exit_ok', false_node: 'node_stuck_1',
        },
        node_exit_ok:  { type: 'hangup' },
        node_stuck_1:  { type: 'say', text: 'stuck', next: 'node_stuck_2' },
        node_stuck_2:  { type: 'say', text: 'still stuck', next: 'node_stuck_1' }, // isolated loop, no exit
      },
    };

    const result = await validateGraph(graph, 1);
    const deadEnds = result.errors.filter(e => e.includes('never reach an end of call'));
    expect(deadEnds.some(e => e.includes('node_stuck_1'))).toBe(true);
    expect(deadEnds.some(e => e.includes('node_stuck_2'))).toBe(true);
    expect(deadEnds.some(e => e.includes('node_a'))).toBe(false);
    expect(deadEnds.some(e => e.includes('node_exit_ok'))).toBe(false);
  });
});
