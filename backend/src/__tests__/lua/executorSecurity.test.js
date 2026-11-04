// Cycle 3 IVR security regressions, run against the REAL generated executor (Fengari).
// Each case was a confirmed defect: what a flow author, a caller, or an external API
// response could make the telephony host run. No call, network or shell is used.
import { describe, it, expect } from 'vitest';
import { runExecutor, appsExecuted } from './executorHarness.js';

const flow = (entry, nodes) => ({ entry_node_id: entry, nodes });

// POSIX shell word splitting, enough to tell whether a command line has unquoted
// operators (; | & ` $( < >) — i.e. whether a value escaped its quotes.
function shellParse(cmd) {
  const words = [];
  const operators = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) { operators.push('unterminated-quote'); break; }
      cur += cmd.slice(i + 1, end); inWord = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '`' || (cmd[j] === '$' && cmd[j + 1] === '(')) operators.push('subst-in-double-quotes');
        if (cmd[j] === '\\') j++;
        cur += cmd[j]; j++;
      }
      inWord = true; i = j; continue;
    }
    if (c === '\\') { cur += cmd[i + 1] ?? ''; inWord = true; i++; continue; }
    if (/\s/.test(c)) { if (inWord) words.push(cur); cur = ''; inWord = false; continue; }
    if (';|&`<>'.includes(c) || (c === '$' && cmd[i + 1] === '(')) {
      // "2>/dev/null" at the end of every executor curl is the only expected redirect
      if (c === '>' && cur === '2') { cur += c; continue; }
      operators.push(c);
    }
    cur += c; inWord = true;
  }
  if (inWord) words.push(cur);
  return { words, operators };
}

const bodyOf = (entry) => {
  const { words } = shellParse(entry.cmd);
  return JSON.parse(words[words.indexOf('-d') + 1]);
};


describe('webhook node (IVR-14: shell injection)', () => {
  const hostile = "https://hooks.example.com/x'; touch /tmp/pwned; echo '";
  const run = (url, vars = {}) => runExecutor({
    graph: flow('w', {
      w: { type: 'webhook', url, body_template: '{"caller":"${caller_id_name}"}', next: 'h' },
      h: { type: 'hangup' },
    }),
    vars: { destination_number: '1222', caller_id_name: "O'Brien; reboot", ...vars },
  });
  const webhookCmd = (httpLog) => httpLog.find((h) => !h.cmd.includes('X-Internal-Key'));

  it('a quote in the URL or body cannot end the shell word', () => {
    const { httpLog } = run('${hook_url}', { hook_url: hostile });
    const { words, operators } = shellParse(webhookCmd(httpLog).cmd);
    expect(operators).toEqual([]);
    expect(words[words.indexOf('--url') + 1]).toBe(hostile);
    expect(JSON.parse(words[words.indexOf('-d') + 1])).toEqual({ caller: "O'Brien; reboot" });
  });
  it('a URL starting with "-" stays a URL, not a curl option', () => {
    const { httpLog } = run('-o/tmp/x');
    const { words } = shellParse(webhookCmd(httpLog).cmd);
    expect(words[words.indexOf('--url') + 1]).toBe('-o/tmp/x');
  });
  it('characterization: still a direct POST from this host, as before; flow continues', () => {
    const { httpLog, calls } = run('https://hooks.example.com/ok');
    const { words } = shellParse(webhookCmd(httpLog).cmd);
    expect(words.slice(0, 6)).toEqual(['curl', '-s', '-m', '8', '-X', 'POST']);
    expect(words).toContain('Content-Type: application/json');
    expect(words[words.indexOf('--url') + 1]).toBe('https://hooks.example.com/ok');
    expect(httpLog.some((h) => h.cmd.includes('/ivr/rest-call'))).toBe(false);
    expect(calls.some((c) => c[0] === 'hangup')).toBe(true);
  });
});

describe('command-running channel variables (IVR-13)', () => {
  it.each([
    'api_hangup_hook', 'api_on_answer', 'execute_on_answer', 'exec_after_bridge_app', 'bridge_pre_execute_bleg_app', 'uuid',
  ])('set_variable refuses %s', (variable) => {
    const { vars, logs } = runExecutor({
      graph: flow('s', { s: { type: 'set_variable', variable, value: 'system touch /tmp/p', next: 'h' }, h: { type: 'hangup' } }),
      vars: { destination_number: '1222', uuid: 'abc' },
    });
    expect(vars[variable]).not.toBe('system touch /tmp/p');
    expect(logs.some((entry) => entry.join(' ').includes('refused to set protected variable'))).toBe(true);
  });

  // Characterization: flows may legitimately set these; they were writable before and stay so.
  it.each([
    'menu_choice', 'effective_caller_id_name', 'effective_caller_id_number', 'caller_id_number', 'destination_number',
    'hangup_after_bridge', 'transfer_after_bridge', 'conference_auto_outcall_profile', 'sip_h_X-Trace', 'api_result',
  ])('set_variable still sets %s', (variable) => {
    const { vars } = runExecutor({
      graph: flow('s', { s: { type: 'set_variable', variable, value: 'v1', next: 'h' }, h: { type: 'hangup' } }),
      vars: { destination_number: '1222' },
    });
    expect(vars[variable]).toBe('v1');
  });

  it('a REST response cannot set a hook variable; ordinary mappings still apply', () => {
    const { vars } = runExecutor({
      graph: flow('r', { r: { type: 'rest_api', url: 'https://api.example.com/', branches: { success: 'h' } }, h: { type: 'hangup' } }),
      vars: { destination_number: '1222' },
      http: { '/ivr/rest-call': { ok: true, outcome: 'success', vars: { api_hangup_hook: 'system id', acct_name: 'Sam' } } },
    });
    expect(vars.api_hangup_hook).toBeUndefined();
    expect(vars.acct_name).toBe('Sam');
  });
});

describe('caller-controlled values cannot form a command expansion (IVR-15)', () => {
  it('characterization: interp substitutes values exactly as before', () => {
    const { vars } = runExecutor({
      graph: flow('s', { s: { type: 'set_variable', variable: 'greeting', value: 'Hi ${caller_id_name}', next: 'h' }, h: { type: 'hangup' } }),
      vars: { destination_number: '1222', caller_id_name: 'Ann ${x}' },
    });
    expect(vars.greeting).toBe('Hi Ann ${x}');
  });
  it('the built-in TTS fallback never receives an API-form ${...}; plain ${var} is kept', () => {
    const { calls } = runExecutor({
      graph: flow('s', { s: { type: 'say', text: 'Hello ${caller_id_name}', next: 'h' }, h: { type: 'hangup' } }),
      vars: { destination_number: '1222', caller_id_name: '${system id} ${system(id)} ${a${b}} ${caller_id_number}' },
    });
    const speak = appsExecuted(calls).find(([app]) => app === 'speak');
    expect(speak[1]).not.toMatch(/\$\{[^}]*[\s($]/);
    expect(speak[1]).toContain('${caller_id_number}');
  });
  it('a transfer destination from a variable cannot carry ${api(args)}', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: '${agent_ext}' } }),
      vars: { destination_number: '1222', agent_ext: '${system(id)}' },
    });
    const t = appsExecuted(calls).find(([app]) => app === 'transfer');
    expect(t[1]).not.toContain('${');
  });
});

describe('transfer node (IVR-16)', () => {
  const transfers = (calls) => appsExecuted(calls).filter(([app]) => app === 'transfer');

  it('a space in a variable cannot inject a dialplan', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: '${agent_ext}' } }),
      vars: { destination_number: '1222', agent_ext: '1000 inline' },
    });
    expect(transfers(calls)).toEqual([]);
    expect(calls.some((c) => c[0] === 'hangup')).toBe(true);
  });
  it('characterization: an already-published inline transfer still runs by default (logged)', () => {
    const { calls, logs } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: 'playback:x', dialplan: 'inline' } }),
      vars: { destination_number: '1222' },
    });
    expect(transfers(calls)).toEqual([['transfer', 'playback:x inline default']]);
    expect(logs.some((e) => e.join(' ').includes('inline dialplan used'))).toBe(true);
  });
  it('ENRS_IVR_BLOCK_INLINE_TRANSFER=true blocks it', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: 'system:id', dialplan: 'inline' } }),
      vars: { destination_number: '1222' }, globalVars: { ENRS_IVR_BLOCK_INLINE_TRANSFER: 'true' },
    });
    expect(transfers(calls)).toEqual([]);
  });
  it('a variable cannot add words even when the template has its own', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: '${agent_ext} XML public' } }),
      vars: { destination_number: '1222', agent_ext: 'bridge:x inline' },
    });
    expect(transfers(calls)).toEqual([]);
  });
  it.each([
    ['words written by the flow author', '1001 XML public', {}, '1001 XML public XML default'],
    ['a trailing space in the flow', '1001 ', {}, '1001  XML default'],
    ['an empty variable', '${pfx}1001', { pfx: '' }, '1001 XML default'],
    ['a variable with surrounding whitespace only', '${agent_ext}', { agent_ext: ' 2050\n' }, ' 2050\n XML default'],
  ])('characterization: %s is passed through unchanged', (_, destination, extra, expected) => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination } }),
      vars: { destination_number: '1222', ...extra },
    });
    expect(transfers(calls)).toEqual([['transfer', expected]]);
  });
  it('characterization: a context with a space (author-written) is passed through unchanged', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: '1001', context: 'my ctx' } }),
      vars: { destination_number: '1222' },
    });
    expect(transfers(calls)).toEqual([['transfer', '1001 XML my ctx']]);
  });
  it('an inline dialplan named inside the destination follows the same inline policy', () => {
    const run = (globalVars) => runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: 'playback:x inline' } }),
      vars: { destination_number: '1222' }, globalVars,
    });
    const open = run({});
    expect(transfers(open.calls)).toEqual([['transfer', 'playback:x inline XML default']]);
    expect(open.logs.some((e) => e.join(' ').includes('inline dialplan used'))).toBe(true);
    expect(transfers(run({ ENRS_IVR_BLOCK_INLINE_TRANSFER: 'true' }).calls)).toEqual([]);
  });
  it('characterization: ordinary transfers are unchanged', () => {
    const { calls } = runExecutor({
      graph: flow('t', { t: { type: 'transfer', destination: '${agent_ext}', dialplan: 'XML', context: 'default' } }),
      vars: { destination_number: '1222', agent_ext: '2050' },
    });
    expect(transfers(calls)).toEqual([['transfer', '2050 XML default']]);
  });
});

describe('broken flows (IVR-8): hang up as before; failsafe only when enabled', () => {
  const failsafeExt = { ENRS_FAILSAFE_EXT: '9000' };
  const transfers = (calls) => appsExecuted(calls).filter(([app]) => app === 'transfer');
  const cases = [
    ['a reference to a missing node', flow('a', { a: { type: 'goto', target_node_id: 'gone' } })],
    ['an unknown node type', flow('a', { a: { type: 'teleport' } })],
    ['a loop that hits the step cap', flow('a', { a: { type: 'goto', target_node_id: 'a' } })],
  ];
  it.each(cases)('characterization: %s hangs up by default, even with a failsafe extension set', (_, graph) => {
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222' }, globalVars: failsafeExt });
    expect(transfers(calls)).toEqual([]);
    expect(calls.some((c) => c[0] === 'hangup')).toBe(true);
  });
  it.each(cases)('%s goes to the failsafe when ENRS_FAILSAFE_ON_FLOW_ERROR=true', (_, graph) => {
    const { calls } = runExecutor({ graph, vars: { destination_number: '1222' }, globalVars: { ...failsafeExt, ENRS_FAILSAFE_ON_FLOW_ERROR: 'true' } });
    expect(transfers(calls)).toEqual([['transfer', '9000 XML default']]);
  });
  it('a flow that ends normally never uses the failsafe', () => {
    const { calls } = runExecutor({ graph: flow('a', { a: { type: 'hangup' } }), vars: { destination_number: '1222' }, globalVars: { ...failsafeExt, ENRS_FAILSAFE_ON_FLOW_ERROR: 'true' } });
    expect(transfers(calls)).toEqual([]);
  });
});

describe('ENS calls carry the routed number (IVR-12)', () => {
  it('start-by-config sends ivr_number = the number the call arrived on, even after a flow changes destination_number', () => {
    const { httpLog } = runExecutor({
      graph: flow('s', {
        s: { type: 'set_variable', variable: 'destination_number', value: '7777', next: 'e' },
        e: { type: 'ens', ens_config_var: 'cfg', next: 'h' },
        h: { type: 'hangup' },
      }),
      vars: { destination_number: '1222', cfg: '42' },
      http: { '/ens/campaign/start-by-config': { success: true, campaign_id: 1 } },
    });
    const call = httpLog.find((h) => h.url.includes('/ens/campaign/start-by-config'));
    expect(bodyOf(call)).toMatchObject({ configuration_id: 42, ivr_number: '1222' });
  });
  it('ENS playback lookup sends the dialled number and the routed number', () => {
    const { httpLog } = runExecutor({
      graph: flow('p', { p: { type: 'ens_playback', branches: { unauthorized: 'h', no_campaign: 'h', active: 'h', expired: 'h' } }, h: { type: 'hangup' } }),
      vars: { destination_number: '1999' },
      http: { '/ens/lookup': null },
    });
    expect(httpLog.some((h) => h.url.includes('/ens/lookup?number=1999&ivr_number=1999'))).toBe(true);
  });
});
