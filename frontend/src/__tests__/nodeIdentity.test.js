// Phase 1 — shared node display-identity resolver.
// Presentation-only: proves the strings the destination picker, canvas card,
// and validation messages render. No persistence or runtime behavior is touched.
import { describe, it, expect } from 'vitest';
import {
  nodeDisplayName, nodeDisplayDetail, nodeOptionLabel, shortNodeId,
} from '../components/ivr/canvas/nodeIdentity.js';

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

describe('shortNodeId', () => {
  it('returns the last 6 chars, safe on missing id', () => {
    expect(shortNodeId({ id: 'node_abcdef123456' })).toBe('123456');
    expect(shortNodeId({})).toBe('');
  });
});
