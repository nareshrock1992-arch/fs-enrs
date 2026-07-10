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
