import { describe, it, expect, beforeEach } from 'vitest';
import { SofiaProvider } from '../../../platform/configuration/providers/SofiaProvider.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Verbatim copy of docs/freeswitch/sofia.conf.xml — used for round-trip tests.
const STANDARD = `<configuration name="sofia.conf" description="sofia Endpoint">

  <global_settings>
    <param name="log-level" value="0"/>
    <!-- <param name="abort-on-empty-external-ip" value="true"/> -->
    <!-- <param name="auto-restart" value="false"/> -->
    <param name="debug-presence" value="0"/>
    <!-- <param name="capture-server" value="udp:homer.domain.com:5060"/> -->

    <!--
        the new format for HEPv2/v3 and capture ID

        protocol:host:port;hep=2;capture_id=200;

    -->

    <!-- <param name="capture-server" value="udp:homer.domain.com:5060;hep=3;capture_id=100"/> -->
  </global_settings>

  <!--
      The rabbit hole goes deep.  This includes all the
      profiles in the sip_profiles directory that is up
      one level from this directory.
  -->
  <profiles>
    <X-PRE-PROCESS cmd="include" data="../sip_profiles/*.xml"/>
  </profiles>

</configuration>`;

// Minimal valid fixture with only active params.
const MINIMAL = `<configuration name="sofia.conf" description="sofia Endpoint">
  <global_settings>
    <param name="log-level" value="0"/>
    <param name="debug-presence" value="0"/>
  </global_settings>
</configuration>`;

// Fixture with capture-server enabled (triggers warning).
const WITH_CAPTURE = `<configuration name="sofia.conf" description="sofia Endpoint">
  <global_settings>
    <param name="log-level" value="0"/>
    <param name="debug-presence" value="0"/>
    <param name="capture-server" value="udp:homer.example.com:9060;hep=3;capture_id=100"/>
  </global_settings>
</configuration>`;

// Fixture with invalid log-level.
const INVALID_LOG_LEVEL = `<configuration name="sofia.conf" description="sofia Endpoint">
  <global_settings>
    <param name="log-level" value="99"/>
    <param name="debug-presence" value="0"/>
  </global_settings>
</configuration>`;

// Minimal stub — SofiaProvider only uses driver.resolveConfigPath().
const stubDriver = {
  resolveConfigPath: (rel) => `/etc/freeswitch/${rel}`,
};

// ── Setup ──────────────────────────────────────────────────────────────────────

let provider;

beforeEach(() => {
  provider = new SofiaProvider(stubDriver);
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe('SofiaProvider — identity', () => {
  it('returns the correct provider id', () => {
    expect(provider.id).toBe('sip-profiles');
  });

  it('returns a non-empty name', () => {
    expect(provider.name).toBeTruthy();
  });

  it('returns a non-empty description', () => {
    expect(provider.description).toBeTruthy();
  });

  it('resolves the correct file path', () => {
    expect(provider.getFilePath()).toContain('sofia.conf.xml');
  });
});

// ── Parse ──────────────────────────────────────────────────────────────────────

describe('SofiaProvider — parse', () => {
  it('parses STANDARD without throwing', () => {
    expect(() => provider.parse(STANDARD)).not.toThrow();
  });

  it('returns segments, index, entries, and checksum', () => {
    const doc = provider.parse(STANDARD);
    expect(doc).toHaveProperty('segments');
    expect(doc).toHaveProperty('index');
    expect(doc).toHaveProperty('entries');
    expect(doc).toHaveProperty('checksum');
  });

  it('finds active entries log-level and debug-presence', () => {
    const doc = provider.parse(STANDARD);
    const keys = doc.entries.filter(e => e.enabled).map(e => e.key);
    expect(keys).toContain('log-level');
    expect(keys).toContain('debug-presence');
  });

  it('treats disabled params as disabled entries', () => {
    const doc = provider.parse(STANDARD);
    const abort = doc.entries.find(e => e.key === 'abort-on-empty-external-ip');
    expect(abort).toBeDefined();
    expect(abort.enabled).toBe(false);
  });

  it('handles two disabled capture-server definitions (alternatives)', () => {
    const doc = provider.parse(STANDARD);
    const capture = doc.entries.find(e => e.key === 'capture-server');
    expect(capture).toBeDefined();
    // Both definitions are disabled; alternatives array may include the second
    expect(capture.enabled).toBe(false);
  });

  it('attaches catalog metadata to entries', () => {
    const doc = provider.parse(STANDARD);
    const logLevel = doc.entries.find(e => e.key === 'log-level');
    expect(logLevel.label).toBeTruthy();
    expect(logLevel.description).toBeTruthy();
    expect(logLevel.category).toBeTruthy();
  });

  it('parses MINIMAL without throwing', () => {
    expect(() => provider.parse(MINIMAL)).not.toThrow();
  });

  it('inBlock: multi-line block comment does not produce extra entry segments', () => {
    // The HEPv2/v3 block comment in STANDARD contains param-like text but no param elements.
    // Parsed entries should only include the real params.
    const doc = provider.parse(STANDARD);
    const realKeys = ['log-level', 'abort-on-empty-external-ip', 'auto-restart',
                      'debug-presence', 'capture-server'];
    const extraKeys = doc.entries.filter(e => !realKeys.includes(e.key));
    expect(extraKeys).toHaveLength(0);
  });
});

// ── Round-trip ─────────────────────────────────────────────────────────────────

describe('SofiaProvider — round-trip (serialize ∘ parse = identity)', () => {
  it('round-trips STANDARD unchanged', () => {
    const doc = provider.parse(STANDARD);
    const out  = provider.serialize(doc);
    expect(out).toBe(STANDARD);
  });

  it('round-trips MINIMAL unchanged', () => {
    const doc = provider.parse(MINIMAL);
    const out  = provider.serialize(doc);
    expect(out).toBe(MINIMAL);
  });

  it('round-trips WITH_CAPTURE unchanged', () => {
    const doc = provider.parse(WITH_CAPTURE);
    const out  = provider.serialize(doc);
    expect(out).toBe(WITH_CAPTURE);
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('SofiaProvider — applyChanges', () => {
  it('updates log-level value', () => {
    const doc = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'log-level', value: '6' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('value="6"');
    expect(out).not.toContain('value="0"');
  });

  it('enables a disabled param (abort-on-empty-external-ip)', () => {
    const doc = provider.parse(STANDARD);
    const changed = provider.applyChanges(doc, [
      { op: 'enable', key: 'abort-on-empty-external-ip' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('<param name="abort-on-empty-external-ip"');
    expect(out).not.toContain('<!-- <param name="abort-on-empty-external-ip"');
  });

  it('disables an active param (log-level)', () => {
    const doc = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'disable', key: 'log-level' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('<!--');
    expect(out).toContain('log-level');
    // Must not appear as an active param
    expect(out).not.toMatch(/<param name="log-level"/);
  });

  it('applyChanges returns updated entries with catalog metadata', () => {
    const doc = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'log-level', value: '3' },
    ]);
    const entry = changed.entries.find(e => e.key === 'log-level');
    expect(entry.value).toBe('3');
    expect(entry.label).toBeTruthy();
  });

  it('deletes an active param', () => {
    const doc = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'delete', key: 'log-level' },
    ]);
    const out = provider.serialize(changed);
    expect(out).not.toContain('log-level');
  });

  it('adds a new param not present in original', () => {
    const doc = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'capture-server', value: 'udp:homer.example.com:9060' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('capture-server');
    expect(out).toContain('udp:homer.example.com:9060');
  });
});

// ── Validate ───────────────────────────────────────────────────────────────────

describe('SofiaProvider — validate', () => {
  it('passes STANDARD as valid', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes MINIMAL as valid', () => {
    const doc    = provider.parse(MINIMAL);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
  });

  it('fails when log-level is out of range', () => {
    const doc    = provider.parse(INVALID_LOG_LEVEL);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('log-level'))).toBe(true);
  });

  it('fails when debug-presence is a non-integer string', () => {
    const content = MINIMAL.replace('value="0"/>', 'value="abc"/>');
    // Replace first occurrence (log-level stays 0; debug-presence gets "abc")
    const broken = MINIMAL.replace(
      '<param name="debug-presence" value="0"/>',
      '<param name="debug-presence" value="abc"/>'
    );
    const doc    = provider.parse(broken);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('debug-presence'))).toBe(true);
  });

  it('warns when capture-server is active', () => {
    const doc    = provider.parse(WITH_CAPTURE);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('capture-server'))).toBe(true);
  });

  it('does not warn about capture-server when it is disabled', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.warnings.some(w => w.includes('capture-server'))).toBe(false);
  });
});

// ── Diff ───────────────────────────────────────────────────────────────────────

describe('SofiaProvider — diff', () => {
  it('returns no-change string for identical content', () => {
    const result = provider.diff(MINIMAL, MINIMAL);
    expect(result).toContain('no parameter changes');
  });

  it('reports a changed value', () => {
    const changed = MINIMAL.replace('value="0"/>', 'value="3"/>');
    const result  = provider.diff(MINIMAL, changed);
    expect(result).toBeTruthy();
    expect(result).not.toContain('no parameter changes');
  });
});
