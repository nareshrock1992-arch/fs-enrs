/**
 * Gather — Configurable Prompt Source & Retry Policy.
 *
 * Covers the approved DIA scope:
 *   - Legacy Gather behavior is preserved verbatim (regression/snapshot guard).
 *   - New configurable path: TTS / Audio / None prompt source per failure reason.
 *   - Configurable retry policy (max_attempts + per-reason retry toggles).
 *   - Failure reasons are distinguishable: no_input / invalid_length /
 *     invalid_option / VALID.
 *   - Prompt (TTS/audio) failure is NOT misclassified as caller no_input.
 *   - Language-neutral engine: zero hardcoded user-facing text in the new path.
 *   - Reserved branch keys are handled by the existing dynamic branch model.
 *   - Legacy Gather JSON still validates; new configs validate; invalid configs
 *     are rejected before deployment.
 */

import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';
import { getNodeType } from '../../nodeTypes/registry.js';
import { validateAudioFiles } from '../../services/deploymentEngine.js';

const lua = generateIvrExecutorLua({
  apiBase:  'http://127.0.0.1:4100',
  apiKey:   'test-key',
  piperUrl: 'http://127.0.0.1:5002',
});

// Isolate the exec_gather function body from the generated script.
const gatherBlock = lua.slice(
  lua.indexOf('local function exec_gather('),
  lua.indexOf('local function exec_condition('),
);
// Split at the legacy/new boundary so each half can be asserted independently.
const newPathIdx  = gatherBlock.indexOf('NEW CONFIGURABLE PATH');
const legacyHalf  = gatherBlock.slice(0, newPathIdx);
const newHalf     = gatherBlock.slice(newPathIdx);

// ── play_prompt helper (shared, additive) ───────────────────────────────────

describe('play_prompt — additive language-neutral dispatcher', () => {
  it('is generated as a shared helper', () => {
    expect(lua).toContain('local function play_prompt(s, src, audio_url, text)');
  });
  it('dispatches none → nothing, audio → resolve_audio+streamFile, tts → speak', () => {
    const pp = lua.slice(lua.indexOf('local function play_prompt('), lua.indexOf('local function exec_'));
    expect(pp).toContain('if src == "none" then return true end');
    expect(pp).toContain('local f = resolve_audio(audio_url)');
    expect(pp).toContain('s:streamFile(f)');
    expect(pp).toContain('speak(s, t)');
  });
  it('reuses existing speak/resolve_audio/interp without redefining them', () => {
    // Exactly one definition of each shared helper (no duplicate TTS/audio subsystem).
    expect(lua.match(/local function speak\(/g)).toHaveLength(1);
    expect(lua.match(/local function resolve_audio\(/g)).toHaveLength(1);
    expect(lua.match(/local function interp\(/g)).toHaveLength(1);
  });
});

// ── A. Legacy path unchanged ────────────────────────────────────────────────

describe('A — legacy Gather behavior preserved verbatim', () => {
  it('gates the legacy path on absence of max_attempts', () => {
    expect(gatherBlock).toContain('if node.max_attempts == nil then');
  });
  it('keeps the native 3-try playAndGetDigits audio path', () => {
    expect(legacyHalf).toContain('s:playAndGetDigits(min_d, max_d, 3, timeout, terms, pf, "", "[0-9#*]+", "", idt)');
  });
  it('keeps the legacy TTS manual retry loop and its (legacy-only) reprompt string', () => {
    expect(legacyHalf).toContain('local tries = 3');
    expect(legacyHalf).toContain('Please enter at least ');
  });
  it('keeps the legacy routing (timeout/_default, then digits/_default/invalid)', () => {
    expect(legacyHalf).toContain('return br["timeout"] or br["_default"]');
    expect(legacyHalf).toContain('return br[digits] or br["_default"] or br["invalid"]');
  });
  it('the legacy hardcoded reprompt exists ONLY in the legacy half, never the new path', () => {
    expect(newHalf).not.toContain('Please enter at least ');
  });
});

// ── B. New path: failure reasons are distinguishable ────────────────────────

describe('B — new path distinguishes failure reasons', () => {
  it('classifies no_input, invalid_length, invalid_option and VALID', () => {
    expect(newHalf).toContain('reason = "no_input"');
    expect(newHalf).toContain('reason = "invalid_length"');
    expect(newHalf).toContain('reason = "invalid_option"');
    expect(newHalf).toContain('reason=VALID');
  });
  it('derives no_input from empty getDigits and invalid_length from length < min', () => {
    expect(newHalf).toContain('if d == "" then');
    expect(newHalf).toContain('elseif #d < min_d then');
  });
  it('does NOT collapse everything into the timeout bucket (uses getDigits per attempt)', () => {
    expect(newHalf).toContain('local d = s:getDigits(max_d, terms, timeout, idt) or ""');
  });
});

// ── C. New path: configurable retry policy, no hidden default of 3 ──────────

describe('C — configurable retry policy', () => {
  it('reads max_attempts from config (no hardcoded 3 in the new path)', () => {
    expect(newHalf).toContain('math.floor(tonumber(node.max_attempts) or 1)');
    expect(newHalf).not.toContain(', 3, timeout,');    // the legacy native-3 call is not here
  });
  it('honors per-reason retry toggles with documented nil-safe defaults', () => {
    expect(newHalf).toContain('node.retry_on_no_input');
    expect(newHalf).toContain('node.retry_on_invalid_length');
    expect(newHalf).toContain('node.retry_on_invalid_option');
  });
  it('routes to reserved branches, then legacy fallbacks', () => {
    expect(newHalf).toContain('return br[reason] or br["_default"] or br["timeout"] or br["invalid"]');
    expect(newHalf).toContain('return br["max_attempts_exceeded"] or br["timeout"] or br["_default"]');
  });
});

// ── D. New path: prompts are configuration-driven (language-neutral) ────────

describe('D — no hardcoded user-facing text in the new path', () => {
  it('plays every prompt via play_prompt from node configuration', () => {
    // attempt 1 = menu prompt; retries = exception prompt (+ optional menu replay)
    expect(newHalf).toContain('play_prompt(s, node.prompt_source_type, node.prompt_audio_url, node.prompt_text)');
    expect(newHalf).toContain('play_prompt(s, retry_src, retry_url, retry_text)');
    expect(newHalf).toContain('retry_src  = node[reason .. "_source_type"]');
    expect(newHalf).toContain('node.max_attempts_exceeded_source_type');
  });
  it('contains no hardcoded English/Arabic retry phrases', () => {
    for (const phrase of ['Invalid entry', 'No input detected', 'try again', 'Please try', 'Invalid option']) {
      expect(newHalf).not.toContain(phrase);
    }
  });
});

// ── E. Prompt failure is not caller no_input ────────────────────────────────

describe('E — TTS/audio prompt failure ≠ caller no_input', () => {
  it('logs a prompt failure but still collects input and does not count it as no_input', () => {
    expect(newHalf).toContain('NOT counted as no_input');
    // collection (getDigits) happens regardless of play_prompt result: the WARN
    // is logged then getDigits still runs. Prove ordering: prompt playback →
    // WARN-on-failure → getDigits, all before any reason classification.
    const playedIdx  = newHalf.indexOf('local played');
    const warnIdx    = newHalf.indexOf('NOT counted as no_input');
    const collectIdx = newHalf.indexOf('local d = s:getDigits');
    expect(playedIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(playedIdx);
    expect(collectIdx).toBeGreaterThan(warnIdx);
  });
});

// ── F. Validation: legacy + new configs validate; invalid rejected ──────────

const baseBranches = { branches: { '1': 'n1', '_default': 'n2' } };

describe('F — Zod validation', () => {
  it('legacy Gather JSON (no new fields) still validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', min_digits: 4, max_digits: 4, timeout_seconds: 5,
      prompt_source_type: 'tts', prompt_text: 'Enter PIN', ...baseBranches,
    });
    expect(r.success).toBe(true);
  });

  it('new config with TTS + Audio + None slots validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', min_digits: 1, max_digits: 1,
      max_attempts: 3,
      retry_on_no_input: 'yes', retry_on_invalid_length: 'yes', retry_on_invalid_option: 'no',
      prompt_source_type: 'tts', prompt_text: 'Main menu',
      no_input_source_type: 'audio', no_input_audio_url: '/media/ar/no-input.wav',
      invalid_length_source_type: 'none',
      invalid_option_source_type: 'tts', invalid_option_text: 'Not a valid option',
      max_attempts_exceeded_source_type: 'audio', max_attempts_exceeded_audio_url: '/media/ar/goodbye.wav',
      ...baseBranches,
    });
    expect(r.success).toBe(true);
  });

  it('accepts boolean retry toggles as well as yes/no', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2, retry_on_no_input: true, retry_on_invalid_option: false, ...baseBranches,
    });
    expect(r.success).toBe(true);
  });

  it('R2 — rejects source_type=audio without an audio_url', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2, no_input_source_type: 'audio', ...baseBranches,
    });
    expect(r.success).toBe(false);
  });

  it('R2 — audio_file_id alone does NOT satisfy source_type=audio (no runtime resolution)', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2,
      no_input_source_type: 'audio', no_input_audio_file_id: 42, // unknown key, stripped
      ...baseBranches,
    });
    expect(r.success).toBe(false);
  });

  it('R2 — source_type=audio WITH audio_url validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2,
      no_input_source_type: 'audio', no_input_audio_url: '/media/ar/no-input.wav',
      ...baseBranches,
    });
    expect(r.success).toBe(true);
  });

  it('rejects source_type=tts without text', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2, invalid_length_source_type: 'tts', ...baseBranches,
    });
    expect(r.success).toBe(false);
  });

  // R1 — explicit new-mode opt-in contract
  it('R1 — configurable field WITHOUT max_attempts fails validation', () => {
    for (const f of [
      { retry_on_no_input: 'yes' },
      { no_input_source_type: 'audio', no_input_audio_url: '/media/x.wav' },
      { invalid_length_source_type: 'tts', invalid_length_text: 'x' },
      { max_attempts_exceeded_source_type: 'none' },
    ]) {
      const r = AnyNodeSchema.safeParse({ type: 'gather', ...f, ...baseBranches });
      expect(r.success).toBe(false);
    }
  });

  it('R1 — max_attempts with no retry fields is valid new mode', () => {
    const r = AnyNodeSchema.safeParse({ type: 'gather', max_attempts: 3, ...baseBranches });
    expect(r.success).toBe(true);
  });

  it('R1 — a genuinely legacy node (no new fields, no max_attempts) still validates', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', min_digits: 4, max_digits: 4, timeout_seconds: 5,
      prompt_source_type: 'audio', prompt_audio_url: '/media/pin.wav', ...baseBranches,
    });
    expect(r.success).toBe(true);
  });

  // R5 — max_attempts boundary validation at the schema layer (authoritative for
  // published flows). Malformed raw-JSONB normalization is a Lua concern (see the
  // generator test below), NOT a schema concern.
  it('R5 — Zod accepts 1,2,3,10 and rejects 0, negative, 11, fractional, strings, null', () => {
    for (const v of [1, 2, 3, 10]) {
      expect(AnyNodeSchema.safeParse({ type: 'gather', max_attempts: v, ...baseBranches }).success).toBe(true);
    }
    for (const v of [0, -1, 11, 2.7, '3', 'abc', null]) {
      expect(AnyNodeSchema.safeParse({ type: 'gather', max_attempts: v, ...baseBranches }).success).toBe(false);
    }
  });

  it('rejects an external (non /media/) audio url', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', max_attempts: 2, no_input_source_type: 'audio',
      no_input_audio_url: 'http://evil.example/x.wav', ...baseBranches,
    });
    expect(r.success).toBe(false);
  });

  it('allows initial prompt source "none"', () => {
    const r = AnyNodeSchema.safeParse({
      type: 'gather', prompt_source_type: 'none', ...baseBranches,
    });
    expect(r.success).toBe(true);
  });
});

// ── G. configSchema surfaces the new fields for the generic PropertyPanel ────

describe('G — configSchema exposes new fields (generic PropertyPanel renders them)', () => {
  const keys = getNodeType('gather').configSchema.map(f => f.key);
  it('includes max_attempts and retry toggles', () => {
    expect(keys).toEqual(expect.arrayContaining([
      'max_attempts', 'retry_on_no_input', 'retry_on_invalid_length', 'retry_on_invalid_option',
    ]));
  });
  it('includes each per-reason prompt slot triplet', () => {
    for (const slot of ['no_input', 'invalid_length', 'invalid_option', 'max_attempts_exceeded']) {
      expect(keys).toContain(`${slot}_source_type`);
      expect(keys).toContain(`${slot}_text`);
      expect(keys).toContain(`${slot}_audio_url`);
    }
  });
  it('slot text/audio fields use showWhen so they only appear for their source_type', () => {
    const f = getNodeType('gather').configSchema.find(x => x.key === 'no_input_audio_url');
    expect(f.showWhen).toEqual({ field: 'no_input_source_type', value: 'audio' });
  });
  it('does NOT expose any *_audio_file_id field for the new slots (R2)', () => {
    for (const slot of ['no_input', 'invalid_length', 'invalid_option', 'max_attempts_exceeded']) {
      expect(keys).not.toContain(`${slot}_audio_file_id`);
    }
  });
});

// ── H. R5 — malformed max_attempts normalization is a Lua (runtime) concern ──

describe('H — R5 max_attempts normalization in generated Lua (defensive, not a default)', () => {
  it('floors and clamps the raw value to a whole number >= 1', () => {
    expect(newHalf).toContain('local max_att = math.floor(tonumber(node.max_attempts) or 1)');
    expect(newHalf).toContain('if max_att < 1 then max_att = 1 end');
  });
  it('the legacy gate is on ABSENCE of max_attempts, not its numeric value', () => {
    expect(gatherBlock).toContain('if node.max_attempts == nil then');
    // Must not gate on a numeric comparison like `> 0` / `>= 1`.
    expect(gatherBlock).not.toMatch(/node\.max_attempts\s*[<>]=?\s*\d/);
  });
});

// ── I. R3 — deployment audio validation includes the new retry slots ─────────

describe('I — R3 deployment validation inspects new retry-slot audio URLs', () => {
  it('flags a missing WAV in each retry slot exactly like the initial prompt', async () => {
    const graph = {
      entry_node_id: 'g',
      nodes: {
        g: {
          type: 'gather', max_attempts: 3,
          prompt_source_type: 'audio',              prompt_audio_url: '/media/__nope_prompt.wav',
          no_input_source_type: 'audio',            no_input_audio_url: '/media/__nope_ni.wav',
          invalid_length_source_type: 'audio',      invalid_length_audio_url: '/media/__nope_il.wav',
          invalid_option_source_type: 'audio',      invalid_option_audio_url: '/media/__nope_io.wav',
          max_attempts_exceeded_source_type: 'audio', max_attempts_exceeded_audio_url: '/media/__nope_ex.wav',
          branches: { '1': 'g' },
        },
      },
    };
    const issues = await validateAudioFiles(graph);
    const fields = issues.map(i => i.field);
    for (const f of [
      'prompt_audio_url', 'no_input_audio_url', 'invalid_length_audio_url',
      'invalid_option_audio_url', 'max_attempts_exceeded_audio_url',
    ]) {
      expect(fields).toContain(f);
    }
  });
  it('only inspects fields that actually exist in the node', async () => {
    const issues = await validateAudioFiles({
      entry_node_id: 'g',
      nodes: { g: { type: 'gather', max_attempts: 2, branches: { '1': 'g' } } },
    });
    // No audio_url fields present → no audio issues raised.
    expect(issues).toHaveLength(0);
  });
});

// ── J. Legacy compatibility + _default precedence + counter + no-Arabic ──────

describe('J — legacy compatibility and routing invariants', () => {
  it('_default precedence: a complete entry routes to br[d] or br["_default"] BEFORE invalid_option', () => {
    // VALID check consumes br[d] or br["_default"]; invalid_option is only
    // reached when that target is nil. This preserves legacy routing.
    const validIdx  = newHalf.indexOf('local target = br[d] or br["_default"]');
    const ioIdx     = newHalf.indexOf('reason = "invalid_option"');
    expect(validIdx).toBeGreaterThan(-1);
    expect(ioIdx).toBeGreaterThan(validIdx);
  });
  it('attempt counter increments exactly once per loop iteration (top of loop only)', () => {
    expect(newHalf.match(/attempt = attempt \+ 1/g)).toHaveLength(1);
  });
  it('legacy routing keys preserved in the legacy half', () => {
    expect(legacyHalf).toContain('br["timeout"]');
    expect(legacyHalf).toContain('br["_default"]');
    expect(legacyHalf).toContain('br["invalid"]');
  });
  it('no language-specific / Arabic logic anywhere in exec_gather', () => {
    expect(gatherBlock.toLowerCase()).not.toContain('arab');
    expect(gatherBlock.toLowerCase()).not.toContain('language');
    expect(gatherBlock).not.toMatch(/if\s+lang/i);
  });
});

// ── In-node retry exit: max_attempts_exceeded is publishable + read at runtime ─
describe('max_attempts_exceeded — wireable in-node exhaustion exit', () => {
  it('a gather wiring max_attempts_exceeded validates (branch-key length fix: 16 -> 24)', () => {
    const node = {
      type: 'gather',
      max_attempts: 2,
      variable_name: 'menu_choice',
      branches: { '1': 'n_sales', '2': 'n_support', max_attempts_exceeded: 'n_hangup' },
    };
    const parsed = AnyNodeSchema.safeParse(node);
    expect(parsed.success).toBe(true);
  });

  it("exec_gather routes to br['max_attempts_exceeded'] once attempts are exhausted", () => {
    expect(newHalf).toContain('br["max_attempts_exceeded"]');
    // The exhaustion return sits AFTER the retry loop closes, not on a per-attempt route.
    const loopEnd = newHalf.indexOf('attempts exhausted');
    expect(loopEnd).toBeGreaterThan(-1);
    expect(newHalf.indexOf('br["max_attempts_exceeded"]', loopEnd - 300)).toBeGreaterThan(-1);
  });

  it('retry lifecycle stays inside one invocation (single getDigits + single counter increment)', () => {
    expect(newHalf.match(/s:getDigits\(/g)).toHaveLength(1);
    expect(newHalf.match(/attempt = attempt \+ 1/g)).toHaveLength(1);
  });
});

// ── v2 marker: config_version accepted; legacy nodes (no marker) still valid ───
describe('gather v2 config_version marker', () => {
  const base = { type: 'gather', max_attempts: 2, branches: { '1': 'a', max_attempts_exceeded: 'x' } };
  it('accepts config_version: 2', () => {
    expect(AnyNodeSchema.safeParse({ ...base, config_version: 2 }).success).toBe(true);
  });
  it('accepts a legacy node with no config_version', () => {
    expect(AnyNodeSchema.safeParse({ type: 'gather', branches: { '1': 'a', _default: 'b' } }).success).toBe(true);
  });
  it('rejects a wrong config_version value', () => {
    expect(AnyNodeSchema.safeParse({ ...base, config_version: 1 }).success).toBe(false);
  });
});

// ── Menu replay on retry: exception prompt → optional menu replay → getDigits ──
describe('menu replay — exception prompt then optional replay of the single menu', () => {
  it('attempt 1 plays the menu prompt (node.prompt_*)', () => {
    expect(newHalf).toContain('play_prompt(s, node.prompt_source_type, node.prompt_audio_url, node.prompt_text)');
  });
  it('on retry it plays the EXCEPTION prompt, then REPLAYS the same menu when retry_replay is set', () => {
    // exception prompt uses the staged retry_* values
    expect(newHalf).toContain('play_prompt(s, retry_src, retry_url, retry_text)');
    // replay reuses the ORIGINAL menu prompt (no second slot) guarded by retry_replay
    expect(newHalf).toMatch(/if retry_replay then[\s\S]*play_prompt\(s, node\.prompt_source_type, node\.prompt_audio_url, node\.prompt_text\)/);
  });
  it('replay_menu defaults ON (nil → true) and accepts boolean true / "yes"', () => {
    expect(newHalf).toContain('retry_replay = (rm == nil or rm == true or rm == "yes")');
    expect(newHalf).toContain('local rm   = node[reason .. "_replay_menu"]');
  });
  it('menu replay does NOT add a second getDigits (still exactly one per attempt)', () => {
    expect(newHalf.match(/s:getDigits\(/g)).toHaveLength(1);
  });
  it('does NOT introduce a second menu-prompt configuration field (reuses node.prompt_*)', () => {
    // The only menu source read is node.prompt_source_type — no node.menu_* / replay_prompt_* slot.
    expect(newHalf).not.toMatch(/node\.menu_prompt|node\.replay_prompt|node\.menu_source_type/);
  });

  it('replay_menu booleans validate (boolean or yes/no) and are optional', () => {
    const base = {
      type: 'gather', max_attempts: 2,
      branches: { '1': 'a', max_attempts_exceeded: 'x' },
    };
    // present as strings
    expect(AnyNodeSchema.safeParse({
      ...base, no_input_replay_menu: 'yes', invalid_length_replay_menu: 'no', invalid_option_replay_menu: 'yes',
    }).success).toBe(true);
    // present as booleans
    expect(AnyNodeSchema.safeParse({ ...base, no_input_replay_menu: false }).success).toBe(true);
    // omitted entirely (defaults ON in executor)
    expect(AnyNodeSchema.safeParse(base).success).toBe(true);
    // invalid value rejected
    expect(AnyNodeSchema.safeParse({ ...base, no_input_replay_menu: 'maybe' }).success).toBe(false);
  });
});
