/**
 * Gather DTMF — inter_digit_timeout wired into the configurable path.
 *
 * getDigits accepts an optional 4th (inter-digit) argument; the configurable
 * path now passes it. Legacy paths are unchanged. Generator-level assertions
 * (no FreeSWITCH runtime in this environment).
 */

import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

const lua = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: 'http://p' });
const gather = lua.slice(lua.indexOf('local function exec_gather('), lua.indexOf('local function exec_condition('));
const legacyHalf = gather.slice(0, gather.indexOf('NEW CONFIGURABLE PATH'));
const newHalf    = gather.slice(gather.indexOf('NEW CONFIGURABLE PATH'));

describe('configurable path honors inter_digit_timeout', () => {
  it('computes idt from node.inter_digit_timeout', () => {
    expect(newHalf).toContain('local idt     = (node.inter_digit_timeout or 2) * 1000');
  });
  it('passes idt as the 4th getDigits argument', () => {
    expect(newHalf).toContain('s:getDigits(max_d, terms, timeout, idt)');
  });
});

describe('legacy paths unchanged', () => {
  it('legacy TTS path keeps the 3-arg getDigits (single overall timeout)', () => {
    expect(legacyHalf).toContain('s:getDigits(max_d, terms, timeout) or ""');
    expect(legacyHalf).not.toContain('s:getDigits(max_d, terms, timeout, idt)');
  });
  it('legacy audio path still passes idt to playAndGetDigits', () => {
    expect(legacyHalf).toContain('s:playAndGetDigits(min_d, max_d, 3, timeout, terms, pf, "", "[0-9#*]+", "", idt)');
  });
});
