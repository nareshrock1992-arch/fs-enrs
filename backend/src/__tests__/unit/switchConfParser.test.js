import { describe, it, expect } from 'vitest';
import {
  parse, serialize, applyChanges, buildIndex,
  buildGroupMap, groupByKey, toEntries,
} from '../../../platform/configuration/parsers/SwitchConfParser.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASIC = `<?xml version="1.0"?>
<configuration name="switch.conf" description="Core Switch Configuration">
  <settings>
    <param name="loglevel" value="WARNING"/>
    <param name="max-sessions" value="1000"/>
    <!--<param name="sessions-per-second" value="30"/>-->
  </settings>
</configuration>`;

const ALL_ACTIVE = `<?xml version="1.0"?>
<configuration name="switch.conf" description="Core Switch Configuration">
  <settings>
    <param name="loglevel" value="DEBUG"/>
    <param name="max-sessions" value="500"/>
    <param name="rtp-start-port" value="16384"/>
    <param name="rtp-end-port" value="32768"/>
  </settings>
</configuration>`;

const ALL_DISABLED = `<?xml version="1.0"?>
<configuration name="switch.conf" description="Core Switch Configuration">
  <settings>
    <!--<param name="loglevel" value="WARNING"/>-->
    <!--<param name="max-sessions" value="1000"/>-->
  </settings>
</configuration>`;

const MULTI_LINE_DISABLED = `<?xml version="1.0"?>
<configuration name="switch.conf" description="Core Switch Configuration">
  <settings>
    <param name="loglevel" value="WARNING"/>
    <!--
    <param name="max-sessions" value="1000"/>
    -->
  </settings>
</configuration>`;

// ── parse: basic recognition ───────────────────────────────────────────────────

describe('SwitchConfParser — parse: active params', () => {
  it('recognises enabled params', () => {
    const { segments } = parse(BASIC);
    const entries = segments.filter(s => s.type === 'entry');
    expect(entries).toHaveLength(3);
  });

  it('marks active params as enabled', () => {
    const { segments } = parse(BASIC);
    const loglevel = segments.find(s => s.type === 'entry' && s.key === 'loglevel');
    expect(loglevel.enabled).toBe(true);
    expect(loglevel.value).toBe('WARNING');
  });

  it('marks commented params as disabled', () => {
    const { segments } = parse(BASIC);
    const sps = segments.find(s => s.type === 'entry' && s.key === 'sessions-per-second');
    expect(sps.enabled).toBe(false);
    expect(sps.value).toBe('30');
  });

  it('preserves non-param lines as other segments', () => {
    const { segments } = parse(BASIC);
    const others = segments.filter(s => s.type === 'other');
    expect(others.length).toBeGreaterThan(0);
    expect(others.some(s => s.content.includes('<configuration'))).toBe(true);
  });

  it('returns a checksum', () => {
    const { checksum } = parse(BASIC);
    expect(typeof checksum).toBe('string');
    expect(checksum).toHaveLength(64); // SHA-256 hex
  });

  it('two parses of the same content produce the same checksum', () => {
    expect(parse(BASIC).checksum).toBe(parse(BASIC).checksum);
  });

  it('different content produces a different checksum', () => {
    const modified = BASIC.replace('WARNING', 'DEBUG');
    expect(parse(BASIC).checksum).not.toBe(parse(modified).checksum);
  });
});

describe('SwitchConfParser — parse: disabled forms', () => {
  it('parses inline comment form: <!--<param .../> -->', () => {
    const { segments } = parse(ALL_DISABLED);
    expect(segments.filter(s => s.type === 'entry')).toHaveLength(2);
    segments.filter(s => s.type === 'entry').forEach(e => {
      expect(e.enabled).toBe(false);
    });
  });

  it('parses 3-line block comment form as a single disabled entry', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const entries = segments.filter(s => s.type === 'entry');
    expect(entries).toHaveLength(2);
    const maxSess = entries.find(e => e.key === 'max-sessions');
    expect(maxSess.enabled).toBe(false);
    expect(maxSess.value).toBe('1000');
  });

  it('stores original verbatim on unmodified disabled entries', () => {
    const { segments } = parse(BASIC);
    const sps = segments.find(s => s.type === 'entry' && s.key === 'sessions-per-second');
    expect(sps.original).toBe('    <!--<param name="sessions-per-second" value="30"/>-->');
    expect(sps.modified).toBe(false);
  });
});

// ── serialize: round-trip ──────────────────────────────────────────────────────

describe('SwitchConfParser — serialize: lossless round-trip', () => {
  it('serializes back to the exact original content', () => {
    expect(serialize(parse(BASIC).segments)).toBe(BASIC);
  });

  it('round-trips all-disabled content losslessly', () => {
    expect(serialize(parse(ALL_DISABLED).segments)).toBe(ALL_DISABLED);
  });

  it('round-trips all-active content losslessly', () => {
    expect(serialize(parse(ALL_ACTIVE).segments)).toBe(ALL_ACTIVE);
  });

  it('generates active param syntax for enabled entries', () => {
    const { segments } = parse(BASIC);
    const modified = segments.map(s =>
      s.type === 'entry' && s.key === 'loglevel'
        ? { ...s, value: 'DEBUG', modified: true }
        : s
    );
    const out = serialize(modified);
    expect(out).toContain('<param name="loglevel" value="DEBUG"/>');
  });

  it('generates canonical disabled form for newly disabled entries', () => {
    const { segments } = parse(ALL_ACTIVE);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [{ op: 'disable', key: 'loglevel' }]);
    const out = serialize(after);
    expect(out).toContain('<!--<param name="loglevel" value="DEBUG"/>-->');
    expect(out).not.toMatch(/<param name="loglevel"[^!]/);
  });

  it('does not output deleted segments', () => {
    const { segments } = parse(BASIC);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [{ op: 'delete', key: 'loglevel' }]);
    expect(serialize(after)).not.toContain('loglevel');
  });
});

// ── buildIndex ─────────────────────────────────────────────────────────────────

describe('SwitchConfParser — buildIndex', () => {
  it('maps every param key to a segment index', () => {
    const { segments } = parse(BASIC);
    const idx = buildIndex(segments);
    expect(idx.has('loglevel')).toBe(true);
    expect(idx.has('max-sessions')).toBe(true);
    expect(idx.has('sessions-per-second')).toBe(true);
  });

  it('does not index non-entry segments', () => {
    const { segments } = parse(BASIC);
    const idx = buildIndex(segments);
    expect(idx.has('<configuration')).toBe(false);
    expect(idx.has('<?xml')).toBe(false);
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('SwitchConfParser — applyChanges: set', () => {
  it('updates the value of an existing enabled param', () => {
    const { segments } = parse(BASIC);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'set', key: 'loglevel', value: 'DEBUG' },
    ]);
    expect(serialize(after)).toContain('<param name="loglevel" value="DEBUG"/>');
    expect(serialize(after)).not.toContain('value="WARNING"');
  });

  it('enables a disabled param via set', () => {
    const { segments } = parse(BASIC);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'set', key: 'sessions-per-second', value: '50', enabled: true },
    ]);
    const out = serialize(after);
    expect(out).toContain('<param name="sessions-per-second" value="50"/>');
    expect(out).not.toContain('<!--<param name="sessions-per-second"');
  });

  it('disables an active param via set', () => {
    const { segments } = parse(BASIC);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'set', key: 'loglevel', value: 'WARNING', enabled: false },
    ]);
    const out = serialize(after);
    expect(out).toContain('<!--<param name="loglevel" value="WARNING"/>-->');
    expect(out).not.toMatch(/<param name="loglevel" value/);
  });
});

describe('SwitchConfParser — applyChanges: enable / disable', () => {
  it('op:enable enables a disabled param', () => {
    const { segments } = parse(ALL_DISABLED);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'enable', key: 'loglevel' },
    ]);
    expect(serialize(after)).toContain('<param name="loglevel" value="WARNING"/>');
  });

  it('op:disable disables an active param', () => {
    const { segments } = parse(ALL_ACTIVE);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'disable', key: 'rtp-start-port' },
    ]);
    expect(serialize(after)).toContain('<!--<param name="rtp-start-port"');
  });
});

describe('SwitchConfParser — applyChanges: delete', () => {
  it('removes the param from the serialized output', () => {
    const { segments } = parse(ALL_ACTIVE);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'delete', key: 'rtp-end-port' },
    ]);
    expect(serialize(after)).not.toContain('rtp-end-port');
  });

  it('does not affect other params when one is deleted', () => {
    const { segments } = parse(ALL_ACTIVE);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'delete', key: 'rtp-end-port' },
    ]);
    expect(serialize(after)).toContain('rtp-start-port');
  });
});

// ── groupByKey ─────────────────────────────────────────────────────────────────

describe('SwitchConfParser — groupByKey', () => {
  it('returns one group per unique param key', () => {
    const { segments } = parse(BASIC);
    const groups = groupByKey(segments);
    expect(groups).toHaveLength(3);
    expect(groups.map(g => g.key)).toEqual(
      expect.arrayContaining(['loglevel', 'max-sessions', 'sessions-per-second'])
    );
  });

  it('primary is the enabled definition', () => {
    const { segments } = parse(BASIC);
    const groups = groupByKey(segments);
    const loglevel = groups.find(g => g.key === 'loglevel');
    expect(loglevel.primary.enabled).toBe(true);
    expect(loglevel.alternatives).toHaveLength(0);
  });

  it('disabled param has no alternatives (single definition)', () => {
    const { segments } = parse(BASIC);
    const sps = groupByKey(segments).find(g => g.key === 'sessions-per-second');
    expect(sps.primary.enabled).toBe(false);
    expect(sps.alternatives).toHaveLength(0);
    expect(sps.primary.definitionId).toBe(0);
  });
});

// ── toEntries ──────────────────────────────────────────────────────────────────

describe('SwitchConfParser — toEntries', () => {
  it('returns only entry segments as flat objects', () => {
    const { segments } = parse(BASIC);
    const entries = toEntries(segments);
    expect(entries).toHaveLength(3);
    expect(entries.every(e => 'key' in e && 'value' in e && 'enabled' in e)).toBe(true);
    expect(entries.every(e => !('content' in e))).toBe(true);
  });
});

// ── insertionPoint: new params go before </settings> ──────────────────────────

describe('SwitchConfParser — applyChanges: insert new param', () => {
  it('inserts a new param before </settings>', () => {
    const { segments } = parse(BASIC);
    const after = applyChanges(segments, buildIndex(segments), [
      { op: 'set', key: 'sip-trace', value: 'false' },
    ]);
    const out = serialize(after);
    expect(out).toContain('<param name="sip-trace" value="false"/>');
    // Must appear before </settings>
    expect(out.indexOf('sip-trace')).toBeLessThan(out.indexOf('</settings>'));
  });
});
