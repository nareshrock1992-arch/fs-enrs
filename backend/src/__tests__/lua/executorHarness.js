// Lua behaviour harness (Phase 0).
//
// Runs the ACTUAL generated ivr_executor.lua (from luaGenerator.js) inside
// Fengari (a pure-JS Lua 5.3 VM, dev-dependency only), with the executor's OS /
// HTTP / FreeSWITCH-session boundary replaced by JS mocks. This exercises the
// real branch/dispatch logic and the exact arguments passed to session apps —
// WITHOUT a FreeSWITCH, a network, or any production-code change.
//
// WHAT THIS PROVES (deterministic, CI-safe):
//   - node branch selection / dispatch,
//   - fail-closed routing on HTTP/parse failure,
//   - caller-disconnect handling via session:ready() flipping false,
//   - the exact app + args passed to session:execute / streamFile / hangup,
//   - clock injection (os.time) for future deadline nodes.
//
// WHAT THIS DOES NOT PROVE (needs DEV live-call on FreeSWITCH / LuaJIT):
//   - real bridge first-answer + losing-leg cancellation and originate_disposition,
//   - playAndGetDigits barge-in, streamFile interruption, Piper TTS,
//   - gateway dialing, and LuaJIT(5.1)-vs-Fengari(5.3) runtime parity.
//
// The executor's cjson `require` fails under Fengari and it transparently uses
// its own pure-Lua JSON fallback — so JSON encode/decode is exercised too.

import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import * as interop from 'fengari-interop';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

/**
 * Build a recording mock session.
 * @param {object} opts
 *   vars        initial channel variables (e.g. { destination_number: '100' })
 *   digits      queue of strings returned by getDigits / playAndGetDigits
 *   readyAfter  if a number N, session:ready() returns false once N session
 *               calls have been recorded (simulates caller hang-up mid-flow)
 */
function makeSession({ vars = {}, digits = [], readyAfter = Infinity } = {}) {
  const calls = [];
  const state = { vars: { ...vars }, hungUp: false };
  const digitQ = [...digits];
  const record = (name, ...args) => { calls.push([name, ...args]); return calls.length; };
  const stillReady = () => !state.hungUp && calls.length < readyAfter;
  const session = {
    getVariable(k) { return k in state.vars ? state.vars[k] : null; },
    setVariable(k, v) { state.vars[k] = v == null ? '' : String(v); record('setVariable', k, state.vars[k]); },
    ready() { return stillReady(); },
    answer() { record('answer'); },
    setAutoHangup() { /* no-op */ },
    streamFile(f) { record('streamFile', f); return true; },
    execute(app, data) { record('execute', app, data == null ? '' : String(data)); return true; },
    getDigits() { const d = digitQ.length ? digitQ.shift() : ''; record('getDigits', d); return d; },
    playAndGetDigits() { const d = digitQ.length ? digitQ.shift() : ''; record('playAndGetDigits', d); return d; },
    hangup(cause) { state.hungUp = true; record('hangup', cause == null ? '' : String(cause)); },
  };
  return { session, calls, state };
}

/**
 * Run the generated executor for one inbound call.
 * @param {object} opts
 *   graph       the flow graph { entry_node_id, nodes } the mocked /ivr/lookup returns
 *   vars        initial channel variables
 *   http        map of url-path substring -> response: a JSON-able value, or an
 *               array used as a FIFO queue (one response per matching request),
 *               or a function (urlPath, body) => value. `null` value simulates an
 *               empty/failed HTTP response (executor sees nil).
 *   digits      getDigits/playAndGetDigits queue
 *   now         fixed os.time() seconds (number); advanceOnPoll bumps it each
 *               time a '/ivr/' GET is made (to drive deadline loops deterministically)
 *   readyAfter  hang up after N session calls
 *   globalVars  values returned by freeswitch.API():execute('global_getvar', name)
 * @returns { calls, vars, logs, httpLog }
 */
export function runExecutor({
  graph, vars = {}, http = {}, digits = [], now = 1_000_000,
  advanceOnPoll = 0, readyAfter = Infinity, globalVars = {},
} = {}) {
  const { session, calls, state } = makeSession({ vars, digits, readyAfter });
  const logs = [];
  const httpLog = [];
  let clock = now;

  // Always answer the mocked /ivr/lookup with the provided graph unless the test
  // overrode it in `http`.
  const httpMap = { '/ivr/lookup': graph, ...http };
  const nextResponse = (urlPath, body) => {
    const key = Object.keys(httpMap).find(k => urlPath.includes(k));
    if (key === undefined) return '';            // unmatched → empty response (executor: nil)
    let v = httpMap[key];
    if (typeof v === 'function') v = v(urlPath, body);
    else if (Array.isArray(v)) v = v.length ? v.shift() : null;
    if (v === null || v === undefined) return ''; // simulated failure → empty body
    return JSON.stringify(v);
  };

  // curl command parser: the executor builds `curl ... 'URL' 2>/dev/null` and for
  // POST includes `-d '<json>'`. Extract the URL (last single-quoted or
  // double-quoted token that looks like a URL) and the -d body if present.
  const handlePopen = (cmd) => {
    const urlMatch = cmd.match(/['"](https?:\/\/[^'"]+)['"]/);
    const url = urlMatch ? urlMatch[1] : '';
    const bodyMatch = cmd.match(/-d '([^']*)'/);
    const body = bodyMatch ? bodyMatch[1] : null;
    const isPiper = /\/synthesize/.test(url);
    httpLog.push({ url, body });
    if (/\bGET\b/.test(cmd) === false && /\/ivr\//.test(url) && advanceOnPoll) clock += advanceOnPoll;
    if (isPiper) return 'piper_ok';             // pretend TTS synthesis succeeded
    return nextResponse(url, body);
  };

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // fengari-interop requires its 'js' library loaded before interop.push works.
  lauxlib.luaL_requiref(L, to_luastring('js'), interop.luaopen_js, 1);
  lua.lua_pop(L, 1);

  // ── inject JS-backed globals ────────────────────────────────────────────────
  const setGlobal = (name, jsValue) => {
    interop.push(L, jsValue);
    lua.lua_setglobal(L, to_luastring(name));
  };

  // fengari-interop delivers arguments reliably for OBJECT METHODS called with
  // Lua's colon syntax. So session (session:method()) and the freeswitch table
  // work directly; os/io mocks are exposed as methods on a harness object and
  // bound to the global os.time/io.popen via a tiny Lua bootstrap using colon.
  setGlobal('session', session);
  setGlobal('freeswitch', {
    consoleLog(level, msg) { logs.push([String(level), String(msg).replace(/\n$/, '')]); },
    API() { return { execute(cmd, arg) { return String(globalVars[String(arg)] ?? ''); } }; },
    Session() { return session; },
  });
  setGlobal('__harness', {
    popen(cmd) {
      const out = handlePopen(String(cmd));
      return { read() { return out; }, close() { return true; } };
    },
    clock() { return clock; },
  });

  const bootstrap = `
    local H = __harness
    io.popen   = function(c) return H:popen(c) end
    os.time    = function() return H:clock() end
    os.execute = function() return 0 end
    os.remove  = function() return true end
  `;
  if (lauxlib.luaL_dostring(L, to_luastring(bootstrap)) !== lua.LUA_OK) {
    throw new Error('harness bootstrap failed: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }

  const src = generateIvrExecutorLua({ apiBase: 'http://127.0.0.1:4100', apiKey: 'test', piperUrl: '' });
  const loadStatus = lauxlib.luaL_loadstring(L, to_luastring(src));
  if (loadStatus !== lua.LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error('executor Lua failed to compile under Fengari: ' + err);
  }
  const runStatus = lua.lua_pcall(L, 0, 0, 0);
  if (runStatus !== lua.LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error('executor Lua runtime error under Fengari: ' + err);
  }

  return { calls, vars: state.vars, logs, httpLog };
}

/** Convenience: the apps a node executed, e.g. [['execute','transfer','100 XML default']]. */
export function appsExecuted(calls) {
  return calls.filter(c => c[0] === 'execute').map(c => [c[1], c[2]]);
}
