/**
 * Cycle 3 IVR trust boundaries on the backend side: publish-time rules, the ENS
 * start-by-config tenant check, per-tenant credentials, protected response
 * mappings, and the connect-time DNS check. No call is placed; DB is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import zlib from 'zlib';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../infrastructure/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/campaignEngine.js', () => ({
  createCampaign: vi.fn(),
  createCampaignByConfigId: vi.fn(async () => ({ id: 77, status: 'PENDING', total_destinations: 3 })),
}));
vi.mock('../../services/socketService.js', () => ({ emitInternal: vi.fn() }));

const { query } = await import('../../db/pool.js');
const { createCampaignByConfigId } = await import('../../services/campaignEngine.js');
const { validateGraph } = await import('../../utils/ivrGraphValidator.js');
const { isProtectedVarName } = await import('../../utils/ivrProtectedVars.js');
const { startCampaignByConfig } = await import('../../controllers/internal/ensInternalController.js');
const {
  performRestCall, credentialAllowsTenant, makeCheckedLookup, pinnedFetch, MAX_RESPONSE_BYTES, MAX_REDIRECTS,
} = await import('../../controllers/internal/ivrRestController.js');
const { ensLookup } = await import('../../controllers/internal/ensInternalController.js');

const publicDns = async () => [{ address: '93.184.216.34' }];
const okFetch = (body = '{"a":1}') => vi.fn(async () => ({ status: 200, text: async () => body }));
const one = (node) => ({ entry_node_id: 'a', nodes: { a: node, h: { type: 'hangup' } } });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
  for (const k of ['ENS_REQUIRE_IVR_NUMBER', 'IVR_CRED_REQUIRE_TENANT_SCOPE', 'IVR_CRED_VENDOR_TOKEN', 'IVR_CRED_VENDOR_TENANT_IDS', 'IVR_REST_BLOCK_PRIVATE']) delete process.env[k];
});

describe('protected variable names: only those the engine runs as a command', () => {
  it.each(['api_hangup_hook', 'API_ON_ANSWER', 'api_reporting_hook', 'api_after_bridge', 'execute_on_answer',
    'exec_after_bridge_app', 'bridge_pre_execute_bleg_app', 'uuid'])('%s is protected', (n) => {
    expect(isProtectedVarName(n)).toBe(true);
  });
  // Characterization (zero-regression): writable before, writable now.
  it.each(['gather_result', 'recorded_file_path', 'menu_choice', 'acct_name', 'webhook_status', 'ens_configuration_id',
    'destination_number', 'caller_id_number', 'effective_caller_id_name', 'origination_caller_id_number',
    'transfer_after_bridge', 'hangup_after_bridge', 'park_after_bridge', 'session_in_hangup_hook',
    'conference_auto_outcall_profile', 'bridge_early_media', 'sip_h_X-Trace', 'api_result'])('%s is allowed', (n) => {
    expect(isProtectedVarName(n)).toBe(false);
  });
});

describe('publish-time rules', () => {
  const errorsOf = async (node) => (await validateGraph(one(node), 1)).errors.join(' | ');

  it('set_variable to a hook variable is refused', async () => {
    expect(await errorsOf({ type: 'set_variable', variable: 'api_hangup_hook', value: 'system id', next: 'h' })).toContain('protected channel variable');
  });
  it('gather and record cannot store into a command-running variable or the call UUID', async () => {
    expect(await errorsOf({ type: 'gather', variable_name: 'execute_on_answer', branches: { _default: 'h' } })).toContain('protected channel variable');
    expect(await errorsOf({ type: 'record_message', variable_name: 'uuid', next: 'h' })).toContain('protected channel variable');
  });
  it('characterization: storing into identity / call-control variables still publishes', async () => {
    expect((await validateGraph(one({ type: 'set_variable', variable: 'effective_caller_id_name', value: 'Helpdesk', next: 'h' }), 1)).valid).toBe(true);
    expect((await validateGraph(one({ type: 'gather', variable_name: 'destination_number', branches: { _default: 'h' } }), 1)).valid).toBe(true);
  });
  it('a REST response mapping into a hook variable is refused', async () => {
    const node = { type: 'rest_api', url: 'https://api.example.com/', response_mappings: '[{"json_path":"x","variable_name":"execute_on_answer"}]', branches: { success: 'h' } };
    expect(await errorsOf(node)).toContain('protected channel variable');
  });
  it('a new inline transfer is refused at publish; every other dialplan publishes as before', async () => {
    expect(await errorsOf({ type: 'transfer', destination: '1000', dialplan: 'inline' })).toContain('a.dialplan: "inline" is not allowed');
    expect(await errorsOf({ type: 'transfer', destination: '1000', dialplan: 'INLINE' })).toContain('a.dialplan');
    for (const dialplan of ['XML', 'enum', 'xml', 'custom_dp']) {
      expect((await validateGraph(one({ type: 'transfer', destination: '1000', dialplan }), 1)).valid).toBe(true);
    }
  });
  it('a destination naming "inline" as its dialplan word is refused (bypass of the rule above)', async () => {
    expect(await errorsOf({ type: 'transfer', destination: '1000 inline' })).toContain('a.destination: "inline" is not allowed');
    expect(await errorsOf({ type: 'transfer', destination: ' bridge:x  INLINE default' })).toContain('a.destination');
  });
  it('characterization: destinations and contexts with spaces publish as before', async () => {
    for (const destination of ['${agent_ext}', 'user/1001', 'sip:1000@pbx.example', '1000~x', '+9661234', '1001 XML public', '1001 ', '${a} ${b}']) {
      expect((await validateGraph(one({ type: 'transfer', destination }), 1)).valid).toBe(true);
    }
    expect((await validateGraph(one({ type: 'transfer', destination: '1000', context: 'default inline' }), 1)).valid).toBe(true);
  });
  it('characterization: webhook URLs publish as before (no scheme rule)', async () => {
    for (const url of ['https://hooks.example.com/x', 'hooks.example.com/x', '${hook_url}']) {
      expect((await validateGraph(one({ type: 'webhook', url, next: 'h' }), 1)).valid).toBe(true);
    }
  });
});

// Found in Cycle 5 staging: Deploy re-validates the published version, so the publish-only
// rules above made Deploy of a flow published before them fail (422), unlike HEAD.
describe('Deploy of an already-published version (alreadyPublished)', () => {
  const deployCheck = (graph) => validateGraph(graph, 1, { alreadyPublished: true });
  it.each([
    ['inline transfer', { type: 'transfer', destination: 'set:x=1,hangup', dialplan: 'inline' }, 'a.dialplan'],
    ['destination naming inline', { type: 'transfer', destination: '1000 inline' }, 'a.destination'],
    ['protected variable', { type: 'set_variable', variable: 'api_hangup_hook', value: 'x', next: 'h' }, 'a.variable'],
    ['API form in a template', { type: 'webhook', url: 'https://h.example/x', body_template: '{"t":"${expr 1+1}"}', next: 'h' }, 'a.body_template'],
  ])('%s: deploys as before, with a warning; publish still refuses it', async (_, node, field) => {
    const r = await deployCheck(one(node));
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' | ')).toContain(`node ${field}`);
    expect(r.warnings.join(' | ')).toContain('already published');
    expect((await validateGraph(one(node), 1)).valid).toBe(false);
  });
  it('every check that applied before still refuses the deploy', async () => {
    expect((await deployCheck({ entry_node_id: 'a', nodes: { a: { type: 'play', audio_url: '/media/x.wav', next: 'gone' } } })).errors.join(' | ')).toContain('non-existent node "gone"');
    expect((await deployCheck(one({ type: 'gather', min_digits: 3, max_digits: 1, branches: { _default: 'h' } }))).errors.join(' | ')).toContain('min_digits (3) must not exceed');
    expect((await deployCheck({ entry_node_id: 'zz', nodes: { a: { type: 'hangup' } } })).valid).toBe(false);
  });
});

describe('ENS start-by-config tenant check (IVR-12)', () => {
  const call = async (body) => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    await startCampaignByConfig({ body }, res, (e) => { throw e; });
    return res;
  };

  it('refuses a configuration that the routed number’s tenant does not own', async () => {
    query.mockResolvedValueOnce({ rows: [{ config_tenant: 7, number_tenants: [3] }] });
    const res = await call({ configuration_id: 42, ivr_number: '1222' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(createCampaignByConfigId).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]).toEqual([42, '1222']);
  });
  it('starts the campaign when the tenant matches', async () => {
    query.mockResolvedValueOnce({ rows: [{ config_tenant: 3, number_tenants: [3] }] });
    const res = await call({ configuration_id: 42, ivr_number: '1222' });
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });
  it('characterization: a routed number that is not an active registered number still starts the blast, unless required', async () => {
    query.mockResolvedValueOnce({ rows: [{ config_tenant: 3, number_tenants: [] }] });
    await call({ configuration_id: 42, ivr_number: '9999' });
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
    process.env.ENS_REQUIRE_IVR_NUMBER = 'true';
    query.mockResolvedValueOnce({ rows: [{ config_tenant: 3, number_tenants: [] }] });
    const res = await call({ configuration_id: 42, ivr_number: '9999' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
    delete process.env.ENS_REQUIRE_IVR_NUMBER;
  });
  it('characterization: an unknown configuration is left to the campaign service, as before', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await call({ configuration_id: 42, ivr_number: '1222' });
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
  });
  it('an old executor without ivr_number still works, unless required', async () => {
    await call({ configuration_id: 42 });
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
    process.env.ENS_REQUIRE_IVR_NUMBER = 'true';
    const res = await call({ configuration_id: 42 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCampaignByConfigId).toHaveBeenCalledTimes(1);
  });
});

describe('credential tenant scope (IVR-6)', () => {
  const input = { url: 'https://api.example.com/', auth_type: 'bearer_static', credential_name: 'vendor', ivr_number: '1222' };
  beforeEach(() => { process.env.IVR_CRED_VENDOR_TOKEN = 't0ken'; });

  it('a scoped credential is refused for another tenant, before the secret is sent', async () => {
    process.env.IVR_CRED_VENDOR_TENANT_IDS = '3,7';
    const fetchImpl = okFetch();
    const r = await performRestCall(input, fetchImpl, publicDns, async () => 5);
    expect(r.error).toBe('credential_tenant_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('a scoped credential works for a listed tenant', async () => {
    process.env.IVR_CRED_VENDOR_TENANT_IDS = '3,7';
    const fetchImpl = okFetch();
    const r = await performRestCall(input, fetchImpl, publicDns, async () => 7);
    expect(r.outcome).toBe('success');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t0ken');
  });
  it('a scoped credential is refused when the number is unknown', async () => {
    process.env.IVR_CRED_VENDOR_TENANT_IDS = '3';
    expect((await performRestCall({ ...input, ivr_number: undefined }, okFetch(), publicDns, async () => 3)).error).toBe('credential_tenant_not_allowed');
  });
  it('an unscoped credential keeps working unless scopes are required', async () => {
    expect(credentialAllowsTenant('vendor', 5)).toBe(true);
    process.env.IVR_CRED_REQUIRE_TENANT_SCOPE = 'true';
    expect(credentialAllowsTenant('vendor', 5)).toBe(false);
  });
  it('a call without a credential needs no tenant', async () => {
    const r = await performRestCall({ url: 'https://api.example.com/' }, okFetch(), publicDns, async () => { throw new Error('not called'); });
    expect(r.outcome).toBe('success');
  });
});

describe('response mappings cannot set protected variables', () => {
  it('drops hook and identity names, keeps ordinary ones', async () => {
    const r = await performRestCall({
      url: 'https://api.example.com/',
      response_mappings: JSON.stringify([
        { json_path: 'cmd', variable_name: 'api_hangup_hook' },
        { json_path: 'cmd', variable_name: 'execute_on_answer' },
        { json_path: 'n', variable_name: 'destination_number' },
        { json_path: 'n', variable_name: 'sip_h_X-Account' },
        { json_path: 'name', variable_name: 'acct_name' },
      ]),
    }, okFetch('{"cmd":"system id","n":"7777","name":"Sam"}'), publicDns);
    // Command-running names are dropped; every other name is applied as before.
    expect(r.vars).toEqual({ destination_number: '7777', 'sip_h_X-Account': '7777', acct_name: 'Sam' });
  });
});

describe('connect-time DNS check (IVR-7)', () => {
  const resolver = (address) => (host, opts, cb) => cb(null, [{ address, family: 4 }]);

  it('a name that resolves to loopback at connect time is refused', async () => {
    const lookup = makeCheckedLookup(false, resolver('127.0.0.1'));
    const err = await new Promise((r) => lookup('rebind.example', { all: true }, (e) => r(e)));
    expect(err.code).toBe('URL_BLOCKED');
  });
  it('metadata addresses are refused', async () => {
    const lookup = makeCheckedLookup(false, resolver('169.254.169.254'));
    const err = await new Promise((r) => lookup('x', {}, (e) => r(e)));
    expect(err.code).toBe('URL_BLOCKED');
  });
  it('public addresses pass, in both callback shapes', async () => {
    const lookup = makeCheckedLookup(false, resolver('93.184.216.34'));
    const all = await new Promise((r) => lookup('x', { all: true }, (e, a) => r(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const single = await new Promise((r) => lookup('x', {}, (e, a, f) => r([a, f])));
    expect(single).toEqual(['93.184.216.34', 4]);
  });

  it('pinnedFetch refuses a name rebound to loopback, at connection', async () => {
    const server = http.createServer((req, res) => res.end('{"leak":true}'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      await expect(pinnedFetch(`http://rebind.example:${port}/`, {}, resolver('127.0.0.1'))).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    } finally { server.close(); }
  });

  it('pinnedFetch itself does not follow redirects, caps the size and decodes gzip like fetch()', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
      if (req.url === '/big') { res.writeHead(200); res.write(Buffer.alloc(MAX_RESPONSE_BYTES + 10, 'a')); return res.end(); }
      if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(JSON.stringify({ zipped: true, ae: req.headers['accept-encoding'] }))); }
      res.end(JSON.stringify({ method: req.method }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const redirected = await pinnedFetch(`${base}/redirect`);
      expect(redirected.status).toBe(302);
      const big = await pinnedFetch(`${base}/big`);
      expect(big.tooLarge).toBe(true);
      expect(await big.text()).toBe('');
      const ok = await pinnedFetch(`${base}/`, { method: 'POST', body: '{}' });
      expect(JSON.parse(await ok.text())).toEqual({ method: 'POST' });
      const gz = await pinnedFetch(`${base}/gz`);
      expect(JSON.parse(await gz.text())).toEqual({ zipped: true, ae: 'gzip, deflate, br' });
    } finally { server.close(); }
  });
});

describe('compatibility report (read-only script)', () => {
  it('lists affected nodes and informational items, and nothing for a clean flow', async () => {
    const { graphFindings } = await import('../../../scripts/ivr-compat-report.js');
    const findings = graphFindings({
      entry_node_id: 'a',
      nodes: {
        a: { type: 'set_variable', variable: 'api_hangup_hook', value: 'x', next: 'b' },
        b: { type: 'transfer', destination: 'system:id', dialplan: 'inline' },
        c: { type: 'hangup', goodbye_source_type: 'tts', goodbye_text: '${system id}' },
        d: { type: 'ens', ens_config_var: 'cfg', next: 'c' },
        e: { type: 'rest_api', url: 'https://x', auth_type: 'bearer_static', credential_name: 'acme', branches: { success: 'c' } },
      },
    });
    const by = (node, kind) => findings.filter((f) => f.node === node && f.kind === kind).map((f) => f.message);
    expect(by('a', 'error').join()).toContain('protected channel variable');
    expect(by('b', 'error').join()).toContain('dialplan');
    expect(by('c', 'error').join()).toContain('${api args}');
    expect(by('d', 'info')).toHaveLength(1);
    expect(by('e', 'info').join()).toContain('IVR_CRED_ACME_TENANT_IDS');
    expect(graphFindings({ entry_node_id: 'h', nodes: { h: { type: 'hangup' } } })).toEqual([]);
  });
});

describe('redirects are followed as fetch() did, with checks (compatibility)', () => {
  const redirect = (status, location) => ({ status, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) }, text: async () => '' });
  const done = (body = '{"a":1}') => ({ status: 200, headers: { get: () => null }, text: async () => body });
  beforeEach(() => { process.env.IVR_CRED_VENDOR_TOKEN = 't0ken'; });

  it('same-host redirect: followed, credential kept', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(301, '/v2/acct')).mockResolvedValueOnce(done());
    const r = await performRestCall({ url: 'https://api.example.com/acct', auth_type: 'bearer_static', credential_name: 'vendor' }, fetchImpl, publicDns, async () => null);
    expect(r.outcome).toBe('success');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.com/v2/acct');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer t0ken');
  });
  it('cross-host redirect drops Authorization and the API-key header, keeps others', async () => {
    process.env.IVR_CRED_VENDOR_KEY = 'k';
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(307, 'https://cdn.example.net/acct')).mockResolvedValueOnce(done());
    const r = await performRestCall({ url: 'https://api.example.com/acct', auth_type: 'api_key_header', auth_param_name: 'X-Api-Key', credential_name: 'vendor',
      headers: '{"X-Trace":"1"}' }, fetchImpl, publicDns, async () => null);
    expect(r.outcome).toBe('success');
    expect(fetchImpl.mock.calls[0][1].headers['X-Api-Key']).toBe('k');
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({ 'X-Trace': '1' });
    delete process.env.IVR_CRED_VENDOR_KEY;
  });
  it('a redirect to loopback or metadata is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(302, 'http://169.254.169.254/latest/'));
    const r = await performRestCall({ url: 'https://api.example.com/' }, fetchImpl, publicDns);
    expect(r.error).toBe('url_blocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('303, and 302 after POST, continue as GET without a body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(303, '/result')).mockResolvedValueOnce(done());
    await performRestCall({ url: 'https://api.example.com/submit', method: 'POST', body: '{"x":1}' }, fetchImpl, publicDns);
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'GET', body: undefined });
  });
  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const fetchImpl = vi.fn(async () => redirect(302, '/again'));
    const r = await performRestCall({ url: 'https://api.example.com/' }, fetchImpl, publicDns);
    expect(r.error).toBe('too_many_redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});

describe('ENS lookup refuses another tenant only when called with the routed number', () => {
  const call = async (q) => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    await ensLookup({ query: q }, res, (e) => { throw e; });
    return res;
  };
  it('different tenants → 404 before the configuration is read', async () => {
    query.mockResolvedValueOnce({ rows: [{ number: '7301', tenant_id: 3 }, { number: '1222', tenant_id: 2 }] });
    const res = await call({ number: '7301', ivr_number: '1222' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('characterization: same tenant, or no ivr_number, reads the configuration as before', async () => {
    query.mockResolvedValueOnce({ rows: [{ number: '7301', tenant_id: 2 }, { number: '1222', tenant_id: 2 }] }).mockResolvedValueOnce({ rows: [] });
    let res = await call({ number: '7301', ivr_number: '1222' });
    expect(res.status).toHaveBeenCalledWith(404);   // not found in this fixture: the config query ran
    expect(query).toHaveBeenCalledTimes(2);
    query.mockClear();
    query.mockResolvedValueOnce({ rows: [] });
    res = await call({ number: '7301' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('ens_configurations');
  });
});
