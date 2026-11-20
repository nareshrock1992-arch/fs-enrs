// Golden equivalence (DTMF redesign, D16): every existing flow must behave
// EXACTLY as before. The pre-change executor (generated from main and stored as
// fixtures/ivr_executor.baseline.lua) and the current generator output are run
// in the Fengari harness on the same graphs and the same caller inputs; every
// session call, variable and routing decision must match.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runExecutor } from './executorHarness.js';
import { BUILTIN_IVR_TEMPLATES } from '../../controllers/ivrTemplates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = readFileSync(path.join(here, 'fixtures/ivr_executor.baseline.lua'), 'utf8');
const GOLDEN = JSON.parse(readFileSync(path.join(here, 'fixtures/golden-flows.json'), 'utf8'));

const flows = {
  ...Object.fromEntries(Object.entries(GOLDEN).filter(([k]) => !k.startsWith('_'))),
  ...Object.fromEntries(Object.entries(BUILTIN_IVR_TEMPLATES).map(([id, t]) => [`template:${id}`, t.graph])),
};

// Caller behaviours: each entry is the queue of digit strings the mocked session
// returns, attempt by attempt ('' = no input).
const INPUTS = [
  [], ['1'], ['2'], ['3'], ['0'], ['9'], ['#'], ['*'],
  ['', '1'], ['', '', '', '', ''], ['9', '9', '9', '9', '9'], ['9', '', '2'],
  ['1234'], ['12'], ['12', '1234'], ['123456'], ['1', '2', '3', '4'],
];

function observe(script, graph, digits) {
  const r = runExecutor({ script, graph, digits, vars: { destination_number: '100' }, readyAfter: 400 });
  return { calls: r.calls, vars: r.vars };
}

describe('golden: unchanged flows behave identically before and after the redesign', () => {
  for (const [name, graph] of Object.entries(flows)) {
    const gathers = Object.entries(graph.nodes).filter(([, n]) => n.type === 'gather').map(([id]) => id);
    const entries = [graph.entry_node_id, ...gathers.filter(id => id !== graph.entry_node_id)];
    it(`${name} (${gathers.length} menu node${gathers.length === 1 ? '' : 's'})`, () => {
      for (const entry of entries) {
        const g = { ...graph, entry_node_id: entry };
        for (const digits of INPUTS) {
          const before = observe(BASELINE, g, digits);
          const after = observe(undefined, g, digits);
          expect(after, `${name} entry=${entry} digits=${JSON.stringify(digits)}`).toEqual(before);
        }
      }
    });
  }
  it('covers at least 3 existing flows with menu nodes', () => {
    const withMenus = Object.values(flows).filter(g => Object.values(g.nodes).some(n => n.type === 'gather'));
    expect(withMenus.length).toBeGreaterThanOrEqual(3);
  });
});
