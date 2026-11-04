// IVR-17: the caller's number and name go inside the originate {...} block of every
// responder leg. A caller-controlled value must not add a variable to that block.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../services/eslService.js', () => ({ eslCommand: vi.fn(), getConferenceMemberCount: vi.fn(), seedConferenceRegistry: vi.fn() }));
vi.mock('../../services/dialResolver.js', () => ({ resolveDialString: vi.fn() }));
vi.mock('../../services/socketService.js', () => ({ emitInternal: vi.fn() }));
vi.mock('../../services/freeSwitchPathService.js', () => ({ fsPathService: {} }));
vi.mock('../../config/index.js', () => ({ config: { freeswitch: { sipDomain: '' } } }));

const { callerIdentityVars } = await import('../../services/ersRingService.js');

// Split an originate variable block the way the engine does: on commas outside quotes.
const splitVars = (vars) => {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const c of vars.join(',')) {
    if (c === "'") quoted = !quoted;
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((v) => v.split('=')[0]);
};

describe('caller identity in the originate block', () => {
  it('ordinary callers are unchanged', () => {
    expect(callerIdentityVars({ number: '+966 51 234 5678', name: 'Naresh Babu' })).toEqual([
      "origination_caller_id_name='Naresh Babu'", 'origination_caller_id_number=+966512345678',
      "effective_caller_id_name='Naresh Babu'", 'effective_caller_id_number=+966512345678',
    ]);
    expect(callerIdentityVars({ number: '1821', name: null })).toEqual(['origination_caller_id_number=1821', 'effective_caller_id_number=1821']);
  });

  it('a number with no digits that could inject is left out', () => {
    const vars = callerIdentityVars({ number: 'x,execute_on_answer=system touch /tmp/p', name: null });
    expect(vars).toEqual([]);
  });

  it('a plain non-numeric caller ID is passed through as before (anonymous, restricted)', () => {
    expect(callerIdentityVars({ number: 'anonymous', name: null })).toEqual(['origination_caller_id_number=anonymous', 'effective_caller_id_number=anonymous']);
  });

  it('a name cannot close its quote, close the block or form ${...}', () => {
    const vars = callerIdentityVars({ number: '1821', name: "Eve',execute_on_answer=x}${system id}" });
    expect(splitVars(vars)).toEqual(['origination_caller_id_name', 'origination_caller_id_number', 'effective_caller_id_name', 'effective_caller_id_number']);
    expect(vars.join(',')).not.toMatch(/[{}]|\$\{/);
  });

  it('characterization: "$" in a name and an empty number are presented as before', () => {
    expect(callerIdentityVars({ number: '', name: 'Joe $mith' })).toEqual([
      "origination_caller_id_name='Joe $mith'", 'origination_caller_id_number=',
      "effective_caller_id_name='Joe $mith'", 'effective_caller_id_number=',
    ]);
  });
});
