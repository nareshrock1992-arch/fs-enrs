import { describe, it, expect } from 'vitest';
import { validateGraph } from '../../utils/ivrGraphValidator.js';
import { AnyNodeSchemaDraft, AnyNodeSchema } from '../../validators/ivrValidator.js';

// Regression guard for D2: "some nodes may legitimately be reachable via a
// gather node's branch and were miscounted as unreachable." refsOf() must
// include every value in node.branches (not just node.next), or a multi-
// level menu's deeper branches get flagged as dead code that doesn't exist.
// Uses only say/gather/hangup nodes — no ens/ers/audio DB lookups — so this
// runs with zero DB dependency.

// ── Per-node cross-field error format ─────────────────────────────────────────
//
// Regression guard: errors from superRefine (cross-field rules like min_digits >
// max_digits) must be formatted as "node <nid>.<field>: message" — not as
// "nodes.<nid>: message" (the Zod record path). The frontend regex
// /^node ([^.\s:]+)/ must be able to extract the node ID.

describe('ivrGraphValidator — cross-field error format', () => {
  it('formats gather min_digits > max_digits as "node <nid>.type: message" (regex-parseable)', async () => {
    const graph = {
      entry_node_id: 'n_gather',
      nodes: {
        n_gather: {
          type: 'gather',
          min_digits: 6,
          max_digits: 4,
          branches: { _default: 'n_hangup' },
        },
        n_hangup: { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    expect(result.valid).toBe(false);

    // Every error must start with "node " (not "nodes.") for the frontend to
    // extract the node ID with /^node ([^.\s:]+)/.
    for (const e of result.errors) {
      expect(e).toMatch(/^node /);
    }

    // Error must reference the gather node ID.
    const gatherError = result.errors.find(e => e.includes('n_gather'));
    expect(gatherError).toBeDefined();
    expect(gatherError).toMatch(/min_digits/);
  });

  it('does not format per-node errors as "nodes.<nid>: message"', async () => {
    const graph = {
      entry_node_id: 'n_gather',
      nodes: {
        n_gather: {
          type: 'gather',
          min_digits: 10,
          max_digits: 2,
          branches: { _default: 'n_hangup' },
        },
        n_hangup: { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    for (const e of result.errors) {
      expect(e).not.toMatch(/^nodes\./);
    }
  });

  it('validates play node missing audio source', async () => {
    const graph = {
      entry_node_id: 'n_play',
      nodes: {
        n_play: { type: 'play', next: 'n_hangup' }, // no audio_file_id, no audio_url
        n_hangup: { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    expect(result.valid).toBe(false);
    const playError = result.errors.find(e => e.includes('n_play'));
    expect(playError).toBeDefined();
    expect(playError).toMatch(/^node /);
  });

  it('reports multiple node errors independently with correct node IDs', async () => {
    const graph = {
      entry_node_id: 'n_a',
      nodes: {
        n_a: {
          type: 'gather',
          min_digits: 8,
          max_digits: 2,
          branches: { _default: 'n_b' },
        },
        n_b: {
          type: 'gather',
          min_digits: 5,
          max_digits: 1,
          branches: { _default: 'n_hangup' },
        },
        n_hangup: { type: 'hangup' },
      },
    };

    const result = await validateGraph(graph, 1);
    expect(result.valid).toBe(false);
    const aErrors = result.errors.filter(e => e.includes('n_a'));
    const bErrors = result.errors.filter(e => e.includes('n_b'));
    expect(aErrors.length).toBeGreaterThan(0);
    expect(bErrors.length).toBeGreaterThan(0);
  });
});

// ── Draft save contract ───────────────────────────────────────────────────────
//
// The validate endpoint validates the graph the caller submits (not just the
// DB copy). These tests exercise the AnyNodeSchema directly to confirm that:
// a) AnyNodeSchemaDraft allows intermediate/invalid cross-field states.
// b) AnyNodeSchema (full) catches them.

describe('ivrValidator — AnyNodeSchemaDraft vs AnyNodeSchema', () => {
  it('AnyNodeSchemaDraft allows min_digits > max_digits (draft-save contract)', () => {
    const node = {
      type: 'gather',
      min_digits: 6,
      max_digits: 4,
      branches: { _default: 'x' },
    };

    expect(AnyNodeSchemaDraft.safeParse(node).success).toBe(true);
    expect(AnyNodeSchema.safeParse(node).success).toBe(false);
  });

  it('AnyNodeSchemaDraft allows play node without audio (draft-save contract)', () => {
    const node = { type: 'play', next: 'somewhere' }; // no audio_file_id or audio_url

    expect(AnyNodeSchemaDraft.safeParse(node).success).toBe(true);
    expect(AnyNodeSchema.safeParse(node).success).toBe(false);
  });

  it('AnyNodeSchemaDraft still rejects unknown node types', () => {
    const node = { type: 'unknown_type', next: 'x' };
    expect(AnyNodeSchemaDraft.safeParse(node).success).toBe(false);
  });

  it('AnyNodeSchema errors have no "gather: " or node-type prefix in message', () => {
    const node = { type: 'gather', min_digits: 6, max_digits: 4, branches: { _default: 'x' } };
    const r = AnyNodeSchema.safeParse(node);
    expect(r.success).toBe(false);
    for (const issue of r.error.issues) {
      // Messages must not start with node type prefix (e.g. "gather: ")
      expect(issue.message).not.toMatch(/^gather:/);
      expect(issue.message).not.toMatch(/^play:/);
      expect(issue.message).not.toMatch(/^hangup:/);
      expect(issue.message).not.toMatch(/^ens_blast_record:/);
    }
  });
});

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
