import { describe, it, expect } from 'vitest';
import { VarsProvider } from '../../../platform/configuration/providers/VarsProvider.js';

// Regression guard for the bong-ring deployment false positive (Phase 7.3 hardening).
//
// Root cause: VarsProvider.validate() used /["<>&]/ which incorrectly rejected
// '>' — a character that is valid in XML 1.0 attribute values (§3.1). The
// FreeSWITCH TGML loop directive '>=' in bong-ring's value caused every
// deployment to fail even when the user changed an unrelated variable.

const BONG_RING_VALUE = 'v=-7;%(100,0,941.0,1477.0);v=-7;>=2;+=.1;%(1400,0,350,440)';

// VarsProvider constructor requires a truthy driver (ConfigurationProvider guards this).
// validate() never calls this.driver, so a minimal stub satisfies the contract.
const STUB_DRIVER = {};
const provider = new VarsProvider(STUB_DRIVER);

function makeDoc(entries) {
  return { entries };
}

function entry(key, value, enabled = true) {
  return { key, value, enabled };
}

// ── Regression: the bong-ring scenario ──────────────────────────────────────

describe('VarsProvider.validate() — bong-ring regression', () => {
  it('passes when bong-ring is disabled and user changes an unrelated variable', () => {
    const doc = makeDoc([
      entry('default_areacode', '212', true),
      entry('bong-ring', BONG_RING_VALUE, false),
    ]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when bong-ring is enabled (> is valid in XML attribute values)', () => {
    const doc = makeDoc([
      entry('bong-ring', BONG_RING_VALUE, true),
    ]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes for a doc containing only the bong-ring value substring ">=2"', () => {
    const doc = makeDoc([entry('test-var', '>=2', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });
});

// ── Values that must remain invalid ─────────────────────────────────────────

describe('VarsProvider.validate() — values that must stay invalid', () => {
  it('rejects a value containing literal "<"', () => {
    const doc = makeDoc([entry('some-var', 'foo<bar', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('some-var'))).toBe(true);
  });

  it('rejects a value containing bare "&" (not an entity reference)', () => {
    const doc = makeDoc([entry('some-var', 'foo & bar', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('some-var'))).toBe(true);
  });

  it('rejects a value with an undefined entity reference like &foo;', () => {
    const doc = makeDoc([entry('some-var', '&foo;', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
  });
});

// ── Values with valid XML entities ───────────────────────────────────────────

describe('VarsProvider.validate() — recognized XML entities are accepted', () => {
  it('accepts &amp; in a value', () => {
    const doc = makeDoc([entry('some-var', 'A &amp; B', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });

  it('accepts &lt; in a value', () => {
    const doc = makeDoc([entry('some-var', 'a &lt; b', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });

  it('accepts &gt; in a value', () => {
    const doc = makeDoc([entry('some-var', 'a &gt; b', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });

  it('accepts numeric character references', () => {
    const doc = makeDoc([entry('some-var', '&#64;example.com', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });
});

// ── Key validation ───────────────────────────────────────────────────────────

describe('VarsProvider.validate() — key validation', () => {
  it('rejects an entry with an empty key', () => {
    const doc = makeDoc([{ key: '', value: 'x', enabled: true }]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty or invalid/);
  });

  it('rejects an entry whose key contains "<"', () => {
    const doc = makeDoc([entry('foo<bar', 'value', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/key/);
  });

  it('accepts a key that contains "-" and "_"', () => {
    const doc = makeDoc([entry('default_areacode', '212', true)]);
    expect(provider.validate(doc).valid).toBe(true);
  });
});

// ── Semantic checks that must survive the refactor ───────────────────────────

describe('VarsProvider.validate() — semantic warnings preserved', () => {
  it('emits a warning when default_password is set to "1234" (enabled)', () => {
    const doc = makeDoc([entry('default_password', '1234', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/default_password/);
    expect(result.warnings[0]).toMatch(/1234/);
  });

  it('does not warn about default_password when it is disabled', () => {
    const doc = makeDoc([entry('default_password', '1234', false)]);
    const result = provider.validate(doc);
    expect(result.warnings).toHaveLength(0);
  });

  it('does not warn about default_password when the value is not "1234"', () => {
    const doc = makeDoc([entry('default_password', 'Str0ng!Pass', true)]);
    const result = provider.validate(doc);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── Return shape ─────────────────────────────────────────────────────────────

describe('VarsProvider.validate() — return shape', () => {
  it('returns { valid, errors, warnings } for a clean doc', () => {
    const result = provider.validate(makeDoc([]));
    expect(result).toHaveProperty('valid', true);
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('returns valid:false when errors array is non-empty', () => {
    const doc = makeDoc([entry('x', 'foo<bar', true)]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles doc with no entries property', () => {
    expect(() => provider.validate({})).not.toThrow();
    expect(provider.validate({}).valid).toBe(true);
  });

  it('handles doc with null entries', () => {
    expect(() => provider.validate({ entries: null })).not.toThrow();
    expect(provider.validate({ entries: null }).valid).toBe(true);
  });
});

// ── Existing deployment compatibility ─────────────────────────────────────────

describe('VarsProvider.validate() — typical vars.xml entry set passes', () => {
  it('validates a representative set of real-world variable entries', () => {
    const doc = makeDoc([
      entry('default_password',  'Admin@12345',          true),
      entry('default_areacode',  '212',                  true),
      entry('domain_name',       'enrs.local',           true),
      entry('external_sip_ip',   'stun:stun.freeswitch.org', true),
      entry('external_rtp_ip',   'stun:stun.freeswitch.org', true),
      entry('bong-ring',         BONG_RING_VALUE,        false),
      entry('hold-music',        '$${base_dir}/sounds/music/8000/suite-espanola-op-47-leyenda.wav', true),
      entry('max_sessions',      '1000',                 true),
      entry('sessions_per_second', '30',                 true),
    ]);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
