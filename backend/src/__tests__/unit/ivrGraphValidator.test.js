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
