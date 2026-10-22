// ENS campaign start + recording filenames — behaviour-preservation tests (Fengari).
//
// Locks in the ORIGINAL (baseline 6ab4dc6) campaign-start behaviour, plus the
// approved PIN-forwarding correction:
//   • ens_blast_trigger.lua: one campaign-start request (http_post: curl -sf,
//     8 s), no retry, the original caller message on any failure, the original
//     recording filename ENRS_REC_DIR/ens_<cfg>_<callerdigits>_<ts>.wav, and the
//     verified PIN forwarded to /campaign/start (existing server contract).
//   • Generated IVR executor: `ens` node — one start-by-config request, original
//     logs; `ens_blast_record` — original filename ens/ens_<cfg>_<ts>.wav.
//
// Proves Lua-side behaviour only. No FreeSWITCH, no network.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import * as interop from 'fengari-interop';
import { runExecutor } from './executorHarness.js';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLAST_SRC = readFileSync(path.resolve(__dirname, '../../../../Lua-scripts/ens_blast_trigger.lua'), 'utf8');
const START = '/ens/campaign/start-by-config';
const flow = (entry, nodes) => ({ entry_node_id: entry, nodes });
const startCalls = (httpLog, p = START) => httpLog.filter((h) => h.url.includes(p));
// fengari-interop shifts dot-call arguments: consoleLog(level, msg) arrives as [msg, undefined]
// (same in executorHarness), so match the text in either slot.
const has = (logs, re) => logs.some(([a, b]) => re.test(a) || re.test(String(b)));

// ── IVR executor: ens node (original behaviour) ──────────────────────────────
describe('IVR ens node — campaign start (original behaviour)', () => {
  const graph = flow('e', { e: { type: 'ens', ens_configuration_id: 7, next: 'h' }, h: { type: 'hangup' } });
  const vars = { destination_number: '500', caller_id_number: '1001', recorded_file_path: '/rec/ivr/ivr_u-1_1000000.wav' };

  it('success: one request carrying the recording file; campaign id stored', () => {
    const r = runExecutor({ graph, vars, http: { [START]: { success: true, campaign_id: 'c-1', total_destinations: 2 } } });
    const calls = startCalls(r.httpLog);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body).recording_file).toBe(vars.recorded_file_path);
    expect(r.vars.ens_notification_uuid).toBe('c-1');
  });

  it('no response: exactly one request (no retry), logged as "blast failed — no response"', () => {
    const r = runExecutor({ graph, vars, http: { [START]: () => null } });
    expect(startCalls(r.httpLog)).toHaveLength(1);
    expect(has(r.logs, /ens node: blast failed — no response/)).toBe(true);
  });

  it('error body (e.g. 503 MEDIA_BUSY / 4xx): exactly one request, logged with the server error', () => {
    const r = runExecutor({ graph, vars, http: { [START]: () => ({ error: 'MEDIA_BUSY' }) } });
    expect(startCalls(r.httpLog)).toHaveLength(1);
    expect(has(r.logs, /ens node: blast failed — MEDIA_BUSY/)).toBe(true);
  });

  it('uses the standard post() helper (default executor timeout), as in the baseline', () => {
    const src = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: '' });
    expect(src).toContain('local d = post("/ens/campaign/start-by-config", {');
    expect(src).not.toContain('http_request("POST", "/ens/campaign/start-by-config"');
  });
});

// ── IVR executor: ens_blast_record filename (original format) ────────────────
describe('IVR ens_blast_record — recording filename (original format)', () => {
  const graph = flow('b', { b: { type: 'ens_blast_record', ens_configuration_id: 7, next: 'h' }, h: { type: 'hangup' } });
  const run = () => runExecutor({
    graph, now: 1_700_000_000, digits: ['1234'],
    vars: { destination_number: '500', caller_id_number: '1001', uuid: '11111111-aaaa-4bbb-8ccc-000000000001' },
    globalVars: { recordings_dir: '/var/lib/freeswitch/recordings' },
    http: { '/ens/verify-pin': { authorized: true }, '/ens/notifications': { notification_uuid: 'n-1' } },
  });
  const recordedPath = (r) => r.calls.find((c) => c[0] === 'execute' && c[1] === 'record')[2].split(' ')[0];

  it('records to <recordings_dir>/ens/ens_<cfg>_<ts>.wav (no call UUID) and sends that path', () => {
    const r = run();
    // Fengari is Lua 5.3: the mocked os.time() is a float there ("1700000000.0"); FreeSWITCH's Lua 5.1 gives an integer.
    expect(recordedPath(r)).toMatch(/^\/var\/lib\/freeswitch\/recordings\/ens\/ens_7_1700000000(\.0)?\.wav$/);
    const sent = JSON.parse(r.httpLog.find((h) => h.url.includes('/ens/notifications')).body);
    expect(sent.recording_file).toBe(recordedPath(r));
  });
});

// ── Standalone script: Lua-scripts/ens_blast_trigger.lua ─────────────────────
const LUA_JSON = (() => {
  const m = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: '' }).match(/\n {2}json = (\{[\s\S]*?\n {2}\})\n/);
  if (!m) throw new Error('could not extract the executor JSON fallback');
  return m[1];
})();

/**
 * Run ens_blast_trigger.lua for one call.
 *   start:    function(attempt, body) => [httpCode, responseObject|null]. The script
 *             uses `curl -sf`, so any non-2xx (or no response) yields an EMPTY body.
 *   pins:     digits the caller enters at each PIN prompt (session "read" → read_result)
 *   validPin  PIN that the mocked /ens/verify-pin accepts
 */
function runBlast({ caller = '5551234', uuid = 'u-1', now = 1_700_000_000, start, cfg = { configuration_id: 7, name: 'Plant', pin_required: false }, pins = [], validPin = null }) {
  const logs = [], calls = [], starts = [], verifies = [], spoken = [];
  const vars = { destination_number: '500', caller_id_number: caller, uuid };
  const pinQ = [...pins];
  const session = {
    getVariable(k) { return k in vars ? vars[k] : null; },
    setVariable(k, v) { vars[k] = String(v); },
    ready() { return true; },
    answer() { calls.push(['answer']); },
    sleep(ms) { calls.push(['sleep', ms]); },
    execute(app, data) {
      calls.push(['execute', app, String(data ?? '')]);
      if (app === 'read') vars.read_result = pinQ.length ? pinQ.shift() : '';
    },
    streamFile(f) { calls.push(['streamFile', f]); },
    hangup(c) { calls.push(['hangup', String(c ?? '')]); },
  };
  const popen = (cmd) => {
    const url = (cmd.match(/['"](https?:\/\/[^'"]+)['"]/) || [])[1] || '';
    if (url.includes('/synthesize')) {                       // Piper TTS: record the prompt text, report failure (silent)
      const b = (cmd.match(/-d '([^']*)'/) || [])[1] || '';
      const m = b.match(/"text":"((?:[^"\\]|\\.)*)"/); if (m) spoken.push(m[1]);
      return '';
    }
    if (url.includes('/ens/lookup')) return JSON.stringify({ success: true, data: cfg });
    if (url.includes('/ens/verify-pin')) {
      const body = JSON.parse((cmd.match(/-d '([^']*)'/) || [])[1] || '{}');
      verifies.push(body);
      const ok = validPin !== null && body.pin === validPin;
      return ok ? JSON.stringify({ success: true, authorized: true, pin_required: true }) : '';   // curl -sf: 401 → empty
    }
    if (url.includes('/ens/campaign/start')) {
      const body = (cmd.match(/-d '([^']*)'/) || [])[1];
      starts.push({ body, cmd });
      const [code, resp] = start(starts.length, body);
      return code >= 200 && code < 300 && resp ? JSON.stringify(resp) : '';                      // curl -sf semantics
    }
    return '';
  };
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lauxlib.luaL_requiref(L, to_luastring('js'), interop.luaopen_js, 1); lua.lua_pop(L, 1);
  const setGlobal = (n, v) => { interop.push(L, v); lua.lua_setglobal(L, to_luastring(n)); };
  setGlobal('session', session);
  setGlobal('freeswitch', {
    consoleLog(level, msg) { logs.push([String(level), String(msg).replace(/\n$/, '')]); },
    API() { return { execute() { return '/var/lib/freeswitch/recordings'; } }; },
  });
  setGlobal('__h', {
    popen(c) { const out = popen(String(c)); return { read() { return out; }, close() { return true; } }; },
    open() { return { seek() { return 6000; }, close() { return true; } }; },   // recording "exists", 6000 bytes
    clock() { return now; },
  });
  const boot = `
    local H = __h
    io.popen = function(c) return H:popen(c) end
    io.open  = function(p, m) return H:open(p) end
    os.time  = function() return math.tointeger(H:clock()) end   -- integer, as on FreeSWITCH
    os.execute = function() return 0 end
    os.remove  = function() return true end
    -- Pure Lua (a JS null would arrive as a truthy userdata): only PIPER_LUA_URL is set,
    -- so speak() issues observable Piper requests; everything else uses the script defaults.
    os.getenv  = function(k) if k == "PIPER_LUA_URL" then return "http://piper.test" end return nil end
    package.preload["cjson"] = function() return ${LUA_JSON} end
  `;
  for (const [what, code] of [['bootstrap', boot], ['ens_blast_trigger.lua', BLAST_SRC]]) {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      throw new Error(`${what} failed under Fengari: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
  }
  return { logs, calls, starts, verifies, spoken, recPath: () => JSON.parse(starts[0].body).recording_file };
}
const ORIGINAL_FAILURE_MSG = 'There was a problem starting your notification. Please contact your administrator or try again.';
const ok = () => [201, { success: true, campaign_id: 'c-1', total_destinations: 3 }];

describe('ens_blast_trigger.lua — campaign start (original behaviour)', () => {
  it('success: one request via curl -sf with the original 8 s timeout', () => {
    const r = runBlast({ start: ok });
    expect(r.starts).toHaveLength(1);
    expect(r.starts[0].cmd).toMatch(/curl -sf -m 8 -X POST/);
    expect(has(r.logs, /Campaign started: id=c-1/)).toBe(true);
    expect(r.spoken).not.toContain(ORIGINAL_FAILURE_MSG);
  });

  for (const [label, code] of [['no response / client timeout', 0], ['503 (e.g. MEDIA_BUSY)', 503], ['4xx', 422]]) {
    it(`${label}: exactly one request (no retry), original failure log + caller message, call ends`, () => {
      const r = runBlast({ start: () => [code, code ? { success: false, error: 'x' } : null] });
      expect(r.starts).toHaveLength(1);
      expect(has(r.logs, /Campaign start failed: no response from server/)).toBe(true);
      expect(r.spoken).toContain(ORIGINAL_FAILURE_MSG);
      expect(r.spoken.some((t) => /could not confirm/i.test(t))).toBe(false);
      expect(r.calls).toContainEqual(['hangup', 'NORMAL_CLEARING']);
    });
  }
});

describe('ens_blast_trigger.lua — recording filename (original format)', () => {
  it('ENRS_REC_DIR default + ens_<cfg>_<callerdigits>_<ts>.wav, no call UUID; recorded path = path sent', () => {
    const r = runBlast({ caller: '+1 (555) 123-4567', uuid: 'u-9', start: ok });
    const rec = r.calls.find((c) => c[0] === 'execute' && c[1] === 'record')[2].split(' ')[0];
    expect(rec).toBe('/opt/freeswitch/recordings/ens/ens_7_15551234567_1700000000.wav');
    expect(r.recPath()).toBe(rec);
  });
  it('anonymous caller keeps the original empty caller segment', () => {
    expect(runBlast({ caller: '', start: ok }).recPath()).toBe('/opt/freeswitch/recordings/ens/ens_7__1700000000.wav');
  });
});

describe('ens_blast_trigger.lua — PIN-protected and unprotected campaign starts', () => {
  const PIN_CFG = { configuration_id: 7, name: 'Plant', pin_required: true };
  const startBody = (r, i = 0) => JSON.parse(r.starts[i].body);

  it('PIN-protected: the PIN verified via /ens/verify-pin is sent with the campaign start', () => {
    const r = runBlast({ cfg: PIN_CFG, pins: ['4321'], validPin: '4321', start: ok });
    expect(r.verifies).toEqual([{ trigger_number: '500', pin: '4321' }]);
    expect(r.starts).toHaveLength(1);
    expect(startBody(r).pin).toBe('4321');
    expect(has(r.logs, /Campaign started: id=c-1/)).toBe(true);
  });

  it('PIN-protected: a wrong PIN on an earlier attempt is not sent — only the PIN that was verified', () => {
    const r = runBlast({ cfg: PIN_CFG, pins: ['1111', '4321'], validPin: '4321', start: ok });
    expect(r.verifies.map((v) => v.pin)).toEqual(['1111', '4321']);
    expect(startBody(r).pin).toBe('4321');
  });

  it('PIN-protected: three wrong PINs → no campaign-start request at all, call rejected', () => {
    const r = runBlast({ cfg: PIN_CFG, pins: ['1', '2', '3'], validPin: '4321', start: ok });
    expect(r.starts).toHaveLength(0);
    expect(r.calls).toContainEqual(['hangup', 'CALL_REJECTED']);
  });

  it('PIN-protected: a server-side rejection → one request, original failure message', () => {
    const r = runBlast({ cfg: PIN_CFG, pins: ['4321'], validPin: '4321', start: () => [401, { success: false, error: 'PIN required or invalid' }] });
    expect(r.starts).toHaveLength(1);
    expect(r.spoken).toContain(ORIGINAL_FAILURE_MSG);
  });

  it('unprotected: no PIN prompt, no verify-pin call, and no pin field in the start request', () => {
    const r = runBlast({ start: ok });
    expect(r.verifies).toHaveLength(0);
    expect(r.calls.some((c) => c[0] === 'execute' && c[1] === 'read')).toBe(false);
    expect('pin' in startBody(r)).toBe(false);
  });
});
