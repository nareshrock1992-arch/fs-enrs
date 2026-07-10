import { describe, it, expect } from 'vitest';
import { NODE_TYPE_REGISTRY, getNodeType, publicNodeTypes } from '../../nodeTypes/registry.js';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

const ORIGINAL_11_TYPES = [
  'play', 'say', 'gather', 'condition', 'goto',
  'ens', 'ers', 'hangup', 'record_message', 'set_variable', 'transfer',
];

describe('Phase 3 — node-type registry completeness (pure refactor)', () => {
  it('contains exactly the 11 pre-existing node types, none dropped or renamed', () => {
    const types = NODE_TYPE_REGISTRY.map(n => n.type);
    for (const t of ORIGINAL_11_TYPES) expect(types).toContain(t);
    expect(types.filter(t => ORIGINAL_11_TYPES.includes(t))).toHaveLength(11);
  });

  it('every entry has a non-empty luaHandler and configSchema', () => {
    for (const n of NODE_TYPE_REGISTRY) {
      expect(n.luaHandler, `${n.type} missing luaHandler`).toBeTruthy();
      expect(n.luaHandler).toContain(`exec_${n.type}`);
      expect(Array.isArray(n.configSchema), `${n.type} configSchema must be an array`).toBe(true);
    }
  });

  it('getNodeType() looks up by type, returns null for unknown types', () => {
    expect(getNodeType('play')?.type).toBe('play');
    expect(getNodeType('nonexistent_type')).toBeNull();
  });
});

describe('Phase 3 — publicNodeTypes() never leaks Lua source to the frontend', () => {
  it('strips luaHandler and apiEndpoint from the public shape', () => {
    for (const n of publicNodeTypes()) {
      expect(n).not.toHaveProperty('luaHandler');
      expect(n).not.toHaveProperty('apiEndpoint');
    }
  });

  it('still includes everything the frontend needs to render generically', () => {
    const play = publicNodeTypes().find(n => n.type === 'play');
    expect(play.configSchema.some(f => f.key === 'audio_url')).toBe(true);
    expect(play.icon).toBeTruthy();
    expect(play.category).toBeTruthy();
  });
});

describe('Phase 3 — luaGenerator.js dispatch table is registry-driven', () => {
  const lua = generateIvrExecutorLua({ apiBase: 'http://127.0.0.1:4100', apiKey: 'k', ttsEngine: 'flite|kal' });

  it('generates an exec_<type> handler function for every registry entry', () => {
    for (const n of NODE_TYPE_REGISTRY) {
      expect(lua).toContain(`local function exec_${n.type}(s, node)`);
    }
  });

  it('generates a dispatch table entry for every registry entry, with goto correctly quoted', () => {
    for (const n of NODE_TYPE_REGISTRY) {
      if (n.type === 'goto') {
        expect(lua).toMatch(/\["goto"\]\s*=\s*exec_goto,/);
      } else {
        expect(lua).toMatch(new RegExp(`\\b${n.type}\\s*=\\s*exec_${n.type},`));
      }
    }
  });

  it('adding a node type to the registry alone is enough to add its handler and dispatch entry (no luaGenerator.js edits needed)', () => {
    // Proves the loop is genuinely data-driven: count matches the registry
    // length exactly, not a hardcoded number.
    const handlerCount = (lua.match(/^local function exec_\w+\(s, node\)/gm) || []).length;
    expect(handlerCount).toBe(NODE_TYPE_REGISTRY.length);
  });

  it('the webhook proof node type (added purely as a registry entry) is present and dispatched', () => {
    expect(lua).toContain('local function exec_webhook(s, node)');
    expect(lua).toMatch(/\bwebhook\s*=\s*exec_webhook,/);
    expect(lua).toContain('io.popen(cmd)'); // reuses the same curl pattern, not a bespoke transport
  });
});
