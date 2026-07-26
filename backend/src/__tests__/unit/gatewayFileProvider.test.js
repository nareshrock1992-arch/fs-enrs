import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayFileProvider } from '../../../platform/configuration/providers/GatewayFileProvider.js';
import { extractGatewayMeta }  from '../../../platform/configuration/parsers/GatewayParser.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Minimal active gateway — static trunk, no registration.
const AVAYA = `<include>
  <gateway name="avaya">
    <param name="proxy" value="10.128.14.37:5060"/>
    <param name="register" value="false"/>
    <param name="realm" value="10.128.14.37"/>
    <param name="from-domain" value="yerp.com"/>
    <param name="register-transport" value="udp"/>

    <!-- Identity handling -->
    <param name="sip_cid_type" value="pai"/>
    <param name="caller-id-in-from" value="false"/>

    <!-- Keepalive / timers -->
    <param name="ping" value="25"/>
    <param name="expire-seconds" value="3600"/>
    <param name="retry-seconds" value="30"/>

    <!-- Contact handling -->
    <param name="extension-in-contact" value="true"/>
    <param name="contact-params" value="transport=udp"/>
  </gateway>
</include>`;

// Registered ITSP gateway.
const GENERIC = `<include>
  <gateway name="generic-itsp">
    <param name="username" value="user123"/>
    <param name="password" value="pass123"/>
    <param name="realm" value="sip.provider.com"/>
    <param name="proxy" value="sip.provider.com"/>
    <param name="register" value="true"/>
    <param name="expire-seconds" value="3600"/>
    <param name="retry-seconds" value="30"/>
    <param name="transport" value="udp"/>
    <param name="ping" value="25"/>
  </gateway>
</include>`;

// TLS gateway (MS Teams).
const MSTEAMS = `<include>
  <gateway name="ms-teams">
    <param name="proxy" value="sbc.yourdomain.com:5061"/>
    <param name="register" value="false"/>
    <param name="transport" value="tls"/>
    <!-- <param name="tls-verify-policy" value="none"/> -->
    <param name="ping" value="30"/>
  </gateway>
</include>`;

// Fully disabled gateway (documentation template).
const EXAMPLE_DISABLED = `<include>
  <!--<gateway name="asterlink.com">-->
  <!--<param name="username" value="cluecon"/>-->
  <!--<param name="proxy" value="asterlink.com"/>-->
  <!--<param name="register" value="false"/>-->
  <!--</gateway>-->
</include>`;

// Invalid: register=true but missing credentials.
const MISSING_CREDS = `<include>
  <gateway name="bad-gateway">
    <param name="proxy" value="192.0.2.1:5060"/>
    <param name="register" value="true"/>
  </gateway>
</include>`;

// Invalid: bad transport value.
const BAD_TRANSPORT = `<include>
  <gateway name="bad-transport">
    <param name="proxy" value="192.0.2.1:5060"/>
    <param name="register" value="false"/>
    <param name="transport" value="sctp"/>
  </gateway>
</include>`;

// Missing proxy (warning expected).
const NO_PROXY = `<include>
  <gateway name="no-proxy">
    <param name="register" value="false"/>
    <param name="ping" value="30"/>
  </gateway>
</include>`;

const stubDriver = {
  resolveSipProfilePath: (rel) => rel ? `/etc/freeswitch/sip_profiles/${rel}` : '/etc/freeswitch/sip_profiles',
  resolveConfigPath:     (rel) => `/etc/freeswitch/${rel}`,
};

// ── Setup ──────────────────────────────────────────────────────────────────────

let provider;

beforeEach(() => {
  provider = new GatewayFileProvider(stubDriver, 'external', 'avaya');
});

// ── extractGatewayMeta ─────────────────────────────────────────────────────────

describe('GatewayParser — extractGatewayMeta', () => {
  it('extracts name and enabled=true from an active gateway', () => {
    const meta = extractGatewayMeta(AVAYA);
    expect(meta.name).toBe('avaya');
    expect(meta.gatewayEnabled).toBe(true);
  });

  it('extracts name and enabled=false from a disabled gateway', () => {
    const meta = extractGatewayMeta(EXAMPLE_DISABLED);
    expect(meta.name).toBe('asterlink.com');
    expect(meta.gatewayEnabled).toBe(false);
  });

  it('returns null name when no gateway tag found', () => {
    const meta = extractGatewayMeta('<include></include>');
    expect(meta.name).toBeNull();
  });
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe('GatewayFileProvider — identity', () => {
  it('constructs the correct provider id', () => {
    expect(provider.id).toBe('gateway:external:avaya');
  });

  it('includes profile and file in the name', () => {
    expect(provider.name).toContain('avaya');
    expect(provider.name).toContain('external');
  });

  it('exposes profileName and fileBasename accessors', () => {
    expect(provider.profileName).toBe('external');
    expect(provider.fileBasename).toBe('avaya');
  });

  it('resolves file path using resolveSipProfilePath', () => {
    expect(provider.getFilePath()).toBe('/etc/freeswitch/sip_profiles/external/avaya.xml');
  });

  it('uses the profile name in the deployment strategy', () => {
    const strategy = provider.deploymentStrategy;
    expect(strategy.id).toBe('sofia_rescan');
    expect(strategy.steps.some(s => s.name.includes('external'))).toBe(true);
  });

  it('deployment strategy steps reference driver.reloadXml and rescanSofiaGateway', () => {
    const strategy = provider.deploymentStrategy;
    const calls = [];
    const mockDriver = {
      reloadXml: async () => { calls.push('reloadXml'); return { success: true }; },
      rescanSofiaGateway: async (p) => { calls.push(`rescan:${p}`); return { success: true }; },
    };
    return Promise.all(strategy.steps.map(s => s.execute(mockDriver))).then(() => {
      expect(calls).toContain('reloadXml');
      expect(calls).toContain('rescan:external');
    });
  });

  it('throws when profileName is empty', () => {
    expect(() => new GatewayFileProvider(stubDriver, '', 'avaya')).toThrow();
  });

  it('throws when fileBasename is empty', () => {
    expect(() => new GatewayFileProvider(stubDriver, 'external', '')).toThrow();
  });
});

// ── Parse ──────────────────────────────────────────────────────────────────────

describe('GatewayFileProvider — parse', () => {
  it('parses AVAYA without throwing', () => {
    expect(() => provider.parse(AVAYA)).not.toThrow();
  });

  it('returns segments, index, entries, checksum, and gatewayMeta', () => {
    const doc = provider.parse(AVAYA);
    expect(doc).toHaveProperty('segments');
    expect(doc).toHaveProperty('index');
    expect(doc).toHaveProperty('entries');
    expect(doc).toHaveProperty('checksum');
    expect(doc).toHaveProperty('gatewayMeta');
  });

  it('identifies proxy as an active entry', () => {
    const doc  = provider.parse(AVAYA);
    const prox = doc.entries.find(e => e.key === 'proxy');
    expect(prox).toBeDefined();
    expect(prox.enabled).toBe(true);
    expect(prox.value).toBe('10.128.14.37:5060');
  });

  it('attaches catalog metadata to entries', () => {
    const doc  = provider.parse(AVAYA);
    const prox = doc.entries.find(e => e.key === 'proxy');
    expect(prox.label).toBeTruthy();
    expect(prox.description).toBeTruthy();
    expect(prox.category).toBeTruthy();
  });

  it('attaches gatewayName and profileName to entries', () => {
    const doc   = provider.parse(AVAYA);
    const entry = doc.entries[0];
    expect(entry.gatewayName).toBe('avaya');
    expect(entry.profileName).toBe('external');
    expect(entry.gatewayEnabled).toBe(true);
  });

  it('parses disabled params in MSTEAMS fixture', () => {
    const doc       = provider.parse(MSTEAMS);
    const tlsVerify = doc.entries.find(e => e.key === 'tls-verify-policy');
    expect(tlsVerify).toBeDefined();
    expect(tlsVerify.enabled).toBe(false);
  });

  it('correctly marks disabled gateway in EXAMPLE_DISABLED', () => {
    const doc = provider.parse(EXAMPLE_DISABLED);
    expect(doc.gatewayMeta.gatewayEnabled).toBe(false);
    expect(doc.gatewayMeta.name).toBe('asterlink.com');
  });

  it('disabled gateway params are parsed as disabled entries', () => {
    const doc    = provider.parse(EXAMPLE_DISABLED);
    const uEntry = doc.entries.find(e => e.key === 'username');
    expect(uEntry).toBeDefined();
    expect(uEntry.enabled).toBe(false);
  });
});

// ── Round-trip ─────────────────────────────────────────────────────────────────

describe('GatewayFileProvider — round-trip (serialize ∘ parse = identity)', () => {
  it('round-trips AVAYA unchanged', () => {
    const doc = provider.parse(AVAYA);
    expect(provider.serialize(doc)).toBe(AVAYA);
  });

  it('round-trips GENERIC unchanged', () => {
    const doc = provider.parse(GENERIC);
    expect(provider.serialize(doc)).toBe(GENERIC);
  });

  it('round-trips MSTEAMS unchanged', () => {
    const doc = provider.parse(MSTEAMS);
    expect(provider.serialize(doc)).toBe(MSTEAMS);
  });

  it('round-trips EXAMPLE_DISABLED unchanged', () => {
    const doc = provider.parse(EXAMPLE_DISABLED);
    expect(provider.serialize(doc)).toBe(EXAMPLE_DISABLED);
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('GatewayFileProvider — applyChanges', () => {
  it('updates proxy value', () => {
    const doc     = provider.parse(AVAYA);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'proxy', value: '10.1.2.3:5060' },
    ]);
    expect(provider.serialize(changed)).toContain('value="10.1.2.3:5060"');
  });

  it('enables a disabled param (tls-verify-policy in MSTEAMS)', () => {
    const doc     = provider.parse(MSTEAMS);
    const changed = provider.applyChanges(doc, [
      { op: 'enable', key: 'tls-verify-policy' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('<param name="tls-verify-policy"');
    expect(out).not.toContain('<!--');
  });

  it('disables an active param', () => {
    const doc     = provider.parse(AVAYA);
    const changed = provider.applyChanges(doc, [
      { op: 'disable', key: 'ping' },
    ]);
    const out = provider.serialize(changed);
    expect(out).not.toMatch(/<param name="ping"/);
    expect(out).toContain('ping');
  });

  it('deletes a param', () => {
    const doc     = provider.parse(AVAYA);
    const changed = provider.applyChanges(doc, [
      { op: 'delete', key: 'contact-params' },
    ]);
    expect(provider.serialize(changed)).not.toContain('contact-params');
  });

  it('returns updated entries with catalog metadata', () => {
    const doc     = provider.parse(AVAYA);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'proxy', value: '172.16.0.1:5060' },
    ]);
    const entry = changed.entries.find(e => e.key === 'proxy');
    expect(entry.value).toBe('172.16.0.1:5060');
    expect(entry.label).toBeTruthy();
  });

  it('preserves gatewayMeta across applyChanges', () => {
    const doc     = provider.parse(AVAYA);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'proxy', value: '1.2.3.4' },
    ]);
    expect(changed.gatewayMeta.name).toBe('avaya');
    expect(changed.gatewayMeta.gatewayEnabled).toBe(true);
  });
});

// ── Validate ───────────────────────────────────────────────────────────────────

describe('GatewayFileProvider — validate', () => {
  it('passes AVAYA as valid', () => {
    const doc    = provider.parse(AVAYA);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes GENERIC as valid', () => {
    const doc    = provider.parse(GENERIC);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
  });

  it('fails when register=true but credentials missing', () => {
    const doc    = provider.parse(MISSING_CREDS);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('username'))).toBe(true);
    expect(result.errors.some(e => e.includes('password'))).toBe(true);
  });

  it('fails when transport is invalid', () => {
    const doc    = provider.parse(BAD_TRANSPORT);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('transport'))).toBe(true);
  });

  it('warns when proxy is missing', () => {
    const doc    = provider.parse(NO_PROXY);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('proxy'))).toBe(true);
  });

  it('warns when gateway container is disabled', () => {
    const doc    = provider.parse(EXAMPLE_DISABLED);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('container'))).toBe(true);
  });

  it('warns when password is set but register is false', () => {
    const withPass = AVAYA.replace(
      '<param name="register" value="false"/>',
      '<param name="register" value="false"/>\n    <param name="password" value="secret"/>'
    );
    const doc    = provider.parse(withPass);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('password'))).toBe(true);
  });
});

// ── Diff ───────────────────────────────────────────────────────────────────────

describe('GatewayFileProvider — diff', () => {
  it('returns no-change string for identical content', () => {
    const result = provider.diff(AVAYA, AVAYA);
    expect(result).toContain('no parameter changes');
  });

  it('reports a changed value', () => {
    const changed = AVAYA.replace('value="10.128.14.37:5060"', 'value="10.0.0.1:5060"');
    const result  = provider.diff(AVAYA, changed);
    expect(result).toBeTruthy();
    expect(result).not.toContain('no parameter changes');
    expect(result).toContain('proxy');
  });
});

// ── Dynamic ID consistency ─────────────────────────────────────────────────────

describe('GatewayFileProvider — dynamic ID consistency', () => {
  it('produces correct id for any profile+basename combination', () => {
    const p = new GatewayFileProvider(stubDriver, 'carrier', 'trunk-1');
    expect(p.id).toBe('gateway:carrier:trunk-1');
    expect(p.profileName).toBe('carrier');
    expect(p.fileBasename).toBe('trunk-1');
    expect(p.getFilePath()).toContain('carrier/trunk-1.xml');
  });

  it('deployment strategy uses the correct profile name for any provider', () => {
    const p = new GatewayFileProvider(stubDriver, 'lab', 'test-gw');
    const strategy = provider.deploymentStrategy; // uses 'external'
    const labStrategy = p.deploymentStrategy;     // uses 'lab'
    expect(labStrategy.steps.some(s => s.name.includes('lab'))).toBe(true);
    // The default provider uses 'external'
    expect(strategy.steps.some(s => s.name.includes('external'))).toBe(true);
  });
});
