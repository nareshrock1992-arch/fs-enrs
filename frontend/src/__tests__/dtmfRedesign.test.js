// DTMF node redesign (docs/ivr/DTMF_NODE_DESIGN.md): routes, exit names,
// legacy normalisation, separate exits, defaults/reset, summary, client lint.
import { describe, it, expect } from 'vitest';
import { gatherBranchKeysFor } from '../components/ivr/canvas/nodePorts.js';
import {
  menuExitLabel, collectType, COLLECT, routeKeys, optionKeys, panelKeys, menuRows,
  separateExits, immediateExitReasons, separateExitsPatch, retryFirstPatch,
  isModified, resetAdvancedPatch, summaryLine, menuLint, menuChips, menuModeBadge,
  addRoutePatch, updateRoutePatch, removeRoutePatch, moveRoutePatch, renameOptionPatch, optionLabelPatch,
  isFailureExit, collectTypePatch,
} from '../components/ivr/panels/menu/menuModel.js';
import * as fe from '../components/ivr/panels/menu/gatherRoutes.js';
import * as be from '../../../backend/src/utils/gatherRoutes.js';
import { NODE_DEFAULTS } from '../hooks/useIvrGraph.js';

const NEW = { type: 'gather', ...NODE_DEFAULTS.gather };
const PIN = {
  ...NEW, min_digits: 4, max_digits: 4, variable_name: 'account',
  routes: [{ id: 'r1', type: 'equals', value: '1234' }, { id: 'r2', type: 'range', value: '2000', value2: '2999', name: 'Branch office' }],
  branches: { route_r1: 'x', route_r2: 'y', _default: 'z', max_attempts_exceeded: 'f' },
};

describe('legacy flows: old exits get the new names, nothing disappears (brief E)', () => {
  // Shapes saved before the redesign.
  const legacyRetry = { type: 'gather', max_attempts: 3, branches: { 1: 'a', invalid_option: 'b', max_attempts_exceeded: 'c' } };
  const legacyBoth  = { type: 'gather', max_attempts: 3, retry_on_no_input: 'no', branches: { 1: 'a', no_input: 'n', invalid_option: 'i', max_attempts_exceeded: 'c' } };
  const legacyPin   = { type: 'gather', max_attempts: 3, min_digits: 4, max_digits: 4, branches: { _default: 'ok', max_attempts_exceeded: 'c' } };
  const classic     = { type: 'gather', prompt_text: 'x', branches: { 1: 'a', timeout: 't', invalid: 'i' } };
  it('"Retries used up" → Failed, "Wrong entry"/"Wrong key" → Invalid, "Entry complete" → Any valid entry', () => {
    expect(menuExitLabel(legacyRetry, 'max_attempts_exceeded')).toBe('Failed');
    expect(menuExitLabel(legacyRetry, 'invalid_option')).toBe('Invalid');
    expect(menuExitLabel(legacyPin, '_default')).toBe('Any valid entry');
    expect(menuExitLabel(classic, 'timeout')).toBe('No input');
    expect(menuExitLabel(classic, 'invalid')).toBe('Invalid');
  });
  it('an older node with No-input AND Invalid edges shows separate exits ON, so no edge is lost', () => {
    expect(separateExits(legacyBoth)).toBe(true);
    expect(gatherBranchKeysFor(legacyBoth)).toEqual(expect.arrayContaining(['no_input', 'invalid_option', 'max_attempts_exceeded']));
  });
  it('builder nodes from before the redesign (wrong key exits at once) show separate exits and an "older setting"', () => {
    const before = { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: { 1: 'a' } };
    expect(separateExits(before)).toBe(true);
    expect(immediateExitReasons(before)).toEqual(['invalid_option']);
    expect(retryFirstPatch('invalid_option')).toEqual({ retry_on_invalid_option: 'yes' });
  });
  it('normalising is display-only: no stored key or field changes', () => {
    for (const n of [legacyRetry, legacyBoth, legacyPin, classic]) {
      const before = JSON.stringify(n);
      gatherBranchKeysFor(n); menuRows(n); separateExits(n); menuLint(n); summaryLine(n);
      expect(JSON.stringify(n)).toBe(before);
    }
  });
});

describe('new nodes: every failure retries, one Failed exit (D6, D8)', () => {
  it('a new Menu shows only Failed as its failure exit', () => {
    expect(separateExits(NEW)).toBe(false);
    expect(gatherBranchKeysFor(NEW).filter(isFailureExit)).toEqual(['max_attempts_exceeded']);
  });
  it('turning separate exits on adds No input and Invalid after the success exits', () => {
    const on = { ...NEW, ...separateExitsPatch(NEW, true), branches: { 1: 'a' } };
    expect(gatherBranchKeysFor(on)).toEqual(['1', 'no_input', 'invalid_option', 'max_attempts_exceeded']);
  });
  it('turning it off retries every failure and drops the failure exits', () => {
    const p = separateExitsPatch({ ...NEW, branches: { 1: 'a', no_input: 'n', invalid_option: 'i' } }, false);
    expect(p).toMatchObject({ failure_exits: undefined, retry_on_no_input: 'yes', retry_on_invalid_option: 'yes', retry_on_invalid_length: 'yes' });
    expect(p.branches).toEqual({ 1: 'a' });
  });
});

describe('Digits routes in the model', () => {
  it('route exits are ports, labelled by the rule, success before failure', () => {
    expect(collectType(PIN)).toBe(COLLECT.DIGITS);
    expect(routeKeys(PIN)).toEqual(['route_r1', 'route_r2']);
    expect(optionKeys(PIN)).toEqual([]);
    expect(gatherBranchKeysFor(PIN)).toEqual(['route_r1', 'route_r2', '_default', 'max_attempts_exceeded']);
    expect(menuExitLabel(PIN, 'route_r1')).toBe('= 1234');
    expect(menuExitLabel(PIN, 'route_r2')).toBe('Branch office');
    expect([...panelKeys(PIN)].sort()).toEqual([...gatherBranchKeysFor(PIN)].sort());
  });
  it('add / edit / reorder / remove', () => {
    let n = { ...PIN, ...addRoutePatch(PIN, 'starts_with') };
    expect(n.routes.map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
    n = { ...n, ...updateRoutePatch(n, 'r3', { value: '9' }) };
    expect(n.routes[2]).toEqual({ id: 'r3', type: 'starts_with', value: '9' });
    n = { ...n, ...updateRoutePatch(n, 'r2', { type: 'equals' }) };
    expect(n.routes[1].value2).toBeUndefined();                     // value2 only for ranges
    n = { ...n, ...moveRoutePatch(n, 'r3', -1) };
    expect(n.routes.map(r => r.id)).toEqual(['r1', 'r3', 'r2']);
    n = { ...n, ...removeRoutePatch(n, 'r1') };
    expect(n.routes.map(r => r.id)).toEqual(['r3', 'r2']);
    expect(n.branches.route_r1).toBeUndefined();
  });
  it('switching back to a key menu keeps routes from counting as options', () => {
    expect(collectTypePatch(PIN, COLLECT.MENU)).toEqual({ min_digits: 1, max_digits: 1 });
  });
});

describe('Menu options: labels and automatic digit count (D11, D12)', () => {
  it('an option label is shown on the exit and follows a key rename', () => {
    let n = { ...NEW, branches: { 1: 'a' } };
    n = { ...n, ...optionLabelPatch(n, '1', 'Sales') };
    expect(menuExitLabel(n, '1')).toBe('1 · Sales');
    n = { ...n, ...renameOptionPatch(n, '1', '10') };
    expect(n.option_labels).toEqual({ 10: 'Sales' });
    expect(n.max_digits).toBe(2);                                   // raised for the 2-digit key
  });
  it('clearing the last label removes the field', () => {
    expect(optionLabelPatch({ option_labels: { 1: 'x' } }, '1', '')).toEqual({ option_labels: undefined });
  });
});

describe('Advanced: defaults, modified markers, reset, summary line', () => {
  it('a new node is all defaults', () => {
    for (const k of ['max_attempts', 'timeout_seconds', 'inter_digit_timeout', 'reprompt_pause_ms', 'allow_barge_in', 'no_input', 'invalid_option']) {
      expect(isModified(NEW, k), k).toBe(false);
    }
    expect(summaryLine(NEW)).toBe('3 tries · 5 s timeout · barge-in on');
  });
  it('changed fields are marked and reset puts them back', () => {
    const changed = { ...NEW, max_attempts: 5, timeout_seconds: 8, allow_barge_in: 'no', terminators: '#', no_input_source_type: 'tts', no_input_text: 'Sorry' };
    expect(isModified(changed, 'max_attempts')).toBe(true);
    expect(isModified(changed, 'timeout_seconds')).toBe(true);
    expect(isModified(changed, 'allow_barge_in')).toBe(true);
    expect(isModified(changed, 'no_input')).toBe(true);
    expect(summaryLine(changed)).toBe('5 tries · 8 s timeout · barge-in off · # ends entry');
    const reset = { ...changed, ...resetAdvancedPatch(changed) };
    for (const k of ['max_attempts', 'timeout_seconds', 'allow_barge_in', 'no_input']) expect(isModified(reset, k), k).toBe(false);
    expect(reset.no_input_text).toBe('Sorry');                      // text kept, only the source switched off
  });
});

describe('client lint drives the canvas icon (brief F / problem 6)', () => {
  it('"No prompt text" is never a green tick', () => {
    expect(menuLint({ ...NEW, branches: { 1: 'a', max_attempts_exceeded: 'f' } }).warnings).toContain('The prompt has no text');
  });
  it('no options or no exit is an error; a bad route is an error; an unconnected route is a warning', () => {
    expect(menuLint(NEW).errors).toEqual(expect.arrayContaining(['Connect at least one exit', 'Add at least one option']));
    const bad = { ...PIN, prompt_text: 'Enter', routes: [{ id: 'r1', type: 'range', value: '9', value2: '1' }] };
    expect(menuLint(bad).errors.join()).toMatch(/larger/);
    const unconnected = { ...PIN, prompt_text: 'Enter', branches: { _default: 'z', max_attempts_exceeded: 'f' } };
    expect(menuLint(unconnected).warnings.join()).toMatch(/not connected/);
  });
  it('a complete node is clean', () => {
    expect(menuLint({ ...PIN, prompt_text: 'Enter your account number' })).toEqual({ errors: [], warnings: [] });
  });
  it('card chips and badge', () => {
    expect(menuChips({ ...PIN, terminators: '#' })).toEqual(['4 digits', '#', '3 tries']);
    expect(menuModeBadge(PIN)).toBe('Digits');
    expect(menuModeBadge(NEW)).toBe('Menu');
  });
});

describe('frontend and backend route logic agree (parity)', () => {
  const samples = ['^[2-4]\\d{3}$', '^1\\d{1,2}#?$', '\\*\\d{2,}', '^(1|2)$', '[12', '^0.\\d$', '9_1'];
  it('regex → Lua pattern', () => {
    for (const s of samples) expect(fe.regexToLuaPattern(s), s).toBe(be.regexToLuaPattern(s));
  });
  it('errors, matches, labels and warnings', () => {
    const routes = [
      { type: 'range', value: '1000', value2: '1999' }, { type: 'equals', value: '1234' },
      { type: 'one_of', value: '1001, 5' }, { type: 'pattern', value: '^9\\d+$' }, { type: 'length', value: '4' }, { type: 'starts_with', value: '' },
    ];
    for (const r of routes) {
      expect(fe.routeError(r)).toBe(be.routeError(r));
      expect(fe.routeLabel(r)).toBe(be.routeLabel(r));
      for (const d of ['1234', '1500', '5', '9123', '4444']) expect(fe.routeMatches(r, d)).toBe(be.routeMatches(r, d));
    }
    expect(fe.routeWarnings(routes)).toEqual(be.routeWarnings(routes));
  });
});
