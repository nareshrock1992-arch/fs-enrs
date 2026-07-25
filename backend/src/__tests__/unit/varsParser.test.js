import { describe, it, expect } from 'vitest';
import { parse, serialize, toEntries, applyChanges, buildIndex } from '../../../platform/configuration/parsers/VarsParser.js';

// ── Multi-line comment regression ────────────────────────────────────────────
//
// Root cause: RE_DISABLED only matched single-line <!--<X-PRE-PROCESS.../>-->.
// A 3-line comment block (<!-- / <X-PRE-PROCESS .../> / -->) caused the inner
// directive to match RE_ACTIVE, making disabled variables appear as ENABLED.

const SINGLE_LINE_DISABLED = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!--<X-PRE-PROCESS cmd="set" data="external_sip_ip=1.2.3.4"/>-->
</include>`;

const MULTI_LINE_DISABLED = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!--
  <X-PRE-PROCESS cmd="set" data="external_sip_ip=1.2.3.4"/>
  -->
</include>`;

const MIXED_DISABLED = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!--
  <X-PRE-PROCESS cmd="set" data="external_sip_ip=1.2.3.4"/>
  -->
  <!--<X-PRE-PROCESS cmd="set" data="external_rtp_ip=auto"/>-->
  <X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>
</include>`;

describe('VarsParser — single-line disabled (existing behaviour, must not regress)', () => {
  it('recognises <!--<X-PRE-PROCESS.../>--> as a disabled entry', () => {
    const { segments } = parse(SINGLE_LINE_DISABLED);
    const entries = toEntries(segments);
    const sip = entries.find(e => e.key === 'external_sip_ip');
    expect(sip).toBeDefined();
    expect(sip.enabled).toBe(false);
    expect(sip.value).toBe('1.2.3.4');
  });

  it('recognises the active entry alongside it', () => {
    const { segments } = parse(SINGLE_LINE_DISABLED);
    const entries = toEntries(segments);
    const domain = entries.find(e => e.key === 'domain_name');
    expect(domain).toBeDefined();
    expect(domain.enabled).toBe(true);
  });
});

describe('VarsParser — multi-line comment disabled (the regression)', () => {
  it('recognises a 3-line <!--\\n<X-PRE-PROCESS/>\\n--> block as a disabled entry', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const entries = toEntries(segments);
    const sip = entries.find(e => e.key === 'external_sip_ip');
    expect(sip, 'entry must be present').toBeDefined();
    expect(sip.enabled, 'must be disabled, not enabled').toBe(false);
    expect(sip.value).toBe('1.2.3.4');
  });

  it('does NOT produce a duplicate or extra entry for the comment opener/closer', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const entries = toEntries(segments);
    const sipEntries = entries.filter(e => e.key === 'external_sip_ip');
    expect(sipEntries).toHaveLength(1);
  });

  it('still recognises the active entry that precedes the multi-line block', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const entries = toEntries(segments);
    const domain = entries.find(e => e.key === 'domain_name');
    expect(domain).toBeDefined();
    expect(domain.enabled).toBe(true);
  });

  it('preserves entry count and no spurious entries are added', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const entries = toEntries(segments);
    expect(entries).toHaveLength(2); // domain_name (active) + external_sip_ip (disabled)
  });
});

describe('VarsParser — mixed single-line and multi-line disabled in one file', () => {
  it('correctly classifies all entry states', () => {
    const { segments } = parse(MIXED_DISABLED);
    const entries = toEntries(segments);

    const domain   = entries.find(e => e.key === 'domain_name');
    const sipIp    = entries.find(e => e.key === 'external_sip_ip');
    const rtpIp    = entries.find(e => e.key === 'external_rtp_ip');
    const sessions = entries.find(e => e.key === 'max_sessions');

    expect(domain?.enabled).toBe(true);
    expect(sipIp?.enabled).toBe(false);
    expect(rtpIp?.enabled).toBe(false);
    expect(sessions?.enabled).toBe(true);
  });

  it('total entry count is 4', () => {
    const { segments } = parse(MIXED_DISABLED);
    expect(toEntries(segments)).toHaveLength(4);
  });
});

describe('VarsParser — serialize normalises multi-line disabled to single-line', () => {
  it('round-trips multi-line disabled to the canonical single-line format', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const out = serialize(segments);
    // The single disabled entry must be present in single-line form.
    expect(out).toContain('<!--<X-PRE-PROCESS cmd="set" data="external_sip_ip=1.2.3.4"/>-->');
    // The raw multi-line comment block should NOT be in the output.
    expect(out).not.toMatch(/<!--\s*\n/);
  });

  it('preserves the active entry unchanged', () => {
    const { segments } = parse(MULTI_LINE_DISABLED);
    const out = serialize(segments);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>');
  });
});

describe('VarsParser — multi-line comment with leading whitespace on opener/closer', () => {
  // Some editors produce "  <!--" (indented) as the comment opener.
  const INDENTED = `<?xml version="1.0"?>
<include>
  <!--
    <X-PRE-PROCESS cmd="set" data="hold_music=default"/>
  -->
</include>`;

  it('matches indented opener/closer (<!--  and  -->)', () => {
    const { segments } = parse(INDENTED);
    const entries = toEntries(segments);
    const e = entries.find(e => e.key === 'hold_music');
    expect(e).toBeDefined();
    expect(e.enabled).toBe(false);
    expect(e.value).toBe('default');
  });
});

describe('VarsParser — multi-line block with EXTRA content (known limitation)', () => {
  // The exact-3-line look-ahead only fires for <!--\n<X-PRE-PROCESS/>\n-->.
  // A block comment with extra text before or after the directive is NOT
  // specially handled: the inner <X-PRE-PROCESS> line matches RE_ACTIVE and
  // appears as an enabled entry. This is a documented limitation; fixing it
  // fully requires a stateful comment-context parser (future work).
  const EXTRA_CONTENT = `<?xml version="1.0"?>
<include>
  <!--
  This file was generated by ENRS.
  <X-PRE-PROCESS cmd="set" data="some_var=1"/>
  Edit with caution.
  -->
</include>`;

  it('inner X-PRE-PROCESS inside a multi-content block appears as an enabled entry (known limitation)', () => {
    const { segments } = parse(EXTRA_CONTENT);
    const entries = toEntries(segments);
    // Look-ahead does not match (extra lines) → inner directive hits RE_ACTIVE
    const e = entries.find(e => e.key === 'some_var');
    expect(e).toBeDefined();
    expect(e.enabled).toBe(true); // limitation: appears enabled, not disabled
  });
});

describe('VarsParser — checksum is stable', () => {
  it('same input produces the same checksum', () => {
    const a = parse(MULTI_LINE_DISABLED);
    const b = parse(MULTI_LINE_DISABLED);
    expect(a.checksum).toBe(b.checksum);
  });

  it('different inputs produce different checksums', () => {
    const a = parse(MULTI_LINE_DISABLED);
    const b = parse(SINGLE_LINE_DISABLED);
    expect(a.checksum).not.toBe(b.checksum);
  });
});

// ── FreeSWITCH tag-mangling conventions ────────────────────────────────────────
//
// vars.xml documents two additional patterns for disabling directives:
//
//   Z-PRE-PROCESS inside an XML comment (Z-prefix convention):
//     <!--<Z-PRE-PROCESS cmd="set" data="key=val"/> -->
//
//   XX-PRE-PROCESS as a bare tag (XX-prefix convention):
//     <XX-PRE-PROCESS cmd="set" data="key=val"/>
//     (preceding comment often reads "change XX to X below to enable")
//
// FreeSWITCH ignores both because (a) the Z/XX forms are inside an XML comment
// or use an unrecognised tag name. The UI should display them as enabled:false.

const Z_TAG_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=/usr/share/freeswitch/sounds/en/us/allison"/> -->
</include>`;

const XX_TAG_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!-- change XX to X below to enable -->
  <XX-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>
</include>`;

const BOTH_DISABLED_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=custom"/> -->
  <!-- change XX to X below to enable -->
  <XX-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>
  <X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>
</include>`;

describe('VarsParser — Z-PRE-PROCESS (Z-tag convention)', () => {
  it('parses Z-PRE-PROCESS inside XML comment as a disabled entry', () => {
    const { segments } = parse(Z_TAG_CONTENT);
    const entries = toEntries(segments);
    const e = entries.find(e => e.key === 'sound_prefix');
    expect(e).toBeDefined();
    expect(e.enabled).toBe(false);
    expect(e.value).toBe('/usr/share/freeswitch/sounds/en/us/allison');
  });

  it('does not affect the active entry that precedes it', () => {
    const { segments } = parse(Z_TAG_CONTENT);
    const entries = toEntries(segments);
    expect(entries.find(e => e.key === 'domain_name')?.enabled).toBe(true);
  });

  it('total entry count is 2 (active + z-tag disabled)', () => {
    expect(toEntries(parse(Z_TAG_CONTENT).segments)).toHaveLength(2);
  });

  it('unmodified z-tag serialises to the exact original line (byte-for-byte)', () => {
    const { segments } = parse(Z_TAG_CONTENT);
    const out = serialize(segments);
    expect(out).toContain('<!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=/usr/share/freeswitch/sounds/en/us/allison"/> -->');
  });

  it('enabling a z-tag entry serialises it as X-PRE-PROCESS', () => {
    const { segments } = parse(Z_TAG_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'enable', key: 'sound_prefix' }]);
    const out    = serialize(after);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="sound_prefix=/usr/share/freeswitch/sounds/en/us/allison"/>');
    expect(out).not.toContain('Z-PRE-PROCESS');
  });

  it('after enabling then re-disabling, produces canonical <!--<X-PRE-PROCESS.../>-->', () => {
    const { segments } = parse(Z_TAG_CONTENT);
    const idx   = buildIndex(segments);
    const step1 = applyChanges(segments, idx, [{ op: 'enable', key: 'sound_prefix' }]);
    const idx2  = buildIndex(step1);
    const step2 = applyChanges(step1, idx2, [{ op: 'disable', key: 'sound_prefix' }]);
    const out   = serialize(step2);
    expect(out).toContain('<!--<X-PRE-PROCESS cmd="set" data="sound_prefix=/usr/share/freeswitch/sounds/en/us/allison"/>-->');
    expect(out).not.toContain('Z-PRE-PROCESS');
  });

  it('round-trip parse → serialize → parse preserves key, value, enabled', () => {
    const doc1 = parse(Z_TAG_CONTENT);
    const out  = serialize(doc1.segments);
    const doc2 = parse(out);
    const e1   = toEntries(doc1.segments).find(e => e.key === 'sound_prefix');
    const e2   = toEntries(doc2.segments).find(e => e.key === 'sound_prefix');
    expect(e2).toBeDefined();
    expect(e2.key).toBe(e1.key);
    expect(e2.value).toBe(e1.value);
    expect(e2.enabled).toBe(e1.enabled);
  });
});

describe('VarsParser — XX-PRE-PROCESS (XX-tag convention)', () => {
  it('parses bare XX-PRE-PROCESS tag as a disabled entry', () => {
    const { segments } = parse(XX_TAG_CONTENT);
    const entries = toEntries(segments);
    const e = entries.find(e => e.key === 'digits_dialed_filter');
    expect(e).toBeDefined();
    expect(e.enabled).toBe(false);
    expect(e.value).toBe('secret');
  });

  it('does not affect the active entry', () => {
    const entries = toEntries(parse(XX_TAG_CONTENT).segments);
    expect(entries.find(e => e.key === 'domain_name')?.enabled).toBe(true);
  });

  it('total entry count is 2 (active + xx-tag disabled)', () => {
    expect(toEntries(parse(XX_TAG_CONTENT).segments)).toHaveLength(2);
  });

  it('unmodified xx-tag serialises to the exact original line (byte-for-byte)', () => {
    const { segments } = parse(XX_TAG_CONTENT);
    const out = serialize(segments);
    expect(out).toContain('<XX-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>');
  });

  it('enabling an xx-tag entry serialises it as X-PRE-PROCESS', () => {
    const { segments } = parse(XX_TAG_CONTENT);
    const idx  = buildIndex(segments);
    const after = applyChanges(segments, idx, [{ op: 'enable', key: 'digits_dialed_filter' }]);
    const out   = serialize(after);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>');
    expect(out).not.toContain('XX-PRE-PROCESS');
  });

  it('after enabling then re-disabling, produces canonical <!--<X-PRE-PROCESS.../>-->', () => {
    const { segments } = parse(XX_TAG_CONTENT);
    const idx   = buildIndex(segments);
    const step1 = applyChanges(segments, idx, [{ op: 'enable', key: 'digits_dialed_filter' }]);
    const idx2  = buildIndex(step1);
    const step2 = applyChanges(step1, idx2, [{ op: 'disable', key: 'digits_dialed_filter' }]);
    const out   = serialize(step2);
    expect(out).toContain('<!--<X-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>-->');
    expect(out).not.toContain('XX-PRE-PROCESS');
  });

  it('round-trip parse → serialize → parse preserves key, value, enabled', () => {
    const doc1 = parse(XX_TAG_CONTENT);
    const out  = serialize(doc1.segments);
    const doc2 = parse(out);
    const e1   = toEntries(doc1.segments).find(e => e.key === 'digits_dialed_filter');
    const e2   = toEntries(doc2.segments).find(e => e.key === 'digits_dialed_filter');
    expect(e2).toBeDefined();
    expect(e2.key).toBe(e1.key);
    expect(e2.value).toBe(e1.value);
    expect(e2.enabled).toBe(e1.enabled);
  });
});

describe('VarsParser — mixed disabled forms (xml-comment + z-tag + xx-tag)', () => {
  it('correctly classifies all 4 entries', () => {
    const entries = toEntries(parse(BOTH_DISABLED_CONTENT).segments);
    expect(entries).toHaveLength(4);
    expect(entries.find(e => e.key === 'domain_name')?.enabled).toBe(true);
    expect(entries.find(e => e.key === 'sound_prefix')?.enabled).toBe(false);
    expect(entries.find(e => e.key === 'digits_dialed_filter')?.enabled).toBe(false);
    expect(entries.find(e => e.key === 'max_sessions')?.enabled).toBe(true);
  });

  it('round-trip preserves all keys and enabled states', () => {
    const doc1    = parse(BOTH_DISABLED_CONTENT);
    const doc2    = parse(serialize(doc1.segments));
    const entries1 = toEntries(doc1.segments).map(e => `${e.key}:${e.enabled}`).sort();
    const entries2 = toEntries(doc2.segments).map(e => `${e.key}:${e.enabled}`).sort();
    expect(entries2).toEqual(entries1);
  });

  it('unmodified z-tag and xx-tag lines are preserved verbatim in serialised output', () => {
    const { segments } = parse(BOTH_DISABLED_CONTENT);
    const out = serialize(segments);
    expect(out).toContain('<!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=custom"/> -->');
    expect(out).toContain('<XX-PRE-PROCESS cmd="set" data="digits_dialed_filter=secret"/>');
  });
});
