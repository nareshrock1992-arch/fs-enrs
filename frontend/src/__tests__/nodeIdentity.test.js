// Phase 1 — shared node display-identity resolver.
// Presentation-only: proves the strings the destination picker, canvas card,
// and validation messages render. No persistence or runtime behavior is touched.
import { describe, it, expect } from 'vitest';
import {
  nodeDisplayName, nodeDisplayDetail, nodeOptionLabel, shortNodeId, nodeHeaderParts,
  DEFAULT_NAME_BASES, defaultNodeName, isDefaultNodeName, copyNodeName, nodeDisplayNames,
} from '../components/ivr/canvas/nodeIdentity.js';
import { NODE_DEFAULTS, reducer } from '../hooks/useIvrGraph.js';

// Inline cfgs mirror the real registry entries (summaryTemplate values).
const TRANSFER = { label: 'Transfer', icon: '↗', summaryTemplate: '→ ${destination}' };
const SAY      = { label: 'Say',      icon: '🗣', summaryTemplate: '${text}' };
const QUEUE    = { label: 'Queue Eligibility', icon: '✅', summaryTemplate: 'Queue ${queue}' };
const HANGUP   = { label: 'Hang Up',  icon: '⛔' }; // no summaryTemplate

describe('nodeDisplayName — precedence', () => {
  it('1) administrator nickname wins over everything', () => {
    const n = { id: 'n1', type: 'transfer', nickname: 'Transfer to Control Room', destination: '7352', label: 'legacy' };
    expect(nodeDisplayName(n, TRANSFER)).toBe('Transfer to Control Room');
  });
  it('2) legacy label used when no nickname (read-only migration)', () => {
    const n = { id: 'n2', type: 'transfer', label: 'Old Name', destination: '7352' };
    expect(nodeDisplayName(n, TRANSFER)).toBe('Old Name');
  });
  it('3) meaningful config summary when no nickname/label', () => {
    const n = { id: 'n3', type: 'transfer', destination: '7352' };
    expect(nodeDisplayName(n, TRANSFER)).toBe('→ 7352');
  });
  it('4) node-type label when nothing distinguishing exists', () => {
    const n = { id: 'n4', type: 'transfer' }; // summary renders "→ ?" → not meaningful
    expect(nodeDisplayName(n, TRANSFER)).toBe('Transfer');
  });
  it('card variant (withSummary:false) skips summary — preserves canvas title behavior', () => {
    const withDest = { id: 'c1', type: 'transfer', destination: '7352' };
    expect(nodeDisplayName(withDest, TRANSFER, {}, { withSummary: false })).toBe('Transfer');
    const withNick = { id: 'c2', type: 'transfer', nickname: 'Ctrl Room', destination: '7352' };
    expect(nodeDisplayName(withNick, TRANSFER, {}, { withSummary: false })).toBe('Ctrl Room');
  });
});

describe('nodeDisplayName — missing/malformed config never crashes', () => {
  it('empty node + empty cfg → safe fallback', () => {
    expect(nodeDisplayName({}, {})).toBe('Node');
    expect(nodeDisplayName(null, null)).toBe('Node');
  });
  it('unresolved summary placeholder is not treated as meaningful', () => {
    const n = { id: 'x', type: 'say' }; // ${text} → "?" → ignored
    expect(nodeDisplayName(n, SAY)).toBe('Say');
  });
  it('whitespace-only nickname/label are ignored', () => {
    const n = { id: 'x', type: 'say', nickname: '   ', label: '  ', text: 'Hello' };
    expect(nodeDisplayName(n, SAY)).toBe('Hello');
  });
});

describe('nodeDisplayDetail', () => {
  it('returns the config summary when present', () => {
    expect(nodeDisplayDetail({ id: 'q', type: 'queue_eligibility', queue: 'support@default' }, QUEUE)).toBe('Queue support@default');
  });
  it('returns empty string when summary is missing/unresolved', () => {
    expect(nodeDisplayDetail({ id: 'h', type: 'hangup' }, HANGUP)).toBe('');
    expect(nodeDisplayDetail({ id: 't', type: 'transfer' }, TRANSFER)).toBe('');
  });
});

describe('nodeOptionLabel — destination picker options are distinguishable', () => {
  it('two Transfers with different destinations render differently', () => {
    const a = nodeOptionLabel({ id: 'a1', type: 'transfer', destination: '7352' }, TRANSFER);
    const b = nodeOptionLabel({ id: 'b1', type: 'transfer', destination: '7399' }, TRANSFER);
    expect(a).not.toBe(b);
    expect(a).toContain('7352');
    expect(b).toContain('7399');
    expect(a).toContain('Transfer');
  });
  it('two Say nodes with different nicknames render differently', () => {
    const a = nodeOptionLabel({ id: 's1', type: 'say', nickname: 'Welcome Caller', text: 'Hi' }, SAY);
    const b = nodeOptionLabel({ id: 's2', type: 'say', nickname: 'Emergency Instructions', text: 'Follow…' }, SAY);
    expect(a).not.toBe(b);
    expect(a).toContain('Welcome Caller');
    expect(b).toContain('Emergency Instructions');
  });
  it('collision: otherwise-identical options fall back to a unique #shortId', () => {
    const a = nodeOptionLabel({ id: 'node_aaaaaa111', type: 'transfer' }, TRANSFER);
    const b = nodeOptionLabel({ id: 'node_bbbbbb222', type: 'transfer' }, TRANSFER);
    expect(a).not.toBe(b);          // guaranteed distinct via id suffix
    expect(a).toContain('#');
    expect(a).toContain('Transfer');
  });
  it('never renders a doubled "Type — Type"', () => {
    const s = nodeOptionLabel({ id: 'z', type: 'transfer' }, TRANSFER);
    expect(s).not.toMatch(/Transfer — Transfer/);
  });
});

describe('nodeHeaderParts — title + non-redundant type eyebrow (Phase 2b)', () => {
  it('named node shows title AND the type eyebrow', () => {
    const n = { id: 't1', type: 'transfer', nickname: 'Route to Support', destination: '7352' };
    expect(nodeHeaderParts(n, TRANSFER)).toEqual({ title: 'Route to Support', typeLabel: 'Transfer' });
  });
  it('legacy-labelled node shows the type eyebrow too', () => {
    const n = { id: 't2', type: 'say', label: 'Greeting', text: 'Hi' };
    expect(nodeHeaderParts(n, SAY)).toEqual({ title: 'Greeting', typeLabel: 'Say' });
  });
  it('unnamed node shows the type once (no "Transfer / Transfer")', () => {
    const n = { id: 't3', type: 'transfer' }; // title falls back to type label
    expect(nodeHeaderParts(n, TRANSFER)).toEqual({ title: 'Transfer', typeLabel: null });
  });
  it('safe on empty node/cfg', () => {
    expect(nodeHeaderParts({}, {})).toEqual({ title: 'Node', typeLabel: null });
  });
});

describe('shortNodeId', () => {
  it('returns the last 6 chars, safe on missing id', () => {
    expect(shortNodeId({ id: 'node_abcdef123456' })).toBe('123456');
    expect(shortNodeId({})).toBe('');
  });
});

describe('default names — new nodes are named, never anonymous', () => {
  it('every node type in the palette (backend registry) has a default name base', async () => {
    const { NODE_TYPE_REGISTRY } = await import('../../../backend/src/nodeTypes/registry.js');
    expect(Object.keys(DEFAULT_NAME_BASES).sort()).toEqual(NODE_TYPE_REGISTRY.map(n => n.type).sort());
  });
  it('the first free number per type, case-insensitive', () => {
    expect(defaultNodeName('gather', {})).toBe('Menu 1');
    const nodes = { a: { type: 'gather', nickname: 'Menu 1' }, b: { type: 'gather', nickname: 'menu 3' }, c: { type: 'say' } };
    expect(defaultNodeName('gather', nodes)).toBe('Menu 2');
    expect(defaultNodeName('say', nodes)).toBe('Say 2');           // the unnamed Say is shown as "Say 1"
    expect(defaultNodeName('not_a_type', nodes)).toBeUndefined();
  });
  it('recognises a builder-given name until the administrator renames the node', () => {
    expect(isDefaultNodeName({ type: 'gather', nickname: 'Menu 12' })).toBe(true);
    expect(isDefaultNodeName({ type: 'gather', nickname: 'Main menu' })).toBe(false);
    expect(isDefaultNodeName({ type: 'say', nickname: 'Menu 1' })).toBe(false);
    expect(isDefaultNodeName({ type: 'rest_api', nickname: 'REST API 2' })).toBe(true);
  });
  it('duplicates never share a name', () => {
    const nodes = { a: { type: 'gather', nickname: 'Main menu' }, b: { type: 'gather', nickname: 'Main menu (copy)' }, c: { type: 'gather', nickname: 'Menu 1' } };
    expect(copyNodeName(nodes.a, nodes)).toBe('Main menu (copy 2)');
    expect(copyNodeName(nodes.c, nodes)).toBe('Menu 2');
    expect(copyNodeName({ type: 'say' }, nodes)).toBe('Say 1');
    expect(copyNodeName({ type: 'mystery' }, nodes)).toBeUndefined();
    expect(copyNodeName({ type: 'say', nickname: 'x'.repeat(200) }, {})).toHaveLength(200);
  });
  it('destination lists keep the config summary beside a default name', () => {
    expect(nodeOptionLabel({ id: 's1', type: 'say', nickname: 'Say 2', text: 'Welcome' }, SAY)).toBe('🗣 Say 2 · Welcome — Say');
    expect(nodeOptionLabel({ id: 's1', type: 'say', nickname: 'Greeting', text: 'Welcome' }, SAY)).toBe('🗣 Greeting — Say');
  });
});

describe('stand-in names — unnamed nodes in existing flows never show an internal id', () => {
  // Shapes from a flow built before nodes were named (ids are creation-ordered).
  const nodes = {
    node_1790057763158_6: { id: 'node_1790057763158_6', type: 'hangup' },
    node_1790057533120_2: { id: 'node_1790057533120_2', type: 'gather', max_digits: 1, timeout_seconds: 5 },
    node_1790059646271_2: { id: 'node_1790059646271_2', type: 'hangup' },
    node_1790057672287_4: { id: 'node_1790057672287_4', type: 'transfer', destination: '1000', nickname: 'Hangup 1' },
    greet:                { id: 'greet', type: 'say', text: 'Hello' },
  };
  const names = nodeDisplayNames(nodes);
  const resolvers = { displayName: id => names[id] };
  it('numbers unnamed nodes per type in creation order, skipping names already used', () => {
    expect(names).toEqual({
      node_1790057533120_2: 'Menu 1',
      node_1790057672287_4: 'Hangup 1',          // stored name wins
      node_1790057763158_6: 'Hangup 2',          // "Hangup 1" is taken by the named Transfer
      node_1790059646271_2: 'Hangup 3',
      greet: 'Say 1',                            // template ids come first
    });
  });
  it('is the same on the canvas title, in destination lists and in messages', () => {
    const hangup = nodes.node_1790057763158_6;
    expect(nodeHeaderParts(hangup, HANGUP, resolvers)).toEqual({ title: 'Hangup 2', typeLabel: 'Hang Up' });
    expect(nodeOptionLabel(hangup, HANGUP, resolvers)).toBe('⛔ Hangup 2 — Hang Up');
    expect(nodeOptionLabel(hangup, HANGUP, resolvers)).not.toContain('#');
    expect(nodeDisplayName(hangup, HANGUP, resolvers)).toBe('Hangup 2');
    // A summary stays beside the stand-in in lists, as it does for default names.
    expect(nodeOptionLabel(nodes.greet, SAY, resolvers)).toBe('🗣 Say 1 · Hello — Say');
  });
  it('callers that pass no stand-in names keep the previous behaviour', () => {
    expect(nodeOptionLabel(nodes.node_1790057763158_6, HANGUP)).toBe('⛔ #3158_6 — Hang Up');
    expect(nodeHeaderParts(nodes.node_1790057763158_6, HANGUP)).toEqual({ title: 'Hang Up', typeLabel: null });
  });
  it('is display only — the nodes are not changed', () => {
    expect(Object.values(nodes).filter(n => n.nickname)).toHaveLength(1);
  });
});

describe('the builder names the nodes it creates (reducer)', () => {
  const base = { nodes: {}, entryNodeId: null, selected: null, dirty: false };
  it('ADD_NODE gives the node a default name', () => {
    let s = reducer(base, { type: 'ADD_NODE', nodeType: 'gather', x: 0, y: 0 });
    s = reducer(s, { type: 'ADD_NODE', nodeType: 'gather', x: 0, y: 0 });
    s = reducer(s, { type: 'ADD_NODE', nodeType: 'transfer', x: 0, y: 0 });
    expect(Object.values(s.nodes).map(n => n.nickname)).toEqual(['Menu 1', 'Menu 2', 'Transfer 1']);
    // Everything else about a new node is unchanged.
    const menu = Object.values(s.nodes)[0];
    const { id, x, y, nickname, ...rest } = menu;      // eslint-disable-line no-unused-vars
    expect(rest).toEqual({ type: 'gather', ...NODE_DEFAULTS.gather });
  });
  it('DUPLICATE_NODE gives the copy its own name and keeps every setting', () => {
    const s0 = reducer(base, { type: 'ADD_NODE', nodeType: 'gather', x: 0, y: 0 });
    const src = { ...Object.values(s0.nodes)[0], nickname: 'Main menu', prompt_text: 'Hello' };
    const s1 = reducer({ ...s0, nodes: { [src.id]: src } }, { type: 'DUPLICATE_NODE', sourceNode: src, x: 10, y: 10 });
    const copy = Object.values(s1.nodes).find(n => n.id !== src.id);
    expect(copy.nickname).toBe('Main menu (copy)');
    expect(copy.prompt_text).toBe('Hello');
    expect(copy.branches).toEqual(src.branches);
  });
});
