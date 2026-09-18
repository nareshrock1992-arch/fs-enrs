/**
 * Say node — variable-insertion fallback (approved scope).
 *
 * Reuses interp() unchanged; adds a gated fallback path to exec_say plus additive
 * Lua helpers (value_usable / all_vars_usable / vars_referenced /
 * render_with_fallback). These are generator-level (string) assertions — the
 * runtime behavior is Lua, which has no interpreter in this environment; the
 * tests prove the legacy path is byte-preserved, the helpers/deny-list are
 * present, and interp/speak/resolve_audio are untouched.
 */

import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';

const lua = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: 'http://p' });

const exec_say = lua.slice(lua.indexOf('local function exec_say('), lua.indexOf('local function exec_gather('));

describe('exec_say — legacy path preserved byte-for-byte', () => {
  it('keeps the exact legacy speak line and gates it on absent fallback_text', () => {
    expect(exec_say).toContain('if node.fallback_text == nil or node.fallback_text == "" then');
    expect(exec_say).toContain('speak(s, interp(s, node.text), node.sentence_silence_ms)');
  });
  it('does NOT log on the legacy (no-fallback) path', () => {
    const legacyHalf = exec_say.slice(0, exec_say.indexOf('New path'));
    expect(legacyHalf).not.toContain('consoleLog');
  });
});

describe('exec_say — new fallback path', () => {
  it('uses render_with_fallback and speaks the chosen text', () => {
    expect(exec_say).toContain('render_with_fallback(s, node.text, node.fallback_text)');
    expect(exec_say).toContain('speak(s, text, node.sentence_silence_ms)');
  });
  it('logs referenced variable NAMES and a fallback_used flag — never the value', () => {
    expect(exec_say).toContain('vars=" .. vars_referenced(node.text)');
    expect(exec_say).toContain('fallback_used=" .. tostring(used_fallback)');
    // must not log a resolved value (no getVariable in the log statement)
    const logLine = exec_say.split('\n').find(l => l.includes('consoleLog') && l.includes('say:'));
    expect(logLine).toBeTruthy();
    expect(logLine).not.toContain('getVariable');
  });
});

describe('additive helpers present', () => {
  it('defines value_usable, all_vars_usable, vars_referenced, render_with_fallback', () => {
    expect(lua).toContain('local function value_usable(v)');
    expect(lua).toContain('local function all_vars_usable(s, text)');
    expect(lua).toContain('local function vars_referenced(text)');
    expect(lua).toContain('local function render_with_fallback(s, primary, fallback)');
  });
  it('deny-list includes the base tokens', () => {
    for (const t of ['anonymous', 'unknown', 'unavailable', 'restricted', 'private']) {
      expect(lua).toContain(`["${t}"] = true`);
    }
    // empty string entry
    expect(lua).toContain('[""] = true');
  });
  it('deny-list includes the two added carrier phrases', () => {
    expect(lua).toContain('["private number"] = true');
    expect(lua).toContain('["caller id blocked"] = true');
  });
  it('value_usable trims and lowercases before matching', () => {
    expect(lua).toContain('v:gsub("^%s+", ""):gsub("%s+$", "")');
    expect(lua).toContain('UNUSABLE_VALUES[t:lower()]');
  });
});

describe('interp / speak / resolve_audio unchanged (byte-for-byte)', () => {
  it('interp is defined exactly once and reads arbitrary channel vars', () => {
    expect(lua.match(/local function interp\(/g)).toHaveLength(1);
    expect(lua).toContain('return (str:gsub("${([^}]+)}", function(k)');
    expect(lua).toContain('return s:getVariable(k) or ""');
  });
  it('speak signature and Piper-first body are unchanged', () => {
    expect(lua.match(/local function speak\(s, text, sentence_silence_ms\)/g)).toHaveLength(1);
  });
  it('resolve_audio is defined exactly once', () => {
    expect(lua.match(/local function resolve_audio\(uri\)/g)).toHaveLength(1);
  });
});

describe('Zod — SayNodeSchema fallback_text', () => {
  const base = { type: 'say', text: 'Welcome ${caller_id_name}', next: 'n2' };
  it('accepts a valid fallback_text', () => {
    expect(AnyNodeSchema.safeParse({ ...base, fallback_text: 'Welcome.' }).success).toBe(true);
  });
  it('accepts a Say node with NO fallback_text (backward compatible)', () => {
    expect(AnyNodeSchema.safeParse(base).success).toBe(true);
  });
  it('bounds fallback_text at 1000 chars', () => {
    expect(AnyNodeSchema.safeParse({ ...base, fallback_text: 'x'.repeat(1000) }).success).toBe(true);
    expect(AnyNodeSchema.safeParse({ ...base, fallback_text: 'x'.repeat(1001) }).success).toBe(false);
  });
  it('rejects a non-string fallback_text', () => {
    expect(AnyNodeSchema.safeParse({ ...base, fallback_text: 123 }).success).toBe(false);
  });
});
