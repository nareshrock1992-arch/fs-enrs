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

  it('generates conference_room client-side and checks incident_uuid in the response, never conference_room', () => {
    expect(lua).toContain('local room = "ers_"');
    expect(lua).toContain('d.incident_uuid');
    expect(lua).not.toContain('d.conference_room');
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
