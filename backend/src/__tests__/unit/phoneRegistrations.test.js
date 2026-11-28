// Phone registrations page (2026-11-25): parsing of real lab FreeSWITCH output, MAC rules,
// duplicate detection, tenant scoping and error handling. No FreeSWITCH, no database.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/eslService.js', () => ({ eslCommand: vi.fn() }));
vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));

const svc = await import('../../services/registrationService.js');
const { makeListRegistrations, tenantExtensions, tenantGatewayNames } = await import('../../controllers/registrationController.js');

// Shapes copied from the lab (Ubuntu-FS, FreeSWITCH 1.10.12), call-ids removed.
const PROFILES = `<?xml version="1.0" encoding="ISO-8859-1"?>
<profiles>
<profile><name>external</name><type>profile</type><data>sip:mod_sofia@192.168.1.124:5080</data><state>RUNNING (0)</state></profile>
<gateway><name>example.com</name><type>gateway</type><data>sip:joeuser@example.com</data><state>NOREG</state></gateway>
<alias><name>192.168.1.124</name><type>alias</type><data>internal</data><state>ALIASED</state></alias>
<profile><name>internal</name><type>profile</type><data>sip:mod_sofia@192.168.1.124:5060</data><state>RUNNING (0)</state></profile>
<profile><name>internal</name><type>profile</type><data>sips:mod_sofia@192.168.1.124:7443;transport=wss</data><state>RUNNING (0) (WSS)</state></profile>
<profile><name>bad;reloadxml</name><type>profile</type><data>x</data><state>RUNNING</state></profile>
</profiles>`;

const reg = ({ ext, agent, contact, status, ip, port, ping = 'Reachable', time = '0.00' }) => `
    <registration>
        <call-id>secret-call-id</call-id>
        <user>${ext}@192.168.1.124</user>
        <contact>${contact}</contact>
        <agent>${agent}</agent>
        <status>${status}</status>
        <ping-status>${ping}</ping-status>
        <ping-time>${time}</ping-time>
        <host>DESKTOP-K0KH8PB</host>
        <network-ip>${ip}</network-ip>
        <network-port>${port}</network-port>
        <sip-auth-user>${ext}</sip-auth-user>
        <sip-auth-realm>192.168.1.124</sip-auth-realm>
    </registration>`;

const MICROSIP = reg({ ext: '1002', agent: 'MicroSIP/3.21.6', contact: '&quot;1002&quot; &lt;sip:1002@192.168.1.123:56893;ob&gt;',
  status: 'Registered(UDP)(unknown) exp(2026-11-25 06:36:09) expsecs(160)', ip: '192.168.1.123', port: '56893' });
const BROWSER = reg({ ext: '1003', agent: 'FS-WebRTC/0.1 (SIP.js 0.21.2)',
  contact: '&quot;&quot; &lt;sip:trgg95jq@2bp4stpbfhq4.invalid;transport=ws;fs_nat=yes;fs_path=sip%3Atrgg95jq%40192.168.1.124%3A44486%3Btransport%3Dwss&gt;',
  status: 'Registered(WSS-NAT)(unknown) exp(2026-11-25 06:37:54) expsecs(265)', ip: '192.168.1.124', port: '44486' });
const YEALINK = reg({ ext: '2001', agent: 'Yealink SIP-T46U 108.86.0.20',
  contact: '&lt;sip:2001@192.168.1.40:5060&gt;;+sip.instance=&quot;&lt;urn:uuid:00000000-0000-1000-8000-805EC01234AB&gt;&quot;',
  status: 'Registered(UDP-NAT)(unknown) exp(2026-11-25 06:40:00) expsecs(240)', ip: '192.168.1.40', port: '5060', time: '240.40' });
const gw = (name, state, status, extra = '') => `<gateway><name>${name}</name><profile>external</profile><scheme>Digest</scheme>
  <realm>${name}</realm><username>trunkuser</username><password>TOPSECRET</password><proxy>sip:${name}</proxy>
  <pingfreq>30</pingfreq><pingtime>12.6</pingtime><state>${state}</state><status>${status}</status>
  <uptime-usec>397954135244</uptime-usec><calls-in>3</calls-in><calls-out>5</calls-out><failed-calls-in>0</failed-calls-in><failed-calls-out>1</failed-calls-out>${extra}</gateway>`;
const GATEWAYS = `<gateways>${gw('tenant-trunk', 'REGED', 'UP')}${gw('avaya', 'FAIL_WAIT', 'UP')}${gw('carrier', 'NOREG', 'DOWN')}</gateways>`;
const internalXml = `<profile><registrations>${MICROSIP}${BROWSER}${YEALINK}</registrations></profile>`;

describe('parsing FreeSWITCH output', () => {
  it('profiles: unique, profiles only (no gateways/aliases), unsafe names dropped', () => {
    expect(svc.parseProfiles(PROFILES)).toEqual(['external', 'internal']);
  });

  it('registrations: extension, device, address, connection, health; never the call-id', () => {
    const rows = svc.parseRegistrations(internalXml, 'internal');
    expect(rows[0]).toEqual({
      profile: 'internal', extension: '1002', realm: '192.168.1.124', device: 'MicroSIP/3.21.6',
      ip: '192.168.1.123', port: 56893, transport: 'UDP', nat: false, expiresIn: 160,
      reachable: true, pingMs: 0, mac: null, browserPhone: false,
      contact: '"1002" <sip:1002@192.168.1.123:56893;ob>',
    });
    expect(rows[1]).toMatchObject({ extension: '1003', transport: 'WSS', nat: true, browserPhone: true, expiresIn: 265 });
    expect(rows[2]).toMatchObject({ extension: '2001', transport: 'UDP', nat: true, pingMs: 240, mac: '80:5E:C0:12:34:AB' });
    expect(JSON.stringify(rows)).not.toContain('secret-call-id');
  });

  it('a phone that does not answer checks', () => {
    const [r] = svc.parseRegistrations(reg({ ext: '1009', agent: 'X', contact: '', status: 'Registered(TCP)(unknown) expsecs(30)',
      ip: '10.0.0.9', port: '5060', ping: 'Unreachable' }), 'internal');
    expect(r).toMatchObject({ reachable: false, transport: 'TCP' });
  });

  it('empty profile → no rows', () => {
    expect(svc.parseRegistrations('<profile><registrations></registrations></profile>', 'external')).toEqual([]);
  });
});

describe('MAC address — only when the phone reports it', () => {
  it.each([
    ['instance id (Yealink, Polycom…)', '', '<sip:1@h>;+sip.instance="<urn:uuid:00000000-0000-1000-8000-0004f2a1b2c3>"', '00:04:F2:A1:B2:C3'],
    ['colon form in device name', 'Phone 1.0 80:5e:c0:12:34:ab', '', '80:5E:C0:12:34:AB'],
    ['dash form in device name', 'Phone 80-5E-C0-12-34-AB', '', '80:5E:C0:12:34:AB'],
    ['bare token in brackets (Cisco SPA)', 'Cisco/SPA504G-7.6.2 (0018b9a1b2c3)', '', '00:18:B9:A1:B2:C3'],
  ])('%s', (_name, agent, contact, mac) => {
    expect(svc.extractMac(agent, contact)).toBe(mac);
  });

  it.each([
    ['softphone', 'MicroSIP/3.21.6', ''],
    ['12-digit firmware number', 'Phone 108860020000', ''],
    ['random (non-MAC) instance id', '', '+sip.instance="<urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301>"'],
    ['browser phone', 'FS-WebRTC/0.1 (SIP.js 0.21.2)', '<sip:trgg95jq@2bp4stpbfhq4.invalid;transport=ws>'],
  ])('%s → null', (_name, agent, contact) => {
    expect(svc.extractMac(agent, contact)).toBeNull();
  });
});

describe('SIP trunks (gateways)', () => {
  it('safe fields only — never the username or password', () => {
    const g = svc.parseGateways(GATEWAYS);
    expect(g.map((x) => x.name)).toEqual(['avaya', 'carrier', 'tenant-trunk']);
    expect(g[2]).toEqual({ name: 'tenant-trunk', profile: 'external', proxy: 'sip:tenant-trunk', realm: 'tenant-trunk',
      registration: 'REGED', status: 'UP', pingMs: 13, uptimeSeconds: 397954, callsIn: 3, callsOut: 5, failedIn: 0, failedOut: 1 });
    const all = JSON.stringify(g);
    expect(all).not.toContain('TOPSECRET');
    expect(all).not.toContain('trunkuser');
  });

  it('problems: down, or registration failing; NOREG alone is fine (trunk that does not register)', () => {
    const [avaya, carrier, ok] = svc.parseGateways(GATEWAYS);
    expect(svc.gatewayProblem(avaya)).toBe('not registered');
    expect(svc.gatewayProblem(carrier)).toBe('down');
    expect(svc.gatewayProblem(ok)).toBeNull();
    expect(svc.gatewayProblem({ status: 'UP', registration: 'NOREG' })).toBeNull();
  });

  it('lab sample (ping off) → no ping time', () => {
    const [g] = svc.parseGateways('<gateways><gateway><name>example.com</name><pingfreq>0</pingfreq><pingtime>0.00</pingtime><state>NOREG</state><status>UP</status></gateway></gateways>');
    expect(g).toMatchObject({ name: 'example.com', pingMs: null, registration: 'NOREG', status: 'UP' });
  });
});

describe('summary', () => {
  it('counts and flags the same extension signed in twice (lab 2026-11-24: 1003 on two devices)', () => {
    const rows = [
      ...svc.parseRegistrations(internalXml, 'internal'),
      { ...svc.parseRegistrations(MICROSIP, 'internal')[0], extension: '1003', ip: '192.168.1.58' },
      { ...svc.parseRegistrations(YEALINK, 'internal')[0], reachable: false },
    ];
    const { summary, registrations } = svc.summarise(rows);
    expect(summary).toEqual({ registered: 5, notReachable: 1, browserPhones: 1, duplicateExtensions: 2 });
    expect(registrations.map((r) => r.extension)).toEqual(['1002', '1003', '1003', '2001', '2001']);
    expect(registrations.filter((r) => r.duplicate).map((r) => r.extension)).toEqual(['1003', '1003', '2001', '2001']);
  });
});

describe('fetchRegistrations', () => {
  it('asks each safe profile once; never puts an unsafe name in a command', async () => {
    const cmd = vi.fn(async (c) => (c === 'sofia xmlstatus' ? PROFILES : c.includes('internal') ? internalXml : '<profile/>'));
    const rows = await svc.fetchRegistrations(cmd);
    expect(cmd.mock.calls.map(([c]) => c)).toEqual([
      'sofia xmlstatus', 'sofia xmlstatus profile external reg', 'sofia xmlstatus profile internal reg',
    ]);
    expect(rows).toHaveLength(3);
  });
});

function res() {
  const r = { statusCode: 200, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
const call = async (handler, user, q = {}) => {
  const r = res(); const next = vi.fn();
  await handler({ user, query: q, body: {} }, r, next);
  return { r, next };
};
const ROWS = () => svc.parseRegistrations(internalXml, 'internal');

describe('GET /api/v1/phone-registrations', () => {
  it('SUPER_ADMIN sees every phone', async () => {
    const h = makeListRegistrations({ fetchTrunks: async () => svc.parseGateways(GATEWAYS), gatewaysFor: async () => new Set(["tenant-trunk"]), fetch: async () => ROWS(), extensionsFor: vi.fn() });
    const { r } = await call(h, { role: 'SUPER_ADMIN' });
    expect(r.statusCode).toBe(200);
    expect(r.body.scope).toBe('all');
    expect(r.body.registrations.map((x) => x.extension)).toEqual(['1002', '1003', '2001']);
    expect(r.body.gateways.map((g) => [g.name, g.problem])).toEqual([['avaya', 'not registered'], ['carrier', 'down'], ['tenant-trunk', null]]);
    expect(r.body.summary).toMatchObject({ trunks: 3, trunksWithProblems: 2 });
    expect(JSON.stringify(r.body)).not.toContain('TOPSECRET');
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  it('tenant ADMIN sees only extensions of their own contacts/departments', async () => {
    const extensionsFor = vi.fn(async () => new Set(['1003', '2001']));
    const h = makeListRegistrations({ fetchTrunks: async () => svc.parseGateways(GATEWAYS), gatewaysFor: async () => new Set(["tenant-trunk"]), fetch: async () => ROWS(), extensionsFor });
    const { r } = await call(h, { role: 'ADMIN', tenantId: 7 });
    expect(extensionsFor).toHaveBeenCalledWith(7);
    expect(r.body.scope).toBe('tenant');
    expect(r.body.registrations.map((x) => x.extension)).toEqual(['1003', '2001']);
    expect(r.body.summary.registered).toBe(2);
    expect(r.body.gateways.map((g) => g.name)).toEqual(['tenant-trunk']);      // other tenants' trunks hidden
    expect(r.body.summary.trunks).toBe(1);
  });

  it('tenant ADMIN cannot widen the scope with ?tenant_id=', async () => {
    const extensionsFor = vi.fn(async () => new Set());
    const h = makeListRegistrations({ fetchTrunks: async () => svc.parseGateways(GATEWAYS), gatewaysFor: async () => new Set(["tenant-trunk"]), fetch: async () => ROWS(), extensionsFor });
    await call(h, { role: 'ADMIN', tenantId: 7 }, { tenant_id: '9' });
    expect(extensionsFor).toHaveBeenCalledWith(7);
  });

  it('SUPER_ADMIN in one tenant\'s context sees that tenant only', async () => {
    const extensionsFor = vi.fn(async () => new Set(['1002']));
    const h = makeListRegistrations({ fetchTrunks: async () => svc.parseGateways(GATEWAYS), gatewaysFor: async () => new Set(["tenant-trunk"]), fetch: async () => ROWS(), extensionsFor });
    const { r } = await call(h, { role: 'SUPER_ADMIN' }, { tenant_id: '3' });
    expect(extensionsFor).toHaveBeenCalledWith(3);
    expect(r.body.registrations.map((x) => x.extension)).toEqual(['1002']);
  });

  it('admin without a tenant → 403 (never "all phones")', async () => {
    const fetch = vi.fn(async () => ROWS());
    const h = makeListRegistrations({ fetch, extensionsFor: vi.fn() });
    const { next } = await call(h, { role: 'ADMIN' });
    expect(next.mock.calls[0][0].status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('phone system unreachable → 503 with a plain message', async () => {
    const h = makeListRegistrations({ fetchTrunks: async () => svc.parseGateways(GATEWAYS), gatewaysFor: async () => new Set(["tenant-trunk"]), fetch: async () => { throw new Error('ESL not connected'); }, extensionsFor: vi.fn() });
    const { r } = await call(h, { role: 'SUPER_ADMIN' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: expect.stringMatching(/^The phone system is not reachable/), code: 'PHONE_SYSTEM_UNAVAILABLE' });
  });

  it('trunk lookup fails too → 503, nothing half-shown', async () => {
    const h = makeListRegistrations({ fetch: async () => ROWS(), fetchTrunks: async () => { throw new Error('timeout'); }, extensionsFor: vi.fn() });
    const { r } = await call(h, { role: 'SUPER_ADMIN' });
    expect(r.statusCode).toBe(503);
  });

  it('tenant trunk names query is tenant-bound and ignores deleted trunks', async () => {
    const q = vi.fn(async () => ({ rows: [{ name: 'tenant-trunk' }] }));
    expect([...(await tenantGatewayNames(7, q))]).toEqual(['tenant-trunk']);
    expect(q.mock.calls[0][1]).toEqual([7]);
    expect(q.mock.calls[0][0]).toContain('tenant_id = $1 AND deleted_at IS NULL');
  });

  it('tenant extensions query is tenant-bound and ignores deleted rows', async () => {
    const q = vi.fn(async () => ({ rows: [{ ext: '1003' }, { ext: '2001' }] }));
    const set = await tenantExtensions(7, q);
    expect([...set]).toEqual(['1003', '2001']);
    const [sql, params] = q.mock.calls[0];
    expect(params).toEqual([7]);
    expect(sql.match(/o\.tenant_id = \$1/g)).toHaveLength(3);
    expect(sql.match(/deleted_at IS NULL/g).length).toBeGreaterThanOrEqual(6);
  });
});
