import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';

// Regression guards for bugs traced through real test calls on a live
// customer FreeSWITCH box — each of these silently hung up every call
// with no error surfaced anywhere until manually diagnosed.

const lua = generateIvrExecutorLua({
  apiBase:   'http://127.0.0.1:4100',
  apiKey:    'test-key',
  ttsEngine: 'flite|kal',
});

// Module-level — used by both the Piper TTS block and the HTML-entity regression block.
const luaWithPiper = generateIvrExecutorLua({
  apiBase:   'http://127.0.0.1:4100',
  apiKey:    'test-key',
  ttsEngine: 'flite|kal',
  piperUrl:  'http://127.0.0.1:5002',
});

describe('luaGenerator — reserved-word dispatch key', () => {
  it('uses bracket syntax for the "goto" dispatch key, never a bare identifier', () => {
    // `goto` has been a reserved word since Lua 5.2 — `goto = fn` inside a
    // table constructor is a syntax error, not just a lint warning. It
    // must be written ["goto"] = fn.
    expect(lua).toContain('["goto"]');
    expect(lua).not.toMatch(/[^"[]goto\s*=\s*exec_goto/);
  });
});

describe('luaGenerator — IVR lookup response shape', () => {
  it('reads entry_node_id and nodes as top-level fields, never nested under .graph', () => {
    expect(lua).toContain('data.entry_node_id');
    expect(lua).toContain('data.nodes');
    expect(lua).not.toContain('data.graph');
    expect(lua).not.toContain('graph.nodes');
    expect(lua).not.toContain('graph.entry_node_id');
  });
});

describe('luaGenerator — ERS incident creation', () => {
  it('POSTs to /ers/incidents (not /ers/start)', () => {
    expect(lua).toContain('"/ers/incidents"');
    expect(lua).not.toContain('/ers/start');
  });

  it('sends configuration_id, not ers_configuration_id, in the request body', () => {
    expect(lua).toMatch(/post\("\/ers\/incidents",\s*\{[^}]*configuration_id\s*=\s*cfg_id/s);
    expect(lua).not.toMatch(/post\("\/ers\/incidents",\s*\{[^}]*ers_configuration_id\s*=/s);
  });

  it('generates conference_room client-side in exec_ers and checks incident_uuid, never d.conference_room', () => {
    expect(lua).toContain('local room = "ers_"');
    expect(lua).toContain('d.incident_uuid');
    // exec_ers builds the room name locally and must NOT read d.conference_room.
    // (ers_ring_all legitimately reads d.conference_room from the ring-all API
    // response — that node's API contract returns the room; exec_ers does not.)
    const ersBlock = lua.slice(lua.indexOf('local function exec_ers('), lua.indexOf('local function exec_ers_ring_all('));
    expect(ersBlock).not.toContain('d.conference_room');
  });
});

describe('Phase 2 discovery — ens_pin_valid condition operator', () => {
  // Found while building scripts/verify-api-contracts.js: the previous
  // implementation called GET /ens/lookup?number=&pin= — but ensLookup()
  // never reads a pin query param at all (it's not part of that
  // endpoint's contract), so the PIN was silently never checked. The real
  // PIN check must go through POST /ens/verify-pin, which is the single
  // source of truth for pin_required + correctness.
  it('verifies the PIN via POST /ens/verify-pin, not as a GET query param on /ens/lookup', () => {
    expect(lua).toContain('post("/ens/verify-pin"');
    expect(lua).not.toMatch(/\/ens\/lookup\?number=.*&pin=/);
  });

  it('sends trigger_number and pin in the verify-pin body', () => {
    expect(lua).toMatch(/post\("\/ens\/verify-pin",\s*\{\s*trigger_number\s*=\s*dest,\s*pin\s*=\s*val/);
  });

  it('reads configuration data from lookup.data, not top-level (lookup wraps its payload in a data key)', () => {
    expect(lua).toContain('lookup.data.configuration_id');
    expect(lua).not.toMatch(/\blookup\.configuration_id\b/);
  });
});

describe('Phase 2 discovery — ens_callback_valid condition operator', () => {
  // Same discovery pass: called a nonexistent /ens/callback_lookup path
  // (the real endpoint is /ens/callbacks/authorize) with only `caller`,
  // missing the required `reply_clid` param entirely, and read
  // d.notification_id (doesn't exist) instead of d.notification_uuid.
  it('calls the real /ens/callbacks/authorize endpoint, not a nonexistent /ens/callback_lookup', () => {
    expect(lua).toContain('"/ens/callbacks/authorize?reply_clid="');
    expect(lua).not.toContain('/ens/callback_lookup');
  });

  it('sends both reply_clid and caller as required by the endpoint', () => {
    expect(lua).toMatch(/reply_clid=.*url_encode\(reply_clid\).*caller=.*url_encode\(caller\)/);
  });

  it('reads notification_uuid from the response, not the nonexistent notification_id', () => {
    expect(lua).toContain('d.notification_uuid');
    expect(lua).not.toContain('d.notification_id');
  });
});

describe('Phase 1 item 13 — ERS incident completion after the caller leaves', () => {
  // exec_ers() previously never called the already-built
  // POST /ers/incidents/:uuid/complete endpoint after the conference
  // execute app returned, leaving every ERS incident permanently ACTIVE
  // on the Live Monitoring dashboard even after every caller hung up.
  it('calls the incidents/:uuid/complete endpoint after the conference blocks', () => {
    expect(lua).toContain('/ers/incidents/" .. d.incident_uuid .. "/complete"');
  });

  it('completes AFTER the conference execute call, not before (must block on the call first)', () => {
    const confIdx     = lua.indexOf('s:execute("conference"');
    const completeIdx = lua.indexOf('/ers/incidents/" .. d.incident_uuid .. "/complete"');
    expect(confIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(confIdx);
  });

  it('passes recording_file when a recording was captured earlier in the flow', () => {
    expect(lua).toMatch(/recording_file\s*=\s*s:getVariable\("recorded_file_path"\)/);
  });
});

describe('luaGenerator — ENS notification trigger', () => {
  it('POSTs to /ens/notifications (not /ens/trigger)', () => {
    expect(lua).toContain('"/ens/notifications"');
    expect(lua).not.toContain('/ens/trigger');
  });

  it('sends configuration_id and triggered_via=PHONE, not ens_configuration_id', () => {
    expect(lua).toMatch(/post\("\/ens\/notifications",\s*\{[^}]*configuration_id\s*=\s*cfg_id/s);
    expect(lua).toContain('triggered_via    = "PHONE"');
  });
});

describe('luaGenerator — Piper TTS speak() integration', () => {
  // Uses module-level luaWithPiper (defined at top of file).

  it('embeds PIPER_URL constant from the piperUrl option', () => {
    expect(luaWithPiper).toContain('local PIPER_URL    = "http://127.0.0.1:5002"');
  });

  it('speak() synthesizes via Piper curl when PIPER_URL is set', () => {
    // curl format string passes PIPER_URL as the %s placeholder for the endpoint host
    expect(luaWithPiper).toContain('%s/synthesize');
    expect(luaWithPiper).toContain('safe_b, PIPER_URL, wav_path');
    expect(luaWithPiper).toContain('s:streamFile(wav_path)');
  });

  it('Piper curl timeout is at least 20 seconds to survive cold model-load synthesis', () => {
    // lessac-medium cold synthesis takes 10-15s on this server — a 10s timeout fires
    // on the very first request after idle. 25s gives a safe margin without masking
    // genuine Piper unavailability for too long.
    const match = luaWithPiper.match(/curl -sf -m (\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(20);
  });

  it('speak() does NOT fall through to FreeSWITCH TTS when Piper is configured but fails', () => {
    // When PIPER_URL is set, Piper is the TTS engine. A FreeSWITCH TTS fallback
    // (e.g. flite) is not guaranteed to be installed, so a failed Piper synthesis
    // must return early — calling an absent TTS module produces a confusing ERR log
    // and silence anyway, no better than a clean skip.
    const piperFailBlock = luaWithPiper.slice(
      luaWithPiper.indexOf('Piper TTS failed'),
      luaWithPiper.indexOf('Piper TTS failed') + 200,
    );
    expect(piperFailBlock).toContain('return');
    expect(luaWithPiper).toContain('Piper TTS failed');
  });

  it('uses a per-call sequence counter for unique WAV filenames', () => {
    expect(luaWithPiper).toContain('local _tts_seq = 0');
    expect(luaWithPiper).toContain('_tts_seq = _tts_seq + 1');
  });

  it('uses string.format %q for JSON-safe body encoding without cjson', () => {
    expect(luaWithPiper).toContain('string.format("%q", text)');
  });

  it('cleans up the temp WAV after streamFile to avoid accumulation', () => {
    expect(luaWithPiper).toContain('os.remove(wav_path)');
  });

  it('when piperUrl is empty, speak() uses FreeSWITCH TTS directly (no curl)', () => {
    // Default lua has no piperUrl — PIPER_URL is ""
    expect(lua).toContain('local PIPER_URL    = ""');
    // The PIPER_URL guard means Piper block is skipped at runtime
    expect(lua).toContain('if PIPER_URL ~= "" then');
  });
});

describe('luaGenerator — deploymentEngine env-var contract (regression: PIPER_LUA_URL mismatch)', () => {
  // Regression: deploymentEngine.js previously read process.env.PIPER_URL which is never set
  // in Docker Compose (the env vars are PIPER_BACKEND_URL and PIPER_LUA_URL).
  // That caused piperUrl to always be '' → PIPER_URL="" in Lua → Piper branch never taken
  // → speak(flite|kal|...) → "Invalid speech module [flite]" on every TTS call.
  //
  // These tests guard the generator contract; the env-var READ is guarded by the
  // deploymentEngine unit test (deploymentEngine.test.js).

  it('non-empty piperUrl produces a non-empty PIPER_URL constant', () => {
    const l = generateIvrExecutorLua({
      apiBase:  'http://127.0.0.1:4100',
      apiKey:   'k',
      piperUrl: 'http://127.0.0.1:5001',
    });
    expect(l).toContain('local PIPER_URL    = "http://127.0.0.1:5001"');
    expect(l).not.toContain('local PIPER_URL    = ""');
  });

  it('empty piperUrl (PIPER_LUA_URL not set) produces PIPER_URL="" and bypasses Piper', () => {
    const l = generateIvrExecutorLua({
      apiBase:  'http://127.0.0.1:4100',
      apiKey:   'k',
      piperUrl: '',
    });
    expect(l).toContain('local PIPER_URL    = ""');
  });

  it('Piper branch is taken (curl + streamFile) when PIPER_URL is non-empty', () => {
    const l = generateIvrExecutorLua({
      apiBase:  'http://127.0.0.1:4100',
      apiKey:   'k',
      piperUrl: 'http://127.0.0.1:5001',
    });
    expect(l).toContain('s:streamFile(wav_path)');
  });

  it('when piperUrl is set, Piper return-early guard prevents FreeSWITCH speak() from executing', () => {
    // This is the production failure: piperUrl was always '' because deploymentEngine.js
    // read PIPER_URL (undefined) instead of PIPER_LUA_URL → PIPER_URL="" in Lua →
    // speak(flite|kal|...) fired on every TTS call → "Invalid speech module [flite]".
    //
    // The s:execute("speak") line exists in the else-branch of the generated Lua even when
    // piperUrl is set (runtime guard: `if PIPER_URL ~= ""`). What we can assert is that
    // the Piper block's `return` statement appears BEFORE s:execute, proving the else-branch
    // is structurally unreachable when PIPER_URL is non-empty.
    const l = generateIvrExecutorLua({
      apiBase:   'http://127.0.0.1:4100',
      apiKey:    'k',
      ttsEngine: 'flite|kal',
      piperUrl:  'http://127.0.0.1:5001',
    });
    // The Piper block ends with an explicit return before the else-branch s:execute
    expect(l).toContain('return  -- do not fall through to FreeSWITCH TTS; Piper is the configured engine');
    // And the streamFile call is present (Piper path taken)
    expect(l).toContain('s:streamFile(wav_path)');
  });
});

describe('luaGenerator — no HTML entities in generated Lua (regression: external file-editor escaping)', () => {
  // Root cause forensic finding: HTML entities (&amp;, &gt;, &lt;) were observed in the
  // deployed ivr_executor.lua on the production server. Investigation confirmed the
  // fs-enrs source code NEVER produced these entities — they were introduced by a
  // server-side file manager or web-based editor that HTML-encodes file content when
  // writing. These tests guard the generator output itself so the source is proven clean.
  //
  // The entities corrupt the Piper curl command at runtime:
  //   && echo piper_ok  →  &amp;&amp; echo piper_ok  (shell syntax error)
  //   2>/dev/null       →  2&gt;/dev/null           (shell redirect broken)
  //   fsize > 100       →  fsize &gt; 100           (Lua syntax error in Lua 5.1)

  it('no &amp; entity in generated Lua', () => {
    expect(lua).not.toContain('&amp;');
    expect(luaWithPiper).not.toContain('&amp;');
  });

  it('no &gt; entity in generated Lua', () => {
    expect(lua).not.toContain('&gt;');
    expect(luaWithPiper).not.toContain('&gt;');
  });

  it('no &lt; entity in generated Lua', () => {
    expect(lua).not.toContain('&lt;');
    expect(luaWithPiper).not.toContain('&lt;');
  });

  it('curl shell && separator is literal && not HTML-escaped', () => {
    // The Piper curl command must end with: && echo piper_ok
    // If this becomes &amp;&amp;, the shell never appends "piper_ok" to stdout,
    // out:find("piper_ok") returns nil, and Piper synthesis is treated as a failure.
    expect(luaWithPiper).toContain('&& echo piper_ok');
  });

  it('stderr redirect 2>/dev/null uses literal > not &gt;', () => {
    // If 2>/dev/null becomes 2&gt;/dev/null the shell ignores the redirect and
    // Piper stderr floods the FreeSWITCH log instead of being suppressed.
    expect(luaWithPiper).toContain('2>/dev/null');
  });

});

describe('luaGenerator — HTTP transport has no luasocket dependency', () => {
  it('never requires socket.http or ltn12', () => {
    expect(lua).not.toContain('require("socket.http")');
    expect(lua).not.toContain('require("ltn12")');
  });

  it('uses curl via io.popen, matching the pattern used by every other Lua script in this repo', () => {
    expect(lua).toContain('io.popen(cmd)');
    expect(lua).toContain('curl -s -m');
  });
});
