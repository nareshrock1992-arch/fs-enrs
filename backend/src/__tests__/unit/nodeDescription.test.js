/**
 * Generic node `description` — cosmetic canvas subtitle metadata.
 *
 * Scope (approved): a single optional base field, shared by all node types,
 * that never reaches the Lua/XML generator and never affects execution.
 *
 * These are static/schema/generator tests. Canvas display (combined summary +
 * description, and the Go To Node replace-case) is covered by the frontend
 * suite (frontend/src/__tests__/nodeDescription.test.js).
 */

import { describe, it, expect } from 'vitest';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';
import { generateDialplanXml } from '../../utils/xmlGenerator.js';

// A minimal valid node per representative type (covers plain, ERS, ENS, goto).
const validNodes = {
  say:      { type: 'say', text: 'hi', next: 'n2' },
  transfer: { type: 'transfer', destination: '7352' },
  goto:     { type: 'goto', target_node_id: 'n2' },
  ers:      { type: 'ers', ers_configuration_id: 1 },
  ens:      { type: 'ens', ens_configuration_id: 1 },
  gather:   { type: 'gather', branches: { '1': 'n2' } },
};

describe('description — Zod base field (shared .extend across all node types)', () => {
  it('accepts an optional description on every representative node type', () => {
    for (const [t, node] of Object.entries(validNodes)) {
      const r = AnyNodeSchema.safeParse({ ...node, description: 'Escalate unresolved billing calls to Tier 2' });
      expect(r.success, `${t} should accept description`).toBe(true);
    }
  });

  it('accepts a node with NO description (backward compatible)', () => {
    for (const [t, node] of Object.entries(validNodes)) {
      expect(AnyNodeSchema.safeParse(node).success, `${t} should validate without description`).toBe(true);
    }
  });

  it('bounds description length at 500 chars', () => {
    const ok  = AnyNodeSchema.safeParse({ ...validNodes.transfer, description: 'x'.repeat(500) });
    const bad = AnyNodeSchema.safeParse({ ...validNodes.transfer, description: 'x'.repeat(501) });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('rejects a non-string description', () => {
    expect(AnyNodeSchema.safeParse({ ...validNodes.transfer, description: 123 }).success).toBe(false);
  });
});

describe('description — never reaches code generation (purely cosmetic)', () => {
  const lua = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: 'http://p' });

  it('the generated Lua executor never references node.description', () => {
    // The executor is generated from the registry (node-independent), and no
    // node handler reads a description field — so a description can never appear
    // in generated Lua. Adding/removing it is byte-identical for the executor.
    expect(lua).not.toContain('node.description');
    expect(lua).not.toContain('description');
  });

  it('the generated dialplan XML never contains a description (bindings carry no node bodies)', () => {
    const xml = generateDialplanXml(
      [{ number: '1222', flow_uuid: 'abc-123', flow_name: 'Test Flow', version_number: 1 }],
      { nested: true },
    );
    expect(xml).not.toContain('description');
  });
});
