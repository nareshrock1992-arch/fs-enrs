/**
 * Node name (`nickname`) — the administrator's display name for a node.
 *
 * Regression guard: the save path (PUT /ivr/flows/:uuid → UpdateFlowSchema)
 * stores the PARSED graph, and the per-node schemas strip unknown keys. Before
 * `nickname` was a base field, every save silently dropped node names, so a
 * renamed node showed its default title again after reload.
 *
 * The name is cosmetic: it must never reach the Lua/XML generators.
 */

import { describe, it, expect } from 'vitest';
import { AnyNodeSchema, UpdateFlowSchema } from '../../validators/ivrValidator.js';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

const validNodes = {
  say:      { type: 'say', text: 'hi', next: 'n2' },
  transfer: { type: 'transfer', destination: '7352' },
  goto:     { type: 'goto', target_node_id: 'n2' },
  gather:   { type: 'gather', branches: { '1': 'n2' } },
  gatherV2: { type: 'gather', config_version: 2, retry_mode: 'internal', max_attempts: 3, branches: { '1': 'n2' } },
};

describe('nickname — kept by the save path', () => {
  it('UpdateFlowSchema keeps the node name on every representative node type', () => {
    const nodes = {};
    for (const [id, node] of Object.entries(validNodes)) nodes[id] = { ...node, nickname: `Name of ${id}` };
    const r = UpdateFlowSchema.safeParse({ graph: { entry_node_id: 'say', nodes } });
    expect(r.success).toBe(true);
    for (const id of Object.keys(validNodes)) {
      expect(r.data.graph.nodes[id].nickname, `${id} keeps its name`).toBe(`Name of ${id}`);
    }
  });

  it('a node without a name still saves unchanged (backward compatible)', () => {
    const r = UpdateFlowSchema.safeParse({ graph: { entry_node_id: 'gather', nodes: { gather: validNodes.gather } } });
    expect(r.success).toBe(true);
    expect(r.data.graph.nodes.gather).not.toHaveProperty('nickname');
  });

  it('bounds the name at 200 characters and rejects non-strings', () => {
    expect(AnyNodeSchema.safeParse({ ...validNodes.transfer, nickname: 'x'.repeat(200) }).success).toBe(true);
    expect(AnyNodeSchema.safeParse({ ...validNodes.transfer, nickname: 'x'.repeat(201) }).success).toBe(false);
    expect(AnyNodeSchema.safeParse({ ...validNodes.transfer, nickname: 42 }).success).toBe(false);
  });

  it('does not change how any other field is stored', () => {
    const base = { ...validNodes.gatherV2, prompt_text: 'Press 1' };
    const a = UpdateFlowSchema.safeParse({ graph: { entry_node_id: 'g', nodes: { g: base } } });
    const b = UpdateFlowSchema.safeParse({ graph: { entry_node_id: 'g', nodes: { g: { ...base, nickname: 'Main menu' } } } });
    // eslint-disable-next-line no-unused-vars
    const { nickname, ...withoutName } = b.data.graph.nodes.g;
    expect(withoutName).toEqual(a.data.graph.nodes.g);
  });
});

describe('nickname — never reaches code generation', () => {
  it('the generated Lua executor never references node.nickname', () => {
    const lua = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: 'http://p' });
    expect(lua).not.toContain('nickname');
  });
});
