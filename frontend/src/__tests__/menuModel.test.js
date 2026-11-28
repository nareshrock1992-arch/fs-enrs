import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { gatherBranchKeysFor } from '../components/ivr/canvas/nodePorts.js';
import { nodeSubtitleLines } from '../components/ivr/canvas/nodeSubtitle.js';
import {
  MODE, menuMode, effective, runtimeDefault, flag, sourceOf, togglePatch, sourcePatch, modePatch,
  optionKeys, nextFreeKey, addOptionPatch, validateOptionKey, optionKeyWarning, renameOptionPatch,
  removeBranchPatch, setBranchPatch, menuRows, panelKeys, showTooFewDigits, unguardedRows,
  sectionSummaries, menuCanvasSummary, mapMenuErrors, MENU_PANEL_FIELDS,
  COLLECT, collectType, collectTypePatch, retriesOf, retriesPatch, menuExitLabel, defaultExitName,
  menuPromptPreview, isWired, hasAnyExit,
  WRONG_KEY, wrongKeyChoice, wrongKeyGoKey, wrongKeyChoicePatch, simulateEntry, describeEntry,
} from '../components/ivr/panels/menu/menuModel.js';

// Menu (Gather DTMF) inspector view-model. Presentation only: these rules must
// mirror exec_gather (backend/src/nodeTypes/registry.js) and must never write
// anything a node did not already contain unless an administrator edits it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.resolve(__dirname, rel), 'utf8');

// Deep-freeze so any accidental mutation throws (ES modules run in strict mode).
function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freeze(v);
  }
  return o;
}

// Representative stored shapes: a node created by today's builder (NODE_DEFAULTS),
// classic nodes (including the built-in template "launch_options"), one-attempt
// mode, and the edge case retry_mode internal without max_attempts.
const NEW_NODE = { type: 'gather', config_version: 2, retry_mode: 'internal', max_attempts: 3, reprompt_pause_ms: 700, allow_barge_in: 'yes', min_digits: 1, max_digits: 1, timeout_seconds: 5, inter_digit_timeout: 2, terminators: '', variable_name: 'gather_result', prompt_source_type: 'tts', prompt_text: '', branches: {} };
const CLASSIC_BARE = { type: 'gather', prompt_text: 'Press 1 for billing', branches: { '1': 'a' } };
const TEMPLATE_LAUNCH = { type: 'gather', variable_name: 'launch_choice', max_digits: 1, timeout_seconds: 10, prompt_text: 'PIN accepted. Press 1 to send the emergency notification now. Press 2 to cancel.', branches: { '1': 'trigger_ens', '2': 'cancel_say', timeout: 'launch_options', _default: 'launch_options' } };
const CONFIG_BY_ATTEMPTS = { type: 'gather', max_attempts: 2, branches: { '1': 'a', _default: 'c' } };
const EXTERNAL = { type: 'gather', retry_mode: 'external', max_attempts: 3, branches: { '1': 'a', timeout: 't', invalid: 'i' } };
const INTERNAL_NO_ATTEMPTS = { type: 'gather', retry_mode: 'internal', branches: { '1': 'a' } };
const PIN = { type: 'gather', retry_mode: 'internal', max_attempts: 3, min_digits: 4, max_digits: 6, terminators: '#', prompt_source_type: 'tts', prompt_text: 'Enter your PIN', branches: { _default: 'ok' } };

const SHAPES = { NEW_NODE, CLASSIC_BARE, TEMPLATE_LAUNCH, CONFIG_BY_ATTEMPTS, EXTERNAL, INTERNAL_NO_ATTEMPTS, PIN };

describe('mode detection (mirrors the exec_gather gates)', () => {
  it('classic = no retry_mode and no max_attempts', () => {
    expect(menuMode(CLASSIC_BARE)).toBe(MODE.CLASSIC);
    expect(menuMode(TEMPLATE_LAUNCH)).toBe(MODE.CLASSIC);
    expect(menuMode({ type: 'gather', max_attempts: '', branches: {} })).toBe(MODE.CLASSIC);
  });
  it('internal = retry_mode internal, or max_attempts set without retry_mode', () => {
    expect(menuMode(NEW_NODE)).toBe(MODE.INTERNAL);
    expect(menuMode(CONFIG_BY_ATTEMPTS)).toBe(MODE.INTERNAL);
    expect(menuMode(INTERNAL_NO_ATTEMPTS)).toBe(MODE.INTERNAL);
  });
  it('external wins even when max_attempts is set', () => {
    expect(menuMode(EXTERNAL)).toBe(MODE.EXTERNAL);
  });
});

describe('values the call uses when a field is empty', () => {
  it('wait time is 10 s in classic, 5 s otherwise', () => {
    expect(effective(CLASSIC_BARE).timeout_seconds).toBe(10);
    expect(runtimeDefault(CLASSIC_BARE, 'timeout_seconds')).toBe(10);
    expect(effective({ type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: {} }).timeout_seconds).toBe(5);
    expect(effective({ type: 'gather', retry_mode: 'external', branches: {} }).timeout_seconds).toBe(5);
  });
  it('a stored value always wins', () => {
    expect(effective(TEMPLATE_LAUNCH).timeout_seconds).toBe(10);
    expect(effective({ ...CLASSIC_BARE, timeout_seconds: 7 }).timeout_seconds).toBe(7);
  });
  it('prompt source defaults: text-to-speech in classic, none in the newer paths', () => {
    expect(effective(CLASSIC_BARE).prompt_source_type).toBe('tts');
    expect(effective({ type: 'gather', retry_mode: 'external', branches: {} }).prompt_source_type).toBe('none');
    expect(sourceOf(CLASSIC_BARE, 'prompt')).toBe('tts');
  });
  it('retry defaults: no input on, too few digits on, wrong key OFF; replay on', () => {
    const e = effective(CONFIG_BY_ATTEMPTS);
    expect(e.retry).toEqual({ no_input: true, invalid_length: true, invalid_option: false });
    expect(e.replay).toEqual({ no_input: true, invalid_length: true, invalid_option: true });
  });
  it('barge-in: on by default in the newer paths, not applicable in classic', () => {
    expect(effective(EXTERNAL).allow_barge_in).toBe(true);
    expect(effective({ ...NEW_NODE, allow_barge_in: 'no' }).allow_barge_in).toBe(false);
    expect(effective({ ...NEW_NODE, allow_barge_in: false }).allow_barge_in).toBe(false);
    expect(effective(CLASSIC_BARE).allow_barge_in).toBeNull();
  });
  it('attempts: classic 3, external 1, internal = max_attempts (1 when unset)', () => {
    expect(effective(CLASSIC_BARE).attempts).toBe(3);
    expect(effective(EXTERNAL).attempts).toBe(1);
    expect(effective(NEW_NODE).attempts).toBe(3);
    expect(effective(INTERNAL_NO_ATTEMPTS).attempts).toBe(1);
    expect(effective(INTERNAL_NO_ATTEMPTS).attemptsSet).toBe(false);
  });
  it('flag accepts booleans and yes/no strings', () => {
    expect(flag(true, false)).toBe(true);
    expect(flag('yes', false)).toBe(true);
    expect(flag('no', true)).toBe(false);
    expect(flag(undefined, true)).toBe(true);
    expect(flag('', false)).toBe(false);
  });
});

describe('opening a node never changes it', () => {
  it('every view function runs on frozen nodes without mutating them', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
      const node = freeze(structuredClone(shape));
      const before = JSON.stringify(node);
      expect(() => {
        effective(node); menuRows(node); panelKeys(node); sectionSummaries(node); unguardedRows(node);
        showTooFewDigits(node); menuCanvasSummary(node); optionKeys(node); nextFreeKey(node);
        mapMenuErrors(node, {}, []);
        collectType(node); retriesOf(node); menuPromptPreview(node); hasAnyExit(node); defaultExitName(node);
        for (const k of gatherBranchKeysFor(node)) menuExitLabel(node, k, { nameOf: id => `N:${id}` });
      }, name).not.toThrow();
      expect(JSON.stringify(node), name).toBe(before);
    }
  });
  it('patch builders return new objects and leave the node untouched', () => {
    const node = freeze(structuredClone(TEMPLATE_LAUNCH));
    expect(() => {
      addOptionPatch(node); renameOptionPatch(node, '1', '9'); removeBranchPatch(node, '2');
      setBranchPatch(node, '1', 'x'); modePatch(node, MODE.INTERNAL);
      collectTypePatch(node, COLLECT.DIGITS); collectTypePatch(freeze(structuredClone(PIN)), COLLECT.MENU);
      retriesPatch(2);
    }).not.toThrow();
  });
});

describe('each control writes exactly one stored field', () => {
  it('toggles write yes/no in the existing format', () => {
    expect(togglePatch('retry_on_no_input', false)).toEqual({ retry_on_no_input: 'no' });
    expect(togglePatch('allow_barge_in', true)).toEqual({ allow_barge_in: 'yes' });
  });
  it('source choices write only the source field — hidden text/audio stay stored', () => {
    expect(sourcePatch('prompt', 'audio')).toEqual({ prompt_source_type: 'audio' });
    expect(sourcePatch('no_input', 'none')).toEqual({ no_input_source_type: 'none' });
  });
  it('turning a retry off and on again restores the stored announcement (nothing is deleted)', () => {
    let node = { ...NEW_NODE, no_input_source_type: 'tts', no_input_text: 'Sorry, I did not hear you.' };
    node = { ...node, ...togglePatch('retry_on_no_input', false) };
    node = { ...node, ...togglePatch('retry_on_no_input', true) };
    expect(node.no_input_text).toBe('Sorry, I did not hear you.');
    expect(sourceOf(node, 'no_input')).toBe('tts');
  });
});

describe('failure-handling mode changes', () => {
  it('classic → retry in this node sets 3 attempts explicitly (otherwise it would run once)', () => {
    expect(modePatch(CLASSIC_BARE, MODE.INTERNAL)).toEqual({ retry_mode: 'internal', max_attempts: 3 });
  });
  it('keeps existing attempts when the node already has them', () => {
    expect(modePatch(CONFIG_BY_ATTEMPTS, MODE.INTERNAL)).toEqual({ retry_mode: 'internal' });
  });
  it('one attempt writes only retry_mode and never removes max_attempts (rule R1)', () => {
    const p = modePatch(NEW_NODE, MODE.EXTERNAL);
    expect(p).toEqual({ retry_mode: 'external' });
    expect({ ...NEW_NODE, ...p }.max_attempts).toBe(3);
  });
  it('classic is never written (no way back that would delete settings)', () => {
    expect(modePatch(NEW_NODE, MODE.CLASSIC)).toBeNull();
  });
});

describe('menu option keys', () => {
  it('suggests the first free keypad key', () => {
    expect(nextFreeKey({ branches: {} })).toBe('1');
    expect(nextFreeKey({ branches: { '1': 'a', '2': 'b' } })).toBe('3');
    expect(nextFreeKey({ branches: { '2': 'b' } })).toBe('1');
    const all = Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].map(k => [k, 'x']));
    expect(nextFreeKey({ branches: all })).toBeNull();
  });
  it('REGRESSION (F4): adding an option after a deletion never wipes an existing destination', () => {
    // Old behaviour: {"2":"support"} + Add → {"2":""} (key = row count + 1).
    const node = { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: { '2': 'support' } };
    const p = addOptionPatch(node);
    expect(p.branches).toEqual({ '2': 'support', '1': '' });
  });
  it('renaming keeps the destination and leaves other keys alone', () => {
    const node = { type: 'gather', branches: { '1': 'billing', '2': 'support', _default: 'any' } };
    const p = renameOptionPatch(node, '2', '0');
    expect(p.branches).toEqual({ '1': 'billing', '0': 'support', _default: 'any' });
  });
  it('refuses empty, non-DTMF, too long and duplicate keys', () => {
    const node = { type: 'gather', branches: { '1': 'a', '2': 'b' } };
    expect(validateOptionKey(node, '', '1')).toMatch(/Enter a key/);
    expect(validateOptionKey(node, 'a', '1')).toMatch(/0–9/);
    expect(validateOptionKey(node, '_default', '1')).toMatch(/0–9/);
    expect(validateOptionKey(node, '1'.repeat(25), '1')).toMatch(/24/);
    expect(validateOptionKey(node, '2', '1')).toMatch(/already used/);
    expect(validateOptionKey(node, '1', '1')).toBeNull();
    expect(validateOptionKey(node, '*', '1')).toBeNull();
    expect(validateOptionKey(node, '123', '1')).toBeNull();
    expect(renameOptionPatch(node, '1', '2')).toBeNull();
  });
  it('remove deletes exactly one key', () => {
    expect(removeBranchPatch({ branches: { '1': 'a', '2': 'b', timeout: 't' } }, '1').branches).toEqual({ '2': 'b', timeout: 't' });
  });
  it('setting a destination touches only that key', () => {
    expect(setBranchPatch({ branches: { '1': 'a' } }, '_default', 'z').branches).toEqual({ '1': 'a', _default: 'z' });
    expect(setBranchPatch({ branches: { '1': 'a' } }, '1', '').branches).toEqual({ '1': '' });
  });
  it('advises when callers cannot reach an option', () => {
    expect(optionKeyWarning({ max_digits: 1, branches: {} }, '12')).toMatch(/at most 1 digit/);
    expect(optionKeyWarning({ min_digits: 2, max_digits: 3, branches: {} }, '1')).toMatch(/minimum of 2/);
    expect(optionKeyWarning({ terminators: '#', branches: {} }, '#')).toMatch(/ends the entry/);
    expect(optionKeyWarning({ branches: {} }, '1')).toBeNull();
  });
  it('option rows follow the canvas port order', () => {
    const node = { type: 'gather', branches: { '2': 'b', '1': 'a', '0': 'z', '*': 's', timeout: 't' } };
    const canvasDigits = gatherBranchKeysFor(node).filter(k => !['timeout', 'invalid', '_default'].includes(k));
    expect(optionKeys(node)).toEqual(canvasDigits);
  });
});

describe('panel and canvas always show the same outputs', () => {
  const matrix = [
    ...Object.values(SHAPES),
    { type: 'gather', max_attempts: 3, retry_on_no_input: 'no', retry_on_invalid_option: 'no', branches: { '1': 'a', no_input: 'n' } },
    { type: 'gather', max_attempts: 3, retry_on_invalid_length: 'no', min_digits: 3, max_digits: 3, branches: { invalid_length: 'l' } },
    { type: 'gather', max_attempts: 3, branches: { '1': 'a', timeout: 'old', invalid: 'old2' } },          // wired legacy keys on a retry node
    { type: 'gather', branches: { '1': 'a', max_attempts_exceeded: 'm', no_input: 'n' } },               // wired v2 keys on a classic node
    { type: 'gather', retry_mode: 'external', branches: { '1': 'a', max_attempts_exceeded: 'm', invalid_option: 'o' } },
    { type: 'gather', retry_mode: 'internal', max_attempts: 2, retry_on_no_input: true, retry_on_invalid_option: false, branches: {} },
  ];
  it('every canvas port appears in the panel exactly once', () => {
    for (const node of matrix) {
      const canvas = gatherBranchKeysFor(node);
      const panel = panelKeys(node);
      expect(new Set(panel).size, JSON.stringify(node)).toBe(panel.length);
      expect([...panel].sort(), JSON.stringify(node)).toEqual([...canvas].sort());
    }
  });
  it('wired keys the mode does not use are listed under Other connections', () => {
    expect(menuRows({ type: 'gather', max_attempts: 3, branches: { timeout: 'old' } }).other).toEqual(['timeout']);
    expect(menuRows({ type: 'gather', branches: { max_attempts_exceeded: 'm' } }).other).toEqual(['max_attempts_exceeded']);
  });
  it('places each failure exit in its own section', () => {
    const r = menuRows({ type: 'gather', max_attempts: 3, retry_on_no_input: 'no', branches: {} });
    expect(r.noResponse).toBe('no_input');
    expect(r.wrongKey).toBe('invalid_option');       // its retry is off by default
    expect(r.exhausted).toBe('max_attempts_exceeded');
    const c = menuRows(CLASSIC_BARE);
    expect([c.noResponse, c.wrongKey]).toEqual(['timeout', 'invalid']);
  });
});

describe('"Too few digits" is shown only when it can matter', () => {
  it('hidden for a one-key menu with nothing configured', () => {
    expect(showTooFewDigits(NEW_NODE)).toBe(false);
  });
  it('shown when more than one digit is required, or it is already configured', () => {
    expect(showTooFewDigits(PIN)).toBe(true);
    expect(showTooFewDigits({ ...NEW_NODE, invalid_length_source_type: 'tts', invalid_length_text: 'x' })).toBe(true);
    expect(showTooFewDigits({ ...NEW_NODE, retry_on_invalid_length: 'no' })).toBe(true);
  });
  it('never in classic or one-attempt mode', () => {
    expect(showTooFewDigits({ ...CLASSIC_BARE, min_digits: 4, max_digits: 4 })).toBe(false);
    expect(showTooFewDigits({ ...EXTERNAL, min_digits: 4, max_digits: 4 })).toBe(false);
  });
});

describe('disconnected-caller hints (same cases as backend gatherCatchAllWarning.test.js)', () => {
  const g = extra => ({ type: 'gather', ...extra });
  it('retry node, no catch-all: wrong key and attempts-run-out are unguarded', () => {
    expect([...unguardedRows(g({ max_attempts: 3, branches: { '1': 'h' } }))].sort()).toEqual(['exhausted', 'wrongKey']);
  });
  it('any other key covers every exit', () => {
    expect(unguardedRows(g({ max_attempts: 3, branches: { '1': 'h', _default: 'h' } })).size).toBe(0);
  });
  it('max attempts destination + wrong-key retry → nothing unguarded', () => {
    expect(unguardedRows(g({ max_attempts: 3, retry_on_invalid_option: 'yes', branches: { '1': 'h', max_attempts_exceeded: 'h' } })).size).toBe(0);
  });
  it('an old timeout wire still guards the chains', () => {
    expect(unguardedRows(g({ max_attempts: 3, branches: { '1': 'h', timeout: 'h' } })).size).toBe(0);
  });
  it('classic: both exits unguarded without timeout/invalid/_default', () => {
    expect([...unguardedRows(g({ branches: { '1': 'h' } }))].sort()).toEqual(['noResponse', 'wrongKey']);
    expect(unguardedRows(g({ branches: { '1': 'h', _default: 'h' } })).size).toBe(0);
    expect(unguardedRows(g({ branches: { '1': 'h', timeout: 'h', invalid: 'h' } })).size).toBe(0);
    expect([...unguardedRows(g({ branches: { '1': 'h', invalid: 'h' } }))]).toEqual(['noResponse']);
  });
  it('one attempt: no response only goes to its own destination', () => {
    expect([...unguardedRows(g({ retry_mode: 'external', branches: { '1': 'h', _default: 'd', invalid: 'i' } }))]).toEqual(['noResponse']);
  });
});

describe('short texts', () => {
  it('section summaries', () => {
    const s = sectionSummaries(NEW_NODE);
    expect(s.options).toBe('0 options');
    expect(s.retryMessages).toBe('None');
    expect(s.advanced).toBe('Retry in this node');
    expect(sectionSummaries(CLASSIC_BARE).advanced).toBe('Classic');
    expect(sectionSummaries(EXTERNAL).advanced).toBe('One attempt');
    // Messages count only where they can play: retry on, or the final message.
    const withMessages = { ...NEW_NODE, no_input_source_type: 'tts', no_input_text: 'Sorry?', max_attempts_exceeded_source_type: 'audio',
      invalid_option_source_type: 'tts', invalid_option_text: 'Wrong key' };     // wrong-key retry is off → not counted
    expect(sectionSummaries(withMessages).retryMessages).toBe('2 set');
    expect(sectionSummaries({ ...withMessages, retry_on_invalid_option: 'yes' }).retryMessages).toBe('3 set');
    // Multi-digit entry: the digit count leads the options summary.
    expect(sectionSummaries(PIN).options).toBe('4–6 digits · 0 options');
    expect(sectionSummaries({ ...PIN, min_digits: 4, max_digits: 4 }).options).toBe('4 digits · 0 options');
  });
  it('canvas summary: prompt · options · attempts', () => {
    expect(menuCanvasSummary(TEMPLATE_LAUNCH)).toBe('Speak · 2 options · classic retry');
    expect(menuCanvasSummary(NEW_NODE)).toBe('No prompt text · No options · 3 tries');
    expect(menuCanvasSummary({ ...NEW_NODE, prompt_source_type: 'audio', prompt_audio_url: '/media/main_menu.wav', branches: { '1': 'a', '2': '' } }))
      .toBe('Audio main_menu.wav · 1 option · 3 tries');
    expect(menuCanvasSummary(PIN)).toBe('Speak · 4–6 digits · 3 tries');
    expect(menuCanvasSummary(EXTERNAL)).toBe('No prompt · 1 option · 1 try');
  });
  it('the canvas card shows the prompt, keeps the description as line 2, and the summary on hover', () => {
    const r = nodeSubtitleLines({ ...TEMPLATE_LAUNCH, description: 'After PIN check' }, { summaryTemplate: 'Collect ${max_digits} digit(s) · ${timeout_seconds}s' });
    expect(r).toEqual({
      primary: '“PIN accepted. Press 1 to send the emergency notification now. Press 2 to cancel.”',
      secondary: 'After PIN check',
      detail: 'Speak · 2 options · classic retry',
    });
  });
  it('prompt preview: what the caller hears', () => {
    expect(menuPromptPreview(NEW_NODE)).toBe('No prompt text');
    expect(menuPromptPreview({ ...NEW_NODE, prompt_text: '  Press 1  ' })).toBe('“Press 1”');
    expect(menuPromptPreview({ ...NEW_NODE, prompt_source_type: 'audio', prompt_audio_url: '/media/main.wav' })).toBe('Audio: main.wav');
    expect(menuPromptPreview({ ...NEW_NODE, prompt_source_type: 'audio' })).toBe('No audio file');
    expect(menuPromptPreview(EXTERNAL)).toBe('No prompt');
  });
});

describe('collect type: a key menu or a number (derived — no stored field)', () => {
  it('digits = no option keys and more than one digit; everything else is a menu', () => {
    expect(collectType(NEW_NODE)).toBe(COLLECT.MENU);
    expect(collectType(TEMPLATE_LAUNCH)).toBe(COLLECT.MENU);
    expect(collectType(PIN)).toBe(COLLECT.DIGITS);
    expect(collectType({ ...PIN, branches: { '1234': 'x', _default: 'ok' } })).toBe(COLLECT.MENU);  // a menu of codes
    expect(collectType({ type: 'gather', max_digits: '4', branches: {} })).toBe(COLLECT.DIGITS);
  });
  it('switching to digits writes the digit counts and removes only the option keys', () => {
    const node = { ...NEW_NODE, branches: { '1': 'a', '2': '', max_attempts_exceeded: 'm', _default: 'd' } };
    expect(collectTypePatch(node, COLLECT.DIGITS)).toEqual({
      branches: { max_attempts_exceeded: 'm', _default: 'd' }, min_digits: 4, max_digits: 4,
      terminators: '#',   // empty end key gets #; the wait and time between digits were already set, so they are kept
    });
    expect(collectType({ ...node, ...collectTypePatch(node, COLLECT.DIGITS) })).toBe(COLLECT.DIGITS);
    // Already more than one digit: only the options go.
    expect(collectTypePatch({ ...node, max_digits: 6, terminators: '*' }, COLLECT.DIGITS))
      .toEqual({ branches: { max_attempts_exceeded: 'm', _default: 'd' } });
  });
  it('switching to digits fills PIN timing only into empty fields', () => {
    const bare = { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: {} };
    expect(collectTypePatch(bare, COLLECT.DIGITS)).toEqual({
      min_digits: 4, max_digits: 4, timeout_seconds: 8, inter_digit_timeout: 3, terminators: '#',
    });
    expect(collectTypePatch({ ...bare, timeout_seconds: 4 }, COLLECT.DIGITS)).toEqual({
      min_digits: 4, max_digits: 4, inter_digit_timeout: 3, terminators: '#',
    });
  });
  it('switching back to a menu writes one digit and keeps every exit', () => {
    expect(collectTypePatch(PIN, COLLECT.MENU)).toEqual({ min_digits: 1, max_digits: 1 });
    expect(collectType({ ...PIN, ...collectTypePatch(PIN, COLLECT.MENU) })).toBe(COLLECT.MENU);
  });
  it('choosing the current type writes nothing', () => {
    expect(collectTypePatch(NEW_NODE, COLLECT.MENU)).toBeNull();
    expect(collectTypePatch(PIN, COLLECT.DIGITS)).toBeNull();
  });
});

// HELP_DESK_2222 Menu 1 as published (v39), before and after "Any other key" was cleared.
const HELP_DESK = {
  type: 'gather', retry_mode: 'internal', max_attempts: 4, min_digits: 1, max_digits: 1, timeout_seconds: 4,
  retry_on_invalid_option: 'yes', invalid_option_source_type: 'tts', invalid_option_text: 'This is an invalid option',
  no_input_source_type: 'tts', no_input_text: 'No input', max_attempts_exceeded_source_type: 'tts', max_attempts_exceeded_text: 'Goodbye',
  branches: { '1': 'xfer', '2': 'q', '3': 'q', _default: 'bye', max_attempts_exceeded: 'bye' },
};
const HELP_DESK_FIXED = { ...HELP_DESK, branches: { '1': 'xfer', '2': 'q', '3': 'q', max_attempts_exceeded: 'bye' } };

describe('a key that isn\'t listed: one choice, never two competing settings', () => {
  it('reads "go straight" while Any other key is connected, even with retry on', () => {
    expect(wrongKeyChoice(HELP_DESK)).toBe(WRONG_KEY.GO);
    expect(wrongKeyChoice(HELP_DESK_FIXED)).toBe(WRONG_KEY.RETRY);
    expect(wrongKeyChoice({ ...HELP_DESK_FIXED, retry_on_invalid_option: 'no' })).toBe(WRONG_KEY.GO);
    expect(wrongKeyChoice({ ...HELP_DESK_FIXED, retry_on_invalid_option: undefined })).toBe(WRONG_KEY.GO); // runtime default: no retry
  });
  it('ask again turns retry on and disconnects Any other key, keeping every other exit', () => {
    expect(wrongKeyChoicePatch(freeze(structuredClone(HELP_DESK)), WRONG_KEY.RETRY)).toEqual({
      retry_on_invalid_option: 'yes', branches: HELP_DESK_FIXED.branches,
    });
    expect(wrongKeyChoicePatch(HELP_DESK_FIXED, WRONG_KEY.RETRY)).toEqual({ retry_on_invalid_option: 'yes' });
    expect(wrongKeyChoicePatch(HELP_DESK_FIXED, WRONG_KEY.GO)).toEqual({ retry_on_invalid_option: 'no' });
  });
  it('the go-straight picker edits Any other key, unless only an older wrong-key exit is connected', () => {
    expect(wrongKeyGoKey(HELP_DESK)).toBe('_default');
    expect(wrongKeyGoKey(HELP_DESK_FIXED)).toBe('_default');
    expect(wrongKeyGoKey({ ...HELP_DESK_FIXED, branches: { '1': 'x', invalid_option: 'w' } })).toBe('invalid_option');
  });
});

describe('test an entry (same steps as exec_gather)', () => {
  const names = { xfer: 'Transfer', q: 'Queue', bye: 'Hang up', ok: 'Check PIN' };
  const say = (node, typed) => describeEntry(node, simulateEntry(node, typed), id => names[id]);

  it('a listed key goes to its node', () => {
    expect(simulateEntry(HELP_DESK_FIXED, '2')).toMatchObject({ reason: 'valid', action: 'go', exit: '2', target: 'q' });
    expect(say(HELP_DESK_FIXED, '1')).toEqual(['Goes to Transfer.']);
  });
  it('the bug the admin hit: with Any other key connected, a wrong key hangs up without the message', () => {
    expect(simulateEntry(HELP_DESK, '7')).toMatchObject({ reason: 'valid', action: 'go', exit: '_default', target: 'bye' });
  });
  it('after clearing it, a wrong key plays the message and asks again', () => {
    expect(simulateEntry(HELP_DESK_FIXED, '7')).toMatchObject({ reason: 'invalid_option', action: 'retry', attempts: 4 });
    expect(say(HELP_DESK_FIXED, '7')).toEqual([
      'Key 7 isn\'t listed: says “This is an invalid option”, then the prompt plays again (try 2 of 4).',
      'If all 4 tries fail: says “Goodbye”, then goes to Hang up.',
    ]);
    expect(simulateEntry(HELP_DESK_FIXED, '')).toMatchObject({ reason: 'no_input', action: 'retry' });
  });
  it('one try: a failure goes straight to the final message and exit', () => {
    expect(simulateEntry({ ...HELP_DESK_FIXED, max_attempts: 1 }, '7')).toMatchObject({ action: 'exhausted', target: 'bye' });
  });
  it('retry off: the reason exit, then the runtime fallbacks', () => {
    const n = { ...HELP_DESK_FIXED, retry_on_no_input: 'no', branches: { '1': 'xfer', timeout: 'q' } };
    expect(simulateEntry(n, '')).toMatchObject({ action: 'go', exit: 'timeout', target: 'q' });
    expect(simulateEntry({ ...n, branches: { '1': 'xfer' } }, '')).toMatchObject({ action: 'go', exit: null });
    expect(say({ ...n, branches: { '1': 'xfer' } }, '')[0]).toMatch(/disconnected/);
  });
  it('PIN: length decides; the end key and the maximum end the entry', () => {
    expect(simulateEntry(PIN, '12')).toMatchObject({ reason: 'invalid_length', action: 'retry' });
    expect(simulateEntry(PIN, '1234')).toMatchObject({ reason: 'valid', exit: '_default', target: 'ok' });
    expect(simulateEntry(PIN, '12#99')).toMatchObject({ entry: '12', reason: 'invalid_length' });
    expect(simulateEntry(PIN, '123456789')).toMatchObject({ entry: '123456', reason: 'valid' });
    expect(say(PIN, '1234')).toEqual(['Goes to Check PIN, with 1234 saved as gather_result.']);
  });
  it('one attempt mode routes failures out at once; classic is not modelled', () => {
    expect(simulateEntry(EXTERNAL, '')).toMatchObject({ action: 'go', exit: 'timeout' });
    expect(simulateEntry(EXTERNAL, '5')).toMatchObject({ action: 'go', exit: 'invalid' });
    expect(simulateEntry(CLASSIC_BARE, '1')).toBeNull();
  });
});

describe('retries are shown as retries and stored as attempts', () => {
  it('retries = attempts − 1, only where retries are adjustable', () => {
    expect(retriesOf(NEW_NODE)).toBe(2);
    expect(retriesOf(CONFIG_BY_ATTEMPTS)).toBe(1);
    expect(retriesOf(INTERNAL_NO_ATTEMPTS)).toBeNull();
    expect(retriesOf(CLASSIC_BARE)).toBeNull();
    expect(retriesOf(EXTERNAL)).toBeNull();
  });
  it('writes max_attempts within the validator range (1–10)', () => {
    expect(retriesPatch(0)).toEqual({ max_attempts: 1 });
    expect(retriesPatch(2)).toEqual({ max_attempts: 3 });
    expect(retriesPatch(9)).toEqual({ max_attempts: 10 });
    expect(retriesPatch(10)).toBeNull();
    expect(retriesPatch(-1)).toBeNull();
    expect(retriesPatch(undefined)).toBeNull();
  });
});

describe('exit names: one vocabulary for panel, canvas card and wires', () => {
  const nameOf = id => ({ info: 'Opening hours', sup: 'Support desk' }[id]);
  it('option keys show their destination when connected', () => {
    const node = { ...NEW_NODE, branches: { '1': 'info', '2': '' } };
    expect(menuExitLabel(node, '1', { nameOf })).toBe('1 · Opening hours');
    expect(menuExitLabel(node, '2', { nameOf })).toBe('Press 2');
    expect(menuExitLabel(node, '1', { nameOf, withTarget: false })).toBe('Press 1');
    expect(menuExitLabel(node, '1')).toBe('Press 1');
  });
  it('failure exits use plain names', () => {
    expect(menuExitLabel(NEW_NODE, 'no_input')).toBe('No input');
    expect(menuExitLabel(NEW_NODE, 'invalid_option')).toBe('Wrong key');
    expect(menuExitLabel(NEW_NODE, 'invalid_length')).toBe('Too few digits');
    expect(menuExitLabel(NEW_NODE, 'max_attempts_exceeded')).toBe('Retries used up');
    expect(menuExitLabel(CLASSIC_BARE, 'timeout')).toBe('No input');
    expect(menuExitLabel(CLASSIC_BARE, 'invalid')).toBe('Wrong key');
    expect(menuExitLabel(PIN, 'invalid_option')).toBe('Wrong entry');
  });
  it('_default is "Number entered" when collecting digits, else the catch-all', () => {
    expect(defaultExitName(PIN)).toBe('Number entered');
    expect(menuExitLabel(PIN, '_default')).toBe('Number entered');
    expect(menuExitLabel(TEMPLATE_LAUNCH, '_default')).toBe('Any other key');
    expect(defaultExitName({ ...NEW_NODE, max_digits: 2, branches: { '10': 'a' } })).toBe('Any other entry');
  });
  it('connections the current settings do not use directly are marked', () => {
    const retryNodeWithLegacy = { type: 'gather', max_attempts: 3, branches: { '1': 'a', timeout: 'old' } };
    expect(menuExitLabel(retryNodeWithLegacy, 'timeout')).toBe('No input (fallback)');
    const classicWithV2 = { type: 'gather', branches: { '1': 'a', max_attempts_exceeded: 'm' } };
    expect(menuExitLabel(classicWithV2, 'max_attempts_exceeded')).toBe('Retries used up (unused)');
  });
  it('the canvas shows every Menu port under the panel name (no raw keys like _default)', () => {
    for (const node of Object.values(SHAPES)) {
      for (const k of gatherBranchKeysFor(node)) {
        expect(menuExitLabel(node, k), `${k} on ${JSON.stringify(node)}`).not.toMatch(/_default|max_attempts|invalid_|no_input|^timeout$|^invalid$/);
      }
    }
  });
});

describe('saving needs at least one connected exit (backend: "requires at least one branch")', () => {
  it('hasAnyExit / isWired ignore empty destinations', () => {
    expect(hasAnyExit(NEW_NODE)).toBe(false);
    expect(hasAnyExit({ ...NEW_NODE, branches: { '1': '' } })).toBe(false);
    expect(hasAnyExit({ ...NEW_NODE, branches: { '1': '', max_attempts_exceeded: 'x' } })).toBe(true);
    expect(isWired({ branches: { _default: ' ' } }, '_default')).toBe(false);
    expect(isWired({ branches: { _default: 'n' } }, '_default')).toBe(true);
  });
});

describe('validation messages are placed next to their field', () => {
  it('cross-field rules (path "type") move to the field they name', () => {
    const { byField, node } = mapMenuErrors({ branches: {} }, {
      type: [
        'prompt_source_type=audio requires prompt_audio_url',
        'no_input_source_type=tts requires no_input_text',
        'max_attempts_exceeded_source_type=audio requires max_attempts_exceeded_audio_url',
        'min_digits (4) must not exceed max_digits (2)',
        'configurable retry fields (retry_on_no_input) require max_attempts to be set — set max_attempts …',
        'something unexpected',
      ],
      variable_name: ['"uuid" is a protected channel variable'],
    }, []);
    expect(byField.prompt_audio_url).toHaveLength(1);
    expect(byField.no_input_text).toHaveLength(1);
    expect(byField.max_attempts_exceeded_audio_url).toHaveLength(1);
    expect(byField.min_digits).toHaveLength(1);
    expect(byField.max_attempts).toHaveLength(1);
    expect(byField.variable_name).toHaveLength(1);
    expect(byField.type).toBeUndefined();
    expect(node).toEqual(['something unexpected']);
  });
  it('a missing destination is shown on every row that points at it', () => {
    const { byField, node } = mapMenuErrors({ branches: { '1': 'gone', _default: 'gone', '2': 'ok' } }, {}, ['references non-existent node "gone"']);
    expect(byField['branch:1']).toHaveLength(1);
    expect(byField['branch:_default']).toHaveLength(1);
    expect(byField['branch:2']).toBeUndefined();
    expect(node).toEqual([]);
  });
});

describe('field coverage — no Menu setting can silently disappear', () => {
  it('every Gather field in the backend registry is placed by the Menu panel (and nothing stale)', async () => {
    const { NODE_TYPE_REGISTRY } = await import('../../../backend/src/nodeTypes/registry.js');
    const gather = NODE_TYPE_REGISTRY.find(n => n.type === 'gather');
    const registryKeys = gather.configSchema.map(f => f.key).sort();
    expect([...MENU_PANEL_FIELDS].sort()).toEqual(registryKeys);
  });
});

describe('source wiring', () => {
  const panel = read('../components/ivr/panels/PropertyPanel.jsx');
  const menu = read('../components/ivr/panels/menu/MenuInspector.jsx');
  it('PropertyPanel uses MenuInspector only for gather and keeps the generic form for every other type', () => {
    expect(panel).toMatch(/const isMenu\s+= node\.type === 'gather'/);
    expect(panel).toMatch(/isMenu \? \(\s*\/\/[\s\S]*<MenuInspector/);
    expect(panel).toMatch(/\{renderSchemaFields\(\)\}/);
    expect(panel).toMatch(/renderAllFields=\{renderSchemaFields\}/);
  });
  it('MenuInspector defines no component inside another component (no remounting selects)', () => {
    const antiPattern = /\n[ \t]+(const|function) [A-Z][A-Za-z0-9]*\s*(=\s*\([^)]*\)\s*=>|\()/;
    expect(antiPattern.test(menu)).toBe(false);
  });
  it('MenuInspector is one page in four plain sections, in order (no tabs)', () => {
    expect(menu).not.toMatch(/<InspectorTabs/);
    const order = ['1. What the caller hears', '2. Keys the caller can press', '3. If the caller gets it wrong', '4. More settings']
      .map(t => menu.indexOf(t));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(menu).toMatch(/2\. The number the caller enters/);
  });
  it('each retryable problem offers Ask again or Go to a node, writing only retry_on_<slot>', () => {
    expect(menu).toMatch(/\{ value: 'retry', label: 'Ask again' \}/);
    expect(menu).toMatch(/\{ value: 'exit', {2}label: 'Go to a node' \}/);
    expect(menu).toMatch(/togglePatch\(`retry_on_\$\{slot\}`, v === 'retry'\)/);
    for (const slot of ['no_input', 'invalid_option', 'invalid_length']) expect(menu).toMatch(new RegExp(`slot="${slot}"`));
  });
  it('switching to a number asks before removing keys', () => {
    expect(menu).toMatch(/confirmLabel: 'Remove keys'/);
  });
  it('the inspector header no longer prints the internal node id (copy button instead)', () => {
    expect(panel).not.toMatch(/font-mono truncate mt-0\.5">\{node\.id\}/);
    expect(panel).toMatch(/<CopyIdButton id=\{node\.id\} \/>/);
  });
  it('the canvas card draws Menu exits as rows with the Menu exit names', () => {
    const flowNode = read('../components/ivr/canvas/FlowNode.jsx');
    expect(flowNode).toMatch(/menuExitLabel\(node, p\.key/);
    expect(flowNode).toMatch(/variant=\{isMenu \? 'row' : undefined\}/);
    const canvas = read('../components/ivr/canvas/FlowCanvas.jsx');
    expect(canvas).toMatch(/from\?\.type === 'gather'\) return menuExitLabel\(from, edge\.fromPort, \{ withTarget: false \}\)/);
  });
});
