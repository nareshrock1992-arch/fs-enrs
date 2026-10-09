// Inspector field sectioning (presentation-only).
import { describe, it, expect } from 'vitest';
import {
  sectionForFieldKey, sectionDefaultOpen, groupFields, SECTION_ORDER,
} from '../components/ivr/panels/fieldSections.js';

describe('sectionForFieldKey', () => {
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
    expect(sectionForFieldKey('hold_prompt')).toBe('Content');
  });
  it('routes digit-collection to Input', () => {
    expect(sectionForFieldKey('max_digits')).toBe('Input');
    expect(sectionForFieldKey('terminators')).toBe('Input');
  });
  it('routes timers/retries to Timeouts & retries', () => {
    expect(sectionForFieldKey('timeout_seconds')).toBe('Timeouts & retries');
    expect(sectionForFieldKey('max_attempts')).toBe('Timeouts & retries');
    expect(sectionForFieldKey('busy_delay_time')).toBe('Timeouts & retries');
  });
  it('falls back to General', () => {
    expect(sectionForFieldKey('ers_configuration_id')).toBe('General');
    expect(sectionForFieldKey('')).toBe('General');
  });
});

describe('sectionDefaultOpen — routing/content never hidden', () => {
  it('keeps routing-relevant sections open', () => {
    for (const s of ['General', 'Content', 'Input', 'Routing', 'Outputs']) {
      expect(sectionDefaultOpen(s)).toBe(true);
    }
  });
  it('collapses only timeouts/retries and advanced', () => {
    expect(sectionDefaultOpen('Timeouts & retries')).toBe(false);
    expect(sectionDefaultOpen('Advanced')).toBe(false);
  });
});

describe('groupFields', () => {
  it('produces ordered, non-empty sections preserving within-section order', () => {
    const schema = [
      { key: 'queue' }, { key: 'timeout_seconds' }, { key: 'branches' }, { key: 'text' },
    ];
    const g = groupFields(schema);
    expect(g.map(s => s.title)).toEqual(['Content', 'Routing', 'Timeouts & retries', 'Outputs']);
    expect(g.find(s => s.title === 'Routing').fields).toEqual([{ key: 'queue' }]);
  });
  it('never drops a field (every schema entry appears exactly once)', () => {
    const schema = [{ key: 'a' }, { key: 'destination' }, { key: 'next' }, { key: 'retry_mode' }];
    const g = groupFields(schema);
    const flat = g.flatMap(s => s.fields.map(f => f.key));
    expect(flat.sort()).toEqual(['a', 'destination', 'next', 'retry_mode'].sort());
  });
  it('is safe on empty/non-array input', () => {
    expect(groupFields()).toEqual([]);
    expect(groupFields(null)).toEqual([]);
  });
  it('SECTION_ORDER lists Outputs after Timeouts & retries', () => {
    expect(SECTION_ORDER.indexOf('Outputs')).toBeGreaterThan(SECTION_ORDER.indexOf('Timeouts & retries'));
  });
});
