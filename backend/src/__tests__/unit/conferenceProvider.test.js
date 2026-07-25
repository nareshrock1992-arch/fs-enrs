import { describe, it, expect, beforeEach } from 'vitest';
import { ConferenceProvider } from '../../../platform/configuration/providers/ConferenceProvider.js';
import { paramKey, splitKey } from '../../../platform/configuration/parsers/ConferenceParser.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Minimal fixture with two profiles — covers all round-trip and edit cases.
const MINIMAL = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="default">
      <param name="domain" value="$\${domain}"/>
      <param name="rate" value="8000"/>
      <param name="interval" value="20"/>
      <param name="energy-level" value="100"/>
      <!-- <param name="pin" value="12345"/> -->
      <param name="comfort-noise" value="true"/>
    </profile>

    <profile name="wideband">
      <param name="domain" value="$\${domain}"/>
      <param name="rate" value="16000"/>
      <param name="interval" value="20"/>
      <param name="energy-level" value="100"/>
      <param name="comfort-noise" value="true"/>
    </profile>
  </profiles>
</configuration>`;

// Fixture with a multi-line block comment (auto-record example).
const WITH_BLOCK_COMMENT = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="default">
      <param name="rate" value="8000"/>
      <!--
      <param name="auto-record" value="$\${recordings_dir}/\${conference_name}.wav"/>
      -->
      <param name="comfort-noise" value="true"/>
    </profile>
  </profiles>
</configuration>`;

// Fixture with duplicate video-layout-name (two alternative values in one profile).
const WITH_DUPLICATE_KEY = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="video-mcu">
      <param name="rate" value="48000"/>
      <param name="video-layout-name" value="3x3"/>
      <param name="video-layout-name" value="group:grid"/>
      <param name="video-fps" value="30"/>
    </profile>
  </profiles>
</configuration>`;

// Fixture with an invalid rate value.
const INVALID_RATE = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="default">
      <param name="rate" value="99999"/>
      <param name="interval" value="20"/>
    </profile>
  </profiles>
</configuration>`;

// Fixture with invalid comfort-noise value.
const INVALID_BOOL = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="default">
      <param name="rate" value="8000"/>
      <param name="comfort-noise" value="yes"/>
    </profile>
  </profiles>
</configuration>`;

// Fixture with a PIN set (warning expected).
const WITH_PIN = `<configuration name="conference.conf" description="Audio Conference">
  <profiles>
    <profile name="default">
      <param name="rate" value="8000"/>
      <param name="pin" value="1234"/>
      <param name="comfort-noise" value="true"/>
    </profile>
  </profiles>
</configuration>`;

const stubDriver = {
  resolveConfigPath: (rel) => `/etc/freeswitch/${rel}`,
};

// ── Setup ──────────────────────────────────────────────────────────────────────

let provider;

beforeEach(() => {
  provider = new ConferenceProvider(stubDriver);
});

// ── paramKey / splitKey helpers ────────────────────────────────────────────────

describe('ConferenceParser — key helpers', () => {
  it('paramKey joins profile and param with triple underscore', () => {
    expect(paramKey('default', 'rate')).toBe('default___rate');
  });

  it('splitKey correctly splits compound key', () => {
    expect(splitKey('default___rate')).toEqual({ profileName: 'default', paramName: 'rate' });
  });

  it('splitKey returns empty profileName for non-compound key', () => {
    expect(splitKey('rate')).toEqual({ profileName: '', paramName: 'rate' });
  });

  it('splitKey handles profile names with hyphens', () => {
    const k = paramKey('video-mcu-stereo', 'video-fps');
    expect(splitKey(k)).toEqual({ profileName: 'video-mcu-stereo', paramName: 'video-fps' });
  });
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe('ConferenceProvider — identity', () => {
  it('returns the correct provider id', () => {
    expect(provider.id).toBe('conference');
  });

  it('returns a non-empty name', () => {
    expect(provider.name).toBeTruthy();
  });

  it('returns a non-empty description', () => {
    expect(provider.description).toBeTruthy();
  });

  it('resolves a path containing conference.conf.xml', () => {
    expect(provider.getFilePath()).toContain('conference.conf.xml');
  });
});

// ── Parse ──────────────────────────────────────────────────────────────────────

describe('ConferenceProvider — parse', () => {
  it('parses MINIMAL without throwing', () => {
    expect(() => provider.parse(MINIMAL)).not.toThrow();
  });

  it('returns segments, index, entries, and checksum', () => {
    const doc = provider.parse(MINIMAL);
    expect(doc).toHaveProperty('segments');
    expect(doc).toHaveProperty('index');
    expect(doc).toHaveProperty('entries');
    expect(doc).toHaveProperty('checksum');
  });

  it('keys active entries with compound profileName___paramName', () => {
    const doc  = provider.parse(MINIMAL);
    const keys = doc.entries.filter(e => e.enabled).map(e => e.key);
    expect(keys).toContain('default___domain');
    expect(keys).toContain('default___rate');
    expect(keys).toContain('wideband___rate');
    expect(keys).toContain('wideband___domain');
  });

  it('treats a disabled param as a disabled entry', () => {
    const doc = provider.parse(MINIMAL);
    const pin = doc.entries.find(e => e.key === 'default___pin');
    expect(pin).toBeDefined();
    expect(pin.enabled).toBe(false);
  });

  it('attaches catalog metadata (label, description, category) to entries', () => {
    const doc  = provider.parse(MINIMAL);
    const rate = doc.entries.find(e => e.key === 'default___rate');
    expect(rate.label).toBeTruthy();
    expect(rate.description).toBeTruthy();
    expect(rate.category).toBeTruthy();
  });

  it('exposes profileName and paramName on each entry', () => {
    const doc  = provider.parse(MINIMAL);
    const rate = doc.entries.find(e => e.key === 'default___rate');
    expect(rate.profileName).toBe('default');
    expect(rate.paramName).toBe('rate');
  });

  it('same param name in different profiles creates separate entries', () => {
    const doc    = provider.parse(MINIMAL);
    const defRate = doc.entries.find(e => e.key === 'default___rate');
    const wbRate  = doc.entries.find(e => e.key === 'wideband___rate');
    expect(defRate).toBeDefined();
    expect(wbRate).toBeDefined();
    expect(defRate.value).toBe('8000');
    expect(wbRate.value).toBe('16000');
  });

  it('inBlock: multi-line block comment does not create extra entries', () => {
    const doc  = provider.parse(WITH_BLOCK_COMMENT);
    const keys = doc.entries.map(e => e.key);
    // auto-record is inside a multi-line block comment — must NOT appear as entry
    expect(keys.some(k => k.includes('auto-record'))).toBe(false);
  });

  it('handles duplicate param name in same profile (video-layout-name)', () => {
    const doc  = provider.parse(WITH_DUPLICATE_KEY);
    const grp  = doc.entries.find(e => e.key === 'video-mcu___video-layout-name');
    expect(grp).toBeDefined();
    expect(grp.alternatives.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Round-trip ─────────────────────────────────────────────────────────────────

describe('ConferenceProvider — round-trip (serialize ∘ parse = identity)', () => {
  it('round-trips MINIMAL unchanged', () => {
    const doc = provider.parse(MINIMAL);
    expect(provider.serialize(doc)).toBe(MINIMAL);
  });

  it('round-trips WITH_BLOCK_COMMENT unchanged', () => {
    const doc = provider.parse(WITH_BLOCK_COMMENT);
    expect(provider.serialize(doc)).toBe(WITH_BLOCK_COMMENT);
  });

  it('round-trips WITH_DUPLICATE_KEY unchanged', () => {
    const doc = provider.parse(WITH_DUPLICATE_KEY);
    expect(provider.serialize(doc)).toBe(WITH_DUPLICATE_KEY);
  });

  it('round-trips WITH_PIN unchanged', () => {
    const doc = provider.parse(WITH_PIN);
    expect(provider.serialize(doc)).toBe(WITH_PIN);
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('ConferenceProvider — applyChanges', () => {
  it('updates rate value in default profile', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'default___rate', value: '16000' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('<param name="rate" value="16000"/>');
    // wideband rate unchanged
    expect(out).toContain('<param name="rate" value="16000"/>');
    // count of 16000 instances (default + wideband)
    expect((out.match(/value="16000"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('enables a disabled param', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'enable', key: 'default___pin' },
    ]);
    const out = provider.serialize(changed);
    expect(out).toContain('<param name="pin" value="12345"/>');
    expect(out).not.toContain('<!-- <param name="pin"');
  });

  it('disables an active param', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'disable', key: 'default___rate' },
    ]);
    const out = provider.serialize(changed);
    expect(out).not.toMatch(/<param name="rate" value="8000"\/>/);
    expect(out).toContain('rate');
  });

  it('deletes a param', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'delete', key: 'default___comfort-noise' },
    ]);
    const out = provider.serialize(changed);
    // Only the default profile's comfort-noise is deleted; wideband is untouched
    const defaultSection = out.slice(out.indexOf('<profile name="default">'),
                                     out.indexOf('</profile>'));
    expect(defaultSection).not.toContain('comfort-noise');
    expect(out).toContain('wideband');
  });

  it('applyChanges returns updated entries with catalog metadata', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'default___rate', value: '48000' },
    ]);
    const entry = changed.entries.find(e => e.key === 'default___rate');
    expect(entry.value).toBe('48000');
    expect(entry.label).toBeTruthy();
    expect(entry.profileName).toBe('default');
  });

  it('adding a new param patches _profileName and _paramName', () => {
    const doc     = provider.parse(MINIMAL);
    const changed = provider.applyChanges(doc, [
      { op: 'set', key: 'default___tts-engine', value: 'flite' },
    ]);
    const newSeg = changed.segments.find(
      s => s.type === 'entry' && s.key === 'default___tts-engine'
    );
    expect(newSeg).toBeDefined();
    expect(newSeg._profileName).toBe('default');
    expect(newSeg._paramName).toBe('tts-engine');
  });
});

// ── Validate ───────────────────────────────────────────────────────────────────

describe('ConferenceProvider — validate', () => {
  it('passes MINIMAL as valid', () => {
    const doc    = provider.parse(MINIMAL);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when rate is out of range', () => {
    const doc    = provider.parse(INVALID_RATE);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rate'))).toBe(true);
  });

  it('fails when comfort-noise is not true/false', () => {
    const doc    = provider.parse(INVALID_BOOL);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('comfort-noise'))).toBe(true);
  });

  it('warns when a PIN is set', () => {
    const doc    = provider.parse(WITH_PIN);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('PIN'))).toBe(true);
  });

  it('does not warn about PIN when pin param is disabled', () => {
    const doc    = provider.parse(MINIMAL); // pin is commented out
    const result = provider.validate(doc);
    expect(result.warnings.some(w => w.includes('PIN'))).toBe(false);
  });
});

// ── Diff ───────────────────────────────────────────────────────────────────────

describe('ConferenceProvider — diff', () => {
  it('returns no-change string for identical content', () => {
    const result = provider.diff(MINIMAL, MINIMAL);
    expect(result).toContain('no parameter changes');
  });

  it('reports a changed value', () => {
    const changed = MINIMAL.replace(
      '<param name="rate" value="8000"/>',
      '<param name="rate" value="16000"/>'
    );
    const result = provider.diff(MINIMAL, changed);
    expect(result).toBeTruthy();
    expect(result).not.toContain('no parameter changes');
    expect(result).toContain('rate');
  });

  it('reports an enabled param', () => {
    const enabled = MINIMAL.replace(
      '<!-- <param name="pin" value="12345"/> -->',
      '<param name="pin" value="12345"/>'
    );
    const result = provider.diff(MINIMAL, enabled);
    expect(result).toContain('pin');
  });
});
