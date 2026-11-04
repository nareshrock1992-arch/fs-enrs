/**
 * What a tenant-authored flow may reach: the shared dialplan and outbound HTTP.
 * No call is placed and no network is used; DNS and fetch are injected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateDialplanXml } from '../../utils/xmlGenerator.js';
import { validateGraph } from '../../utils/ivrGraphValidator.js';
import { performRestCall, checkOutboundUrl, isForbiddenAddress, credentialAllowsHost } from '../../controllers/internal/ivrRestController.js';

const dns = (...addresses) => async () => addresses.map((address) => ({ address }));
const noDns = async () => { throw new Error('ENOTFOUND'); };
const ok = () => vi.fn(async () => ({ status: 200, text: async () => '{"a":1}' }));

afterEach(() => {
  delete process.env.IVR_REST_BLOCK_PRIVATE;
  delete process.env.IVR_CRED_VENDOR_KEY;
  delete process.env.IVR_CRED_VENDOR_ALLOWED_HOSTS;
});

describe('dialplan: a bound number is a literal, never a pattern', () => {
  const xml = (number) => generateDialplanXml([{ number, flow_uuid: 'u', flow_name: 'f', version_number: 1 }], { nested: false });
  it.each([
    ['.*', '^\\.\\*$'], ['1.*', '^1\\.\\*$'], ['1000|2000', '^1000\\|2000$'], ['(1)', '^\\(1\\)$'], ['+966', '^\\+966$'], ['*97', '^\\*97$'],
  ])('%s', (number, expected) => {
    expect(xml(number)).toContain(`expression="${expected}"`);
  });
  it('ordinary numbers are unchanged', () => {
    expect(xml('1222')).toContain('expression="^1222$"');
  });
  it('a number cannot break out of the XML attribute', () => {
    expect(xml('1"><x')).not.toContain('"><x');
  });
});

describe('outbound URL rules', () => {
  it.each(['127.0.0.1', '127.8.8.8', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1'])('%s is refused', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '10.1.2.3', '192.168.1.10', '172.16.0.1', 'fd00::1'])('%s is allowed by default', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
  it('private ranges can be refused by configuration', () => {
    for (const ip of ['10.1.2.3', '192.168.1.10', '172.31.0.1', '100.64.0.1', 'fd00::1']) expect(isForbiddenAddress(ip, true), ip).toBe(true);
    expect(isForbiddenAddress('172.32.0.1', true)).toBe(false);
  });
  it.each([
    ['http://localhost:4100/api/v1/internal/x'], ['http://LOCALHOST/'], ['http://api.localhost/'], ['http://127.0.0.1:4100/'],
    ['http://[::1]:4100/'], ['http://169.254.169.254/latest/meta-data/'], ['file:///etc/passwd'], ['ftp://x/y'],
    ['http://2130706433/'], ['http://0x7f.0.0.1/'],
  ])('%s → blocked', async (url) => {
    expect(await checkOutboundUrl(url, noDns)).toBe('url_blocked');
  });
  it('a public name that resolves to a forbidden address is refused', async () => {
    expect(await checkOutboundUrl('https://evil.example.com/', dns('8.8.8.8', '127.0.0.1'))).toBe('url_blocked');
  });
  it('a normal host passes; an unresolvable one is left to fail as a network error', async () => {
    expect(await checkOutboundUrl('https://api.example.com/', dns('93.184.216.34'))).toBeNull();
    expect(await checkOutboundUrl('https://nope.invalid/', noDns)).toBeNull();
  });
  it('garbage is refused', async () => {
    expect(await checkOutboundUrl('not a url', noDns)).toBe('url_invalid');
  });
});

describe('secrets stay put', () => {
  it('a refused URL sends nothing and resolves no secret', async () => {
    process.env.IVR_CRED_VENDOR_KEY = 'SECRET';
    const fetchImpl = ok();
    const r = await performRestCall({ url: 'http://169.254.169.254/', credential_name: 'vendor', auth_type: 'api_key_header', auth_param_name: 'X-Key' }, fetchImpl, noDns);
    expect(r).toMatchObject({ ok: false, outcome: 'http_error', error: 'url_blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('a pinned credential goes only to its hosts', async () => {
    process.env.IVR_CRED_VENDOR_KEY = 'SECRET';
    process.env.IVR_CRED_VENDOR_ALLOWED_HOSTS = 'api.vendor.com, crm.local';
    const input = { credential_name: 'vendor', auth_type: 'api_key_header', auth_param_name: 'X-Key' };
    const fetchImpl = ok();
    const bad = await performRestCall({ ...input, url: 'https://attacker.example.com/' }, fetchImpl, dns('93.184.216.34'));
    expect(bad.error).toBe('credential_host_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
    const good = await performRestCall({ ...input, url: 'https://API.vendor.com/x' }, fetchImpl, dns('93.184.216.34'));
    expect(good.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][1].headers['X-Key']).toBe('SECRET');
  });
  it('an unpinned credential keeps working (backward compatible)', () => {
    expect(credentialAllowsHost('other', 'https://any.example.com/')).toBe(true);
  });
  it('redirects are not followed: a 302 is an http_error, not a second request', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 302, text: async () => '' }));
    const r = await performRestCall({ url: 'https://api.example.com/' }, fetchImpl, dns('93.184.216.34'));
    expect(r.outcome).toBe('http_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
});

describe('channel-variable expansion in flows', () => {
  const flow = (node) => ({ entry_node_id: 'a', nodes: { a: { type: 'transfer', destination: '1000', ...node } } });
  // A goodbye text is covered only by the expansion rule, so it isolates that rule's message.
  const goodbye = (goodbye_text) => ({ entry_node_id: 'a', nodes: { a: { type: 'hangup', goodbye_source_type: 'tts', goodbye_text } } });
  it.each(['${system id}', '${system(id)}', '${ system id}', '${bg_system curl x}', '${a${b}}'])('%s is refused', async (text) => {
    const r = await validateGraph(goodbye(text), 1);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toContain('only plain variables');
  });
  it.each(['${system id}', '${bg_system curl x}'])('%s as a transfer destination is refused', async (destination) => {
    const r = await validateGraph(flow({ destination }), 1);
    expect(r.valid).toBe(false);
  });
  it.each(['${caller_id_number}', '${destination_number}', '1000', 'user/1001'])('%s stays valid', async (destination) => {
    const r = await validateGraph(flow({ destination }), 1);
    expect(r.errors.join()).not.toContain('only plain variables');
  });
  it('nested fields are scanned too', async () => {
    const graph = { entry_node_id: 'a', nodes: { a: { type: 'hangup', anything: { deep: ['${system id}'] } } } };
    const r = await validateGraph(graph, 1);
    expect(JSON.stringify(r.errors)).toMatch(/only plain variables|anything/);
  });
  it('built-in templates contain no API expansion', async () => {
    const { BUILTIN_IVR_TEMPLATES } = await import('../../controllers/ivrTemplates.js');
    expect(JSON.stringify(BUILTIN_IVR_TEMPLATES)).not.toMatch(/\$\{\s*[\w.-]*[\s(]/);
  });
});
