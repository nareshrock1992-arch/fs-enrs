// Inspector field sectioning (presentation-only) — unit + registry-driven.
import { describe, it, expect } from 'vitest';
import {
  sectionForFieldKey, sectionDefaultOpen, groupFields, SECTION_ORDER,
} from '../components/ivr/panels/fieldSections.js';
// Registry is pure data (no top-level imports) — safe to import in a frontend test.
import { NODE_TYPE_REGISTRY } from '../../../backend/src/nodeTypes/registry.js';

describe('sectionForFieldKey — unit rules', () => {
  it('routes onward-journey keys to Outputs', () => {
    for (const k of ['next', 'branches', 'goto', 'target_node_id', 'true_node', 'false_node']) {
      expect(sectionForFieldKey(k)).toBe('Outputs');
    }
  });
  it('routes destination/dialplan/queue to Routing', () => {
    expect(sectionForFieldKey('destination')).toBe('Routing');
    expect(sectionForFieldKey('dialplan')).toBe('Routing');
    expect(sectionForFieldKey('context')).toBe('Routing');
    expect(sectionForFieldKey('queue')).toBe('Routing');
  });
  it('routes prompts/audio to Content', () => {
    expect(sectionForFieldKey('text')).toBe('Content');
    expect(sectionForFieldKey('audio_url')).toBe('Content');
    expect(sectionForFieldKey('hold_prompt_text')).toBe('Content');
  });
  it('Fix A: silence_threshold is NOT Content (it merely contains "…hold")', () => {
    expect(sectionForFieldKey('silence_threshold')).not.toBe('Content');
    // genuine hold_ fields still go to Content
    expect(sectionForFieldKey('hold_source_type')).toBe('Content');
    expect(sectionForFieldKey('hold_audio_url')).toBe('Content');
  });
  it('Fix B: per-outcome prompt source/replay selectors go to Content (not timing)', () => {
    for (const k of [
      'no_input_source_type', 'no_input_replay_menu',
      'invalid_length_source_type', 'invalid_length_replay_menu',
      'invalid_option_source_type', 'invalid_option_replay_menu',
      'max_attempts_exceeded_source_type',
    ]) {
      expect(sectionForFieldKey(k)).toBe('Content');
    }
  });
  it('retry BEHAVIOR goes to the open Retries section', () => {
    expect(sectionForFieldKey('retry_mode')).toBe('Retries');
    expect(sectionForFieldKey('retry_on_no_input')).toBe('Retries');
    expect(sectionForFieldKey('max_attempts')).toBe('Retries');
  });
  it('pure timing goes to the collapsible Timeouts section', () => {
    expect(sectionForFieldKey('timeout_seconds')).toBe('Timeouts');
    expect(sectionForFieldKey('ring_timeout_seconds')).toBe('Timeouts');
    expect(sectionForFieldKey('max_wait_seconds')).toBe('Timeouts');
  });
  it('falls back to General', () => {
    expect(sectionForFieldKey('ers_configuration_id')).toBe('General');
    expect(sectionForFieldKey('')).toBe('General');
  });
});

describe('sectionDefaultOpen — routing/content/retries never hidden', () => {
  it('keeps routing-relevant + retry-behavior sections open', () => {
    for (const s of ['General', 'Content', 'Input', 'Routing', 'Retries', 'Outputs']) {
      expect(sectionDefaultOpen(s)).toBe(true);
    }
  });
  it('collapses only pure timing and advanced', () => {
    expect(sectionDefaultOpen('Timeouts')).toBe(false);
    expect(sectionDefaultOpen('Advanced')).toBe(false);
  });
});

describe('groupFields — structure', () => {
  it('ordered, non-empty sections preserving within-section order', () => {
    const schema = [{ key: 'queue' }, { key: 'timeout_seconds' }, { key: 'branches' }, { key: 'text' }];
    const g = groupFields(schema);
    expect(g.map(s => s.title)).toEqual(['Content', 'Routing', 'Timeouts', 'Outputs']);
  });
  it('safe on empty/non-array input', () => {
    expect(groupFields()).toEqual([]);
    expect(groupFields(null)).toEqual([]);
  });
});

// ── Registry-driven invariants (the audit's required checks) ────────────────────
describe('registry-driven sectioning invariants', () => {
  const withSchema = NODE_TYPE_REGISTRY.filter(n => (n.configSchema || []).length);

  it('1) every REQUIRED field in every node type sits in a default-OPEN section', () => {
    const offenders = [];
    for (const n of withSchema) {
      for (const f of n.configSchema) {
        if (f.required && !sectionDefaultOpen(sectionForFieldKey(f.key))) {
          offenders.push(`${n.type}.${f.key} → ${sectionForFieldKey(f.key)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('2) no registry key containing "threshold" is classified as Content', () => {
    const bad = [];
    for (const n of withSchema) {
      for (const f of n.configSchema) {
        if (/threshold/i.test(f.key) && sectionForFieldKey(f.key) === 'Content') bad.push(`${n.type}.${f.key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('3) Gather prompt-source + replay-menu selectors are in Content (open), not hidden', () => {
    const gather = NODE_TYPE_REGISTRY.find(n => n.type === 'gather');
    const selectorKeys = gather.configSchema
      .map(f => f.key)
      .filter(k => /(_source_type|_replay_menu)$/.test(k));
    expect(selectorKeys.length).toBeGreaterThan(0);
    for (const k of selectorKeys) {
      expect(sectionForFieldKey(k)).toBe('Content');
      expect(sectionDefaultOpen('Content')).toBe(true);
    }
  });

  it('4) all actual onward-routing fields remain in Outputs', () => {
    const routing = new Set(['next', 'branches', 'goto', 'target_node_id', 'true_node', 'false_node']);
    for (const n of withSchema) {
      for (const f of n.configSchema) {
        if (routing.has(f.key)) expect(sectionForFieldKey(f.key)).toBe('Outputs');
      }
    }
  });

  it('5) every registered field appears exactly once across sections', () => {
    for (const n of withSchema) {
      const keys = n.configSchema.map(f => f.key);
      const flat = groupFields(n.configSchema).flatMap(s => s.fields.map(f => f.key));
      expect(flat.slice().sort()).toEqual(keys.slice().sort());
      expect(flat.length).toBe(keys.length); // no duplication
    }
  });
});
