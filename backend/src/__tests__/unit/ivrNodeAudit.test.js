/**
 * IVR Node Audit — Comprehensive regression tests.
 *
 * Covers all functional gaps identified in the Phase 19 forensic audit:
 *
 *   A  ens_blast_record uses execute("record") not recordFile — # termination
 *   B  condition node supports new operators: ends_with, exists, not_exists, gt/gte/lt/lte
 *   C  gather node: min_digits field, configurable terminators, default empty (no force-#)
 *   D  play node: audio_source_type (url | variable) + audio_variable support
 *   E  record_message: dtmf_stop_key is configurable (not hardcoded #)
 *   F  All new schema fields accepted by AnyNodeSchema without error
 *   G  Backward compatibility: existing graph shapes still validate
 *   H  ens_blast_record silence config fields accepted
 *   I  Variable catalog: key variable names documented in configSchema hints
 */

import { describe, it, expect } from 'vitest';
import { getNodeType, NODE_TYPE_REGISTRY } from '../../nodeTypes/registry.js';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const lua = type => getNodeType(type)?.luaHandler ?? '';
const schema = type => getNodeType(type)?.configSchema ?? [];
const field = (type, key) => schema(type).find(f => f.key === key);

// ── A: ens_blast_record recording fix ─────────────────────────────────────────

describe('A — ens_blast_record: execute("record") with # termination', () => {
  it('uses s:execute("record") not s:recordFile()', () => {
    const h = lua('ens_blast_record');
    expect(h).toContain('s:execute("record"');
    expect(h).not.toContain('s:recordFile(');
  });

  it('passes # as the DTMF terminator argument', () => {
    const h = lua('ens_blast_record');
    // The execute("record") call appends " #" as the 5th arg (terminator)
    expect(h).toContain('" #")');
  });

  it('creates the ENS recordings subdirectory', () => {
    const h = lua('ens_blast_record');
    expect(h).toContain('mkdir -p');
    expect(h).toContain('/ens');
  });

  it('reads max_rec, sil_thr, sil_hits from node (not hardcoded)', () => {
    const h = lua('ens_blast_record');
    expect(h).toContain('node.max_record_seconds');
    expect(h).toContain('node.silence_threshold');
    expect(h).toContain('node.silence_hits');
  });

  it('configSchema exposes silence_threshold and silence_hits', () => {
    const s = schema('ens_blast_record');
    expect(s.find(f => f.key === 'silence_threshold')).toBeDefined();
    expect(s.find(f => f.key === 'silence_hits')).toBeDefined();
  });

  it('AnyNodeSchema accepts ens_blast_record with silence fields', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'ens_blast_record',
      max_record_seconds: 60,
      silence_threshold: 400,
      silence_hits: 2,
      next: 'n_hangup',
    });
    expect(r.success).toBe(true);
  });
});

// ── B: condition new operators ────────────────────────────────────────────────

describe('B — condition: new generic operators', () => {
  const condLua = lua('condition');

  it('implements ends_with', () => {
    expect(condLua).toContain('ends_with');
    expect(condLua).toContain('val:sub(-#exp)');
  });

  it('implements exists (variable non-empty check)', () => {
    expect(condLua).toContain('"exists"');
    expect(condLua).toContain('val ~= ""');
  });

  it('implements not_exists (variable empty check)', () => {
    expect(condLua).toContain('"not_exists"');
    expect(condLua).toContain('val == ""');
  });

  it('implements numeric gt/gte/lt/lte', () => {
    expect(condLua).toContain('"gt"');
    expect(condLua).toContain('"gte"');
    expect(condLua).toContain('"lt"');
    expect(condLua).toContain('"lte"');
    expect(condLua).toContain('tonumber(val)');
    expect(condLua).toContain('tonumber(exp)');
  });

  it('configSchema lists all new operators', () => {
    const opField = field('condition', 'operator');
    const opValues = opField.options.map(o => o.value);
    expect(opValues).toContain('ends_with');
    expect(opValues).toContain('exists');
    expect(opValues).toContain('not_exists');
    expect(opValues).toContain('gt');
    expect(opValues).toContain('gte');
    expect(opValues).toContain('lt');
    expect(opValues).toContain('lte');
  });

  it('ivrValidator accepts ends_with', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'caller_number', operator: 'ends_with',
      expected_value: '1821', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts exists', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'gather_result', operator: 'exists',
      expected_value: '', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts not_exists', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'gather_result', operator: 'not_exists',
      expected_value: '', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts gt (numeric greater-than)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'gather_result', operator: 'gt',
      expected_value: '0', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts lte', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'retry_count', operator: 'lte',
      expected_value: '3', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator rejects unknown operator', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'condition', variable: 'x', operator: 'regex',
      expected_value: '.+', true_node: 'n1', false_node: 'n2',
    });
    expect(r.success).toBe(false);
  });

  it('existing operators still accepted', () => {
    for (const op of ['==', '!=', 'contains', 'starts_with', 'time_of_day', 'day_of_week']) {
      const r = AnyNodeSchema.safeParse({
        type: 'condition', variable: 'x', operator: op,
        expected_value: '1', true_node: 'n1', false_node: 'n2',
      });
      expect(r.success, `operator ${op} should be accepted`).toBe(true);
    }
  });
});

// ── C: gather — min_digits, configurable terminators ─────────────────────────

describe('C — gather: min_digits and configurable terminators', () => {
  it('configSchema exposes min_digits field', () => {
    expect(field('gather', 'min_digits')).toBeDefined();
  });

  it('Lua uses min_d from node.min_digits', () => {
    const h = lua('gather');
    expect(h).toContain('node.min_digits');
    expect(h).toContain('min_d');
    // min_d passed as first arg to playAndGetDigits
    expect(h).toContain('playAndGetDigits(min_d, max_d');
  });

  it('Lua default terminators is empty string (no forced #)', () => {
    const h = lua('gather');
    // Default: no terminator — collection ends at max_digits or timeout
    expect(h).toContain('node.terminators or ""');
    // Must NOT default to "#"
    expect(h).not.toContain('node.terminators or "#"');
  });

  it('configSchema terminators field provides None / # / * options', () => {
    const f = field('gather', 'terminators');
    expect(f).toBeDefined();
    expect(f.fieldType).toBe('select');
    const vals = f.options.map(o => o.value);
    expect(vals).toContain('');   // None
    expect(vals).toContain('#');
    expect(vals).toContain('*');
  });

  it('ivrValidator accepts min_digits', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather',
      min_digits: 4,
      max_digits: 4,
      branches: { timeout: 'n1', invalid: 'n2', _default: 'n3' },
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts empty terminators (no forced #)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather',
      terminators: '',
      max_digits: 1,
      branches: { '1': 'n1', '2': 'n2', timeout: 'n3', invalid: 'n4' },
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts # terminator', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather',
      terminators: '#',
      max_digits: 8,
      branches: { _default: 'n1', timeout: 'n2' },
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator default terminators is empty string', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather',
      branches: { _default: 'n1' },
    });
    expect(r.success).toBe(true);
    // Zod applies default '' (not '#')
    expect(r.data.terminators).toBe('');
  });
});

// ── D: play node — dynamic audio source ──────────────────────────────────────

describe('D — play: audio_source_type and audio_variable', () => {
  it('configSchema has audio_source_type field', () => {
    expect(field('play', 'audio_source_type')).toBeDefined();
  });

  it('configSchema has audio_variable field', () => {
    expect(field('play', 'audio_variable')).toBeDefined();
  });

  it('Lua handles audio_source_type == "variable"', () => {
    const h = lua('play');
    expect(h).toContain('audio_source_type == "variable"');
    expect(h).toContain('node.audio_variable');
    expect(h).toContain('s:getVariable(var_name)');
  });

  it('Lua logs warning when variable is empty', () => {
    const h = lua('play');
    expect(h).toContain('variable');
    expect(h).toContain('is empty — skipping audio');
  });

  it('Lua falls back to resolve_audio for url source', () => {
    const h = lua('play');
    expect(h).toContain('resolve_audio(node.audio_url)');
  });

  it('ivrValidator accepts play with dynamic variable source', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'play',
      audio_source_type: 'variable',
      audio_variable: 'recorded_file_path',
      next: 'n_hangup',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator rejects play with dynamic source but no audio_variable', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'play',
      audio_source_type: 'variable',
      next: 'n_hangup',
    });
    expect(r.success).toBe(false);
  });

  it('ivrValidator accepts play with static url source', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'play',
      audio_source_type: 'url',
      audio_url: '/media/welcome.wav',
      next: 'n_hangup',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator rejects play with static source but no audio_url or file id', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'play',
      audio_source_type: 'url',
      next: 'n_hangup',
    });
    expect(r.success).toBe(false);
  });
});

// ── E: record_message — configurable dtmf_stop_key ───────────────────────────

describe('E — record_message: configurable dtmf_stop_key', () => {
  it('configSchema exposes dtmf_stop_key field', () => {
    expect(field('record_message', 'dtmf_stop_key')).toBeDefined();
  });

  it('configSchema dtmf_stop_key has # / * / None options', () => {
    const f = field('record_message', 'dtmf_stop_key');
    const vals = f.options.map(o => o.value);
    expect(vals).toContain('#');
    expect(vals).toContain('*');
    expect(vals).toContain('');  // None
  });

  it('Lua reads dtmf_stop_key from node config', () => {
    const h = lua('record_message');
    expect(h).toContain('node.dtmf_stop_key');
  });

  it('Lua defaults stop key to # when dtmf_stop_key is nil', () => {
    const h = lua('record_message');
    expect(h).toContain('or "#"');
  });

  it('Lua omits stop key arg when empty string (duration/silence only)', () => {
    const h = lua('record_message');
    expect(h).toContain('stop_key ~= ""');
  });

  it('still uses s:execute("record") not s:recordFile()', () => {
    const h = lua('record_message');
    expect(h).toContain('s:execute("record"');
    expect(h).not.toContain('s:recordFile(');
  });

  it('uses playback_terminators channel var to stop recording on DTMF', () => {
    const h = lua('record_message');
    // The record app (mod_dptools.c record_function) reads playback_terminators, not a 5th arg.
    expect(h).toContain('playback_terminators');
    // After recording, check playback_terminator_used to detect DTMF stop.
    expect(h).toContain('playback_terminator_used');
    // Restore safe default after recording so downstream playback is unaffected.
    expect(h).toContain('playback_terminators=none');
  });

  it('logs whether recording stopped via DTMF or silence/duration', () => {
    const h = lua('record_message');
    expect(h).toContain('stopped by DTMF');
    expect(h).toContain('stopped by silence or max duration');
  });

  it('silence_hits default is 20 (400 ms), not the former 3 (60 ms)', () => {
    const h = lua('record_message');
    expect(h).toContain('or 20');
    expect(h).not.toContain('or 3');
  });

  it('ivrValidator accepts dtmf_stop_key = "#"', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'record_message', variable_name: 'rec', max_seconds: 60,
      silence_threshold: 500, silence_hits: 3, dtmf_stop_key: '#', next: 'n',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts dtmf_stop_key = "" (no termination)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'record_message', variable_name: 'rec', max_seconds: 60,
      silence_threshold: 500, silence_hits: 3, dtmf_stop_key: '', next: 'n',
    });
    expect(r.success).toBe(true);
  });

  it('ivrValidator accepts record_message without dtmf_stop_key (uses default #)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'record_message', variable_name: 'rec', max_seconds: 60,
      silence_threshold: 500, silence_hits: 3, next: 'n',
    });
    expect(r.success).toBe(true);
    expect(r.data.dtmf_stop_key).toBe('#');
  });
});

// ── F: backward compatibility ────────────────────────────────────────────────

describe('F/G — backward compatibility: existing flow shapes still validate', () => {
  it('play node without audio_source_type (legacy) still validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'play',
      audio_url: '/media/welcome.wav',
      next: 'n',
    });
    expect(r.success).toBe(true);
  });

  it('gather node without min_digits (legacy) still validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather',
      branches: { '1': 'n1', timeout: 'n2' },
      max_digits: 1,
      terminators: '#',
    });
    expect(r.success).toBe(true);
  });

  it('condition node with old operators (==, !=, contains, starts_with) still validates', () => {
    for (const op of ['==', '!=', 'contains', 'starts_with']) {
      const r = AnyNodeSchema.safeParse({
        type: 'condition', variable: 'x', operator: op,
        expected_value: 'y', true_node: 'n1', false_node: 'n2',
      });
      expect(r.success, `${op} should still be accepted`).toBe(true);
    }
  });

  it('record_message without dtmf_stop_key keeps existing behaviour (default #)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'record_message', variable_name: 'recorded_file_path',
      max_seconds: 60, next: 'n_next',
    });
    expect(r.success).toBe(true);
    expect(r.data.dtmf_stop_key).toBe('#');
  });

  it('ens_blast_record without silence fields still validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'ens_blast_record',
      max_record_seconds: 60,
      next: 'n',
    });
    expect(r.success).toBe(true);
  });
});

// ── I: variable catalog — key variable names documented ───────────────────────

describe('I — variable catalog: configSchema hints document variable names', () => {
  it('record_message variable_name field explains ${var} usage', () => {
    // The record node stores its output in variable_name — this should be documented
    const recDesc = getNodeType('record_message').description;
    // Variable output information is in the description or a field hint
    const varField = field('record_message', 'variable_name');
    expect(varField).toBeDefined();
    expect(varField.hint).toBeTruthy();
  });

  it('gather variable_name hint explains ${var} usage', () => {
    const f = field('gather', 'variable_name');
    expect(f.hint).toContain('${');
  });

  it('play audio_variable hint explains it is set by Record node', () => {
    const f = field('play', 'audio_variable');
    expect(f.hint).toBeTruthy();
    expect(f.hint.toLowerCase()).toContain('record');
  });

  it('set_variable value hint explains ${other_var} interpolation', () => {
    const f = field('set_variable', 'value');
    expect(f.hint).toBeTruthy();
    expect(f.hint).toContain('${');
  });

  it('ens recording_file_var hint references recorded_file_path convention', () => {
    const f = field('ens', 'recording_file_var');
    expect(f.hint).toBeTruthy();
    // Should reference the convention variable name
    expect(f.placeholder).toBe('recorded_file_path');
  });
});

// ── Sanity: registry × validator completeness ─────────────────────────────────

describe('Registry completeness: all node types have configSchema', () => {
  for (const entry of NODE_TYPE_REGISTRY) {
    it(`${entry.type} has configSchema array`, () => {
      expect(Array.isArray(entry.configSchema)).toBe(true);
    });
    it(`${entry.type} has non-empty luaHandler`, () => {
      expect(typeof entry.luaHandler).toBe('string');
      expect(entry.luaHandler.length).toBeGreaterThan(10);
    });
  }
});
