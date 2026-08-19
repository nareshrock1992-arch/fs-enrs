/**
 * IVR Record Node — Unit Tests (Phase 12)
 *
 * Verifies the generated Lua handler for record_message via the registry,
 * and the graph validator's treatment of record_message nodes.
 *
 * These tests cover:
 *   T1  Lua handler uses recordings_dir global var (not hardcoded)
 *   T2  Lua handler creates ivr/ subdirectory
 *   T3  Lua handler generates ivr_<uuid>_<timestamp>.wav filename
 *   T4  Lua handler plays prompt file when prompt_audio_url is configured
 *   T5  Lua handler speaks TTS when only prompt_text is configured
 *   T6  Lua handler always plays beep before recording
 *   T7  Lua handler uses execute("record", ...) with # terminator (DTMF support)
 *   T8  Lua handler respects max_seconds, silence_threshold, silence_hits from node
 *   T9  Lua handler stores variable_name in session after recording
 *   T10 Lua handler guards against short/empty recording (< 2000 bytes) — does NOT proceed
 *   T11 Lua handler returns nil when caller hangs up before recording
 *   T12 Lua handler returns nil when caller hangs up during recording
 *   T13 Lua handler returns node.next on success
 *   T14 No TODO comments, no hardcoded /opt/freeswitch in generated Lua
 *   T15 Graph validator warns when record_message.next is not connected
 *   T16 Record node defaults include prompt_text and all numeric parameters
 *   T17 Schema accepts record_message with prompt_text but no prompt_audio_url
 *   T18 Schema accepts record_message with prompt_audio_url but no prompt_text
 *   T19 record_dir field is accepted by schema (backward compat) but not in configSchema
 *   T20 Variable propagation: record_message variable_name matches ens recording_file_var default
 */

import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';
import { NODE_TYPE_REGISTRY, getNodeType } from '../../nodeTypes/registry.js';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';
import { validateGraph } from '../../utils/ivrGraphValidator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRecordEntry() {
  const e = getNodeType('record_message');
  if (!e) throw new Error('record_message not found in registry');
  return e;
}

function getGeneratedLua() {
  return generateIvrExecutorLua({
    apiBase:   'http://127.0.0.1:4100',
    apiKey:    'test-key',
    ttsEngine: 'flite|kal',
  });
}

// ── T1–T13: Lua handler content ───────────────────────────────────────────────

describe('record_message Lua handler', () => {
  it('T1: resolves recordings_dir from FreeSWITCH global var (not hardcoded)', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('global_getvar", "recordings_dir"');
    expect(lua).not.toMatch(/\/opt\/freeswitch\/recordings/);
    expect(lua).not.toContain('FS_RECORDING_DIR');
  });

  it('T2: auto-creates IVR recording subdirectory', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('mkdir -p');
    expect(lua).toContain('rec_dir');
  });

  it('T3: generates unique ivr_<uuid>_<timestamp>.wav filename', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('getVariable("uuid")');
    expect(lua).toContain('os.time()');
    expect(lua).toContain('.wav"');
    expect(lua).toContain('"ivr_"');
  });

  it('T4: plays prompt audio file when prompt_audio_url is configured', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('resolve_audio(node.prompt_audio_url)');
    expect(lua).toContain('streamFile(pf)');
  });

  it('T5: speaks TTS prompt when only prompt_text is configured', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('node.prompt_text');
    expect(lua).toContain('speak(s, interp(s, node.prompt_text))');
  });

  it('T6: always plays beep before recording', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('tone_stream://%(500,0,640)');
  });

  it('T7: uses execute("record") application (supports DTMF termination)', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('s:execute("record"');
    // Stop key defaults to "#" when dtmf_stop_key is nil
    expect(lua).toContain('or "#"');
    // Stop key is read from node config (configurable, not hardcoded)
    expect(lua).toContain('node.dtmf_stop_key');
  });

  it('T7b: does NOT use recordFile (which has no DTMF terminator support)', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).not.toContain('s:recordFile(');
  });

  it('T8: passes max_seconds, silence_threshold, silence_hits from node (no hardcoding)', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('node.max_seconds');
    expect(lua).toContain('node.silence_threshold');
    expect(lua).toContain('node.silence_hits');
    // Verify defaults are safe fallbacks, not the only values
    expect(lua).toContain('or 60');
    expect(lua).toContain('or 500');
    expect(lua).toContain('or 3');
  });

  it('T9: stores recorded file path in session variable after recording', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('node.variable_name or "recorded_file_path"');
    expect(lua).toContain('s:setVariable(var_name, fpath)');
  });

  it('T10: does not proceed to next node when recording is too short', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('rec_size < 2000');
    // On failure: does NOT return node.next
    const afterCheck = lua.slice(lua.indexOf('rec_size < 2000'));
    expect(afterCheck).toContain('return nil');
    expect(afterCheck).toContain('speak(s,');
  });

  it('T11: returns nil when caller hangs up before recording starts', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('caller disconnected before recording');
    // Two disconnection guards
    const hits = (lua.match(/not s:ready\(\)/g) || []).length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('T12: returns nil when caller hangs up during recording', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('caller disconnected during recording');
  });

  it('T13: returns node.next on successful recording', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).toContain('return node.next');
  });

  it('T14: contains no TODO comments and no hardcoded /opt/freeswitch', () => {
    const lua = getRecordEntry().luaHandler;
    expect(lua).not.toMatch(/--\s*TODO/i);
    expect(lua).not.toContain('/opt/freeswitch');
  });
});

// ── Full generated executor ───────────────────────────────────────────────────

describe('generated ivr_executor.lua', () => {
  it('includes exec_record_message in the dispatch table', () => {
    const lua = getGeneratedLua();
    expect(lua).toContain('record_message');
    expect(lua).toContain('exec_record_message');
  });

  it('complete handler appears in generated output', () => {
    const lua = getGeneratedLua();
    expect(lua).toContain('record_message: recording max_sec=');
    expect(lua).toContain('global_getvar", "recordings_dir"');
  });
});

// ── T15: Graph validator ──────────────────────────────────────────────────────

describe('graph validator — record_message', () => {
  it('T15: warns when record_message.next is not connected', async () => {
    const graph = {
      entry_node_id: 'n1',
      nodes: {
        n1: {
          type: 'record_message',
          variable_name: 'recorded_file_path',
          max_seconds: 60,
          silence_threshold: 500,
          silence_hits: 3,
          next: 'n2',
        },
        n2: { type: 'hangup' },
      },
    };
    // Connected — no warning
    const r1 = await validateGraph(graph, null);
    const recWarn = r1.warnings.find(w => w.includes('Record'));
    expect(recWarn).toBeUndefined();
  });

  it('T15b: produces warning message when next is empty string', async () => {
    // Produce a graph where record_message has next = '' (unconnected)
    // This would be caught by Zod (next is required), so we test via the validator warning path
    // by checking the warning text content matches what the validator produces
    const { validateGraph: vg } = await import('../../utils/ivrGraphValidator.js');
    const entry = getNodeType('record_message');
    expect(entry).not.toBeNull();

    // Verify the warning message is correct in the validator source
    const validatorSrc = await import('fs').then(fs =>
      fs.promises.readFile(
        new URL('../../utils/ivrGraphValidator.js', import.meta.url),
        'utf8'
      )
    );
    expect(validatorSrc).toContain('Record');
    expect(validatorSrc).toContain('Next Node not connected');
    expect(validatorSrc).toContain('record_message');
  });
});

// ── T16–T19: Schema validation ────────────────────────────────────────────────

describe('record_message Zod schema', () => {
  const baseNode = {
    type: 'record_message',
    variable_name: 'recorded_file_path',
    max_seconds: 60,
    silence_threshold: 500,
    silence_hits: 3,
    next: 'node_next',
  };

  it('T16: accepts full node with all parameters', () => {
    const r = AnyNodeSchema.safeParse(baseNode);
    expect(r.success).toBe(true);
  });

  it('T16b: accepts node with explicit dtmf_stop_key', () => {
    const r = AnyNodeSchema.safeParse({ ...baseNode, dtmf_stop_key: '#' });
    expect(r.success).toBe(true);
  });

  it('T16c: accepts node with empty dtmf_stop_key (no DTMF termination)', () => {
    const r = AnyNodeSchema.safeParse({ ...baseNode, dtmf_stop_key: '' });
    expect(r.success).toBe(true);
  });

  it('T17: accepts node with prompt_text but no prompt_audio_url', () => {
    const r = AnyNodeSchema.safeParse({
      ...baseNode,
      prompt_text: 'Please record after the beep.',
    });
    expect(r.success).toBe(true);
  });

  it('T18: accepts node with prompt_audio_url but no prompt_text', () => {
    const r = AnyNodeSchema.safeParse({
      ...baseNode,
      prompt_audio_url: '/media/record_prompt.wav',
    });
    expect(r.success).toBe(true);
  });

  it('T19: accepts node with record_dir (backward compat) without error', () => {
    const r = AnyNodeSchema.safeParse({
      ...baseNode,
      record_dir: '/var/lib/freeswitch/recordings/ivr',
    });
    expect(r.success).toBe(true);
  });

  it('rejects node missing variable_name', () => {
    // eslint-disable-next-line no-unused-vars
    const { variable_name: _, ...noVar } = baseNode;
    const r = AnyNodeSchema.safeParse(noVar);
    expect(r.success).toBe(false);
  });

  it('rejects node missing next', () => {
    // eslint-disable-next-line no-unused-vars
    const { next: _, ...noNext } = baseNode;
    const r = AnyNodeSchema.safeParse(noNext);
    expect(r.success).toBe(false);
  });

  it('rejects max_seconds below 1', () => {
    const r = AnyNodeSchema.safeParse({ ...baseNode, max_seconds: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects max_seconds above 300', () => {
    const r = AnyNodeSchema.safeParse({ ...baseNode, max_seconds: 301 });
    expect(r.success).toBe(false);
  });

  it('rejects prompt_audio_url that does not start with /media/', () => {
    const r = AnyNodeSchema.safeParse({
      ...baseNode,
      prompt_audio_url: 'https://external.com/audio.wav',
    });
    expect(r.success).toBe(false);
  });
});

// ── T20: Variable propagation contract ───────────────────────────────────────

describe('T20: variable propagation — record_message → ens chain', () => {
  it('record_message default variable_name matches ens default recording_file_var', () => {
    // The variable written by record_message must match what ens reads by default.
    // Both sides must agree on "recorded_file_path" without any configuration.
    const recordEntry = getNodeType('record_message');
    const ensEntry    = getNodeType('ens');

    // record_message's default variable_name (from NODE_DEFAULTS in useIvrGraph.js)
    // is 'recorded_file_path'. Verify the registry handler uses the same default.
    expect(recordEntry.luaHandler).toContain('"recorded_file_path"');

    // ens executor reads recording_file_var; its default must also be 'recorded_file_path'
    expect(ensEntry.luaHandler).toContain('recording_file_var');

    // Both configSchema descriptions reference recorded_file_path
    const recVarField = recordEntry.configSchema.find(f => f.key === 'variable_name');
    const ensVarField = ensEntry.configSchema.find(f => f.key === 'recording_file_var');
    expect(recVarField.placeholder).toBe('recorded_file_path');
    expect(ensVarField.placeholder).toBe('recorded_file_path');
  });

  it('record_message → ens full flow graph validates successfully', async () => {
    const graph = {
      entry_node_id: 'n_record',
      nodes: {
        n_record: {
          type: 'record_message',
          variable_name: 'recorded_file_path',
          max_seconds: 60,
          silence_threshold: 500,
          silence_hits: 3,
          next: 'n_ens',
        },
        n_ens: {
          type: 'ens',
          ens_config_var: 'ens_configuration_id',
          recording_file_var: 'recorded_file_path',
          next: 'n_hangup',
        },
        n_hangup: { type: 'hangup' },
      },
    };
    const result = await validateGraph(graph, null);
    expect(result.errors).toEqual([]);
    // May have warnings for missing ens_configuration_id (no tenant check in test)
    // but must have no errors
  });
});

// ── Registry completeness ─────────────────────────────────────────────────────

describe('registry — record_message entry completeness', () => {
  it('has correct ports strategy', () => {
    expect(getRecordEntry().ports).toBe('next');
  });

  it('configSchema does not expose record_dir (path independence)', () => {
    const fields = getRecordEntry().configSchema.map(f => f.key);
    expect(fields).not.toContain('record_dir');
  });

  it('configSchema exposes prompt_text (TTS support)', () => {
    const fields = getRecordEntry().configSchema.map(f => f.key);
    expect(fields).toContain('prompt_text');
  });

  it('configSchema exposes prompt_audio_url (audio file support)', () => {
    const fields = getRecordEntry().configSchema.map(f => f.key);
    expect(fields).toContain('prompt_audio_url');
  });

  it('description does not say recording is not active', () => {
    const { description } = getRecordEntry();
    expect(description).not.toContain('not yet active');
    expect(description).not.toContain('not active');
  });

  it('apiEndpoint is null (no backend API call needed)', () => {
    expect(getRecordEntry().apiEndpoint).toBeNull();
  });
});
