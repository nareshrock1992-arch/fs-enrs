import { describe, it, expect } from 'vitest';
import {
  parse, serialize, toEntries, applyChanges, buildIndex,
  buildGroupMap, groupByKey,
} from '../../../platform/configuration/parsers/VarsParser.js';

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

// ── Grouped-definition model ───────────────────────────────────────────────────
//
// vars.xml uses adjacent lines to represent alternative values for the same key:
//   <X-PRE-PROCESS cmd="set" data="sound_prefix=callie"/>
//   <!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=allison"/> -->
//
// The grouped model surfaces these as ONE entry with an alternatives array
// instead of two separate entries that would create duplicate UI cards.

const MULTI_DEF_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <X-PRE-PROCESS cmd="set" data="sound_prefix=$\${sounds_dir}/en/us/callie"/>
  <!--<Z-PRE-PROCESS cmd="set" data="sound_prefix=$\${sounds_dir}/en/us/allison"/> -->
  <X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>
</include>`;

describe('VarsParser — buildGroupMap', () => {
  it('returns a single entry array for keys that appear once', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const gm = buildGroupMap(segments);
    expect(gm.get('domain_name')).toHaveLength(1);
    expect(gm.get('max_sessions')).toHaveLength(1);
  });

  it('returns two indices for a key with an active and a disabled definition', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const gm = buildGroupMap(segments);
    expect(gm.get('sound_prefix')).toHaveLength(2);
  });

  it('does not include non-entry segments', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const gm = buildGroupMap(segments);
    // Only keys that appear in parsed entries
    expect([...gm.keys()]).toEqual(expect.arrayContaining(['domain_name', 'sound_prefix', 'max_sessions']));
    expect([...gm.keys()]).toHaveLength(3);
  });
});

describe('VarsParser — buildIndex with duplicate keys', () => {
  it('buildIndex prefers the enabled definition for a duplicate key', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx = buildIndex(segments);
    // The indexed segment for sound_prefix must be the enabled one (callie)
    const targetSeg = segments[idx.get('sound_prefix')];
    expect(targetSeg.enabled).toBe(true);
    expect(targetSeg.value).toBe('$${sounds_dir}/en/us/callie');
  });

  it('buildIndex does not point to the disabled alternative', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx = buildIndex(segments);
    const targetSeg = segments[idx.get('sound_prefix')];
    expect(targetSeg.value).not.toContain('allison');
  });
});

describe('VarsParser — groupByKey', () => {
  it('returns one group per unique key', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const groups = groupByKey(segments);
    const keys = groups.map(g => g.key);
    expect(keys).toEqual(['domain_name', 'sound_prefix', 'max_sessions']);
  });

  it('primary of sound_prefix is the enabled (callie) definition', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const group = groupByKey(segments).find(g => g.key === 'sound_prefix');
    expect(group.primary.enabled).toBe(true);
    expect(group.primary.value).toContain('callie');
  });

  it('alternatives of sound_prefix contains the disabled (allison) definition', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const group = groupByKey(segments).find(g => g.key === 'sound_prefix');
    expect(group.alternatives).toHaveLength(1);
    expect(group.alternatives[0].enabled).toBe(false);
    expect(group.alternatives[0].value).toContain('allison');
    expect(group.alternatives[0].disabledForm).toBe('z-tag');
  });

  it('alternatives carries the correct definitionId', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const groups = groupByKey(segments);
    const sp = groups.find(g => g.key === 'sound_prefix');
    const alt = sp.alternatives[0];
    // definitionId 1 = second occurrence of sound_prefix in file order = allison
    expect(alt.definitionId).toBe(1);
    expect(alt.value).toContain('allison');
  });

  it('single-definition keys have empty alternatives', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const groups = groupByKey(segments);
    const dn = groups.find(g => g.key === 'domain_name');
    expect(dn.alternatives).toHaveLength(0);
  });
});

describe('VarsParser — applyChanges: enable on multi-definition key', () => {
  it('enabling the primary also disables the alternative', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx  = buildIndex(segments);
    // 'enable' targets the indexed (callie) definition → allison must be disabled
    const after = applyChanges(segments, idx, [{ op: 'enable', key: 'sound_prefix' }]);
    const groups = groupByKey(after);
    const sp = groups.find(g => g.key === 'sound_prefix');
    expect(sp.primary.enabled).toBe(true);
    expect(sp.primary.value).toContain('callie');
    expect(sp.alternatives[0].enabled).toBe(false);
  });

  it('disabling a multi-definition key disables all definitions', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx  = buildIndex(segments);
    const after = applyChanges(segments, idx, [{ op: 'disable', key: 'sound_prefix' }]);
    const groups = groupByKey(after);
    const sp = groups.find(g => g.key === 'sound_prefix');
    // All definitions should be disabled
    const allDefs = [sp.primary, ...sp.alternatives];
    expect(allDefs.every(d => !d.enabled)).toBe(true);
  });
});

describe('VarsParser — applyChanges: enable with definitionId (alternative switching)', () => {
  it('enable + definitionId activates the target alternative and disables the active definition', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const groups = groupByKey(segments);
    const sp = groups.find(g => g.key === 'sound_prefix');
    // alternatives[0] is allison (definitionId 1, since callie is 0)
    const allisonDefId = sp.alternatives[0].definitionId;
    expect(typeof allisonDefId).toBe('number');

    const after = applyChanges(segments, buildIndex(segments), [{
      op: 'enable',
      key: 'sound_prefix',
      definitionId: allisonDefId,
    }]);

    const afterGroups = groupByKey(after);
    const afterSp = afterGroups.find(g => g.key === 'sound_prefix');

    // primary should now be allison (enabled)
    expect(afterSp.primary.value).toContain('allison');
    expect(afterSp.primary.enabled).toBe(true);
    // alternative (callie) should be disabled
    expect(afterSp.alternatives[0].value).toContain('callie');
    expect(afterSp.alternatives[0].enabled).toBe(false);
  });

  it('serializing after alternative switch produces one active X-PRE-PROCESS and one disabled', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const allisonDefId = groupByKey(segments).find(g => g.key === 'sound_prefix').alternatives[0].definitionId;

    const after = applyChanges(segments, buildIndex(segments), [{
      op: 'enable', key: 'sound_prefix', definitionId: allisonDefId,
    }]);
    const out = serialize(after);

    // Allison must be active
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="sound_prefix=$${sounds_dir}/en/us/allison"/>');
    // Callie must be disabled (canonical comment form since it was enabled before)
    expect(out).toContain('<!--<X-PRE-PROCESS cmd="set" data="sound_prefix=$${sounds_dir}/en/us/callie"/>-->');
    // No Z-PRE-PROCESS in active form
    const activeLines = out.split('\n').filter(l => l.includes('sound_prefix') && !l.trim().startsWith('<!--'));
    expect(activeLines).toHaveLength(1);
  });

  it('round-trip: serialize → re-parse preserves enabled states after alternative switch', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const allisonDefId = groupByKey(segments).find(g => g.key === 'sound_prefix').alternatives[0].definitionId;

    const after    = applyChanges(segments, buildIndex(segments), [{
      op: 'enable', key: 'sound_prefix', definitionId: allisonDefId,
    }]);
    const out      = serialize(after);
    const reparsed = groupByKey(parse(out).segments);
    const sp       = reparsed.find(g => g.key === 'sound_prefix');

    expect(sp.primary.value).toContain('allison');
    expect(sp.primary.enabled).toBe(true);
    expect(sp.alternatives[0].value).toContain('callie');
    expect(sp.alternatives[0].enabled).toBe(false);
  });

  it('enable without definitionId falls back to the indexed (primary) definition', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx = buildIndex(segments);
    // Disable all definitions first so we have something to re-enable
    const disabled  = applyChanges(segments, idx, [{ op: 'disable', key: 'sound_prefix' }]);
    const reEnabled = applyChanges(disabled, buildIndex(disabled), [{ op: 'enable', key: 'sound_prefix' }]);
    const sp = groupByKey(reEnabled).find(g => g.key === 'sound_prefix');
    expect(sp.primary.enabled).toBe(true);
  });

  it('groupByKey assigns definitionId as 0-based occurrence index per key', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const groups = groupByKey(segments);
    const sp = groups.find(g => g.key === 'sound_prefix');
    // Two definitions: primary (callie) and one alternative (allison)
    expect(sp.primary.definitionId).toBe(0);
    expect(sp.alternatives[0].definitionId).toBe(1);
    // Single-definition keys always get definitionId 0
    const domain = groups.find(g => g.key === 'domain_name');
    expect(domain.primary.definitionId).toBe(0);
    expect(domain.alternatives).toHaveLength(0);
  });
});

// ── applyChanges: set ──────────────────────────────────────────────────────────

const SIMPLE_CONTENT = `<?xml version="1.0"?>
<include>
  <X-PRE-PROCESS cmd="set" data="domain_name=enrs.local"/>
  <X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>
</include>`;

describe('VarsParser — applyChanges: set on existing key', () => {
  it('updates the value of an existing active variable', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'set', key: 'max_sessions', value: '2000' }]);
    const out    = serialize(after);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="max_sessions=2000"/>');
    expect(out).not.toContain('max_sessions=1000');
  });

  it('enabling an existing key via set preserves its value', () => {
    const { segments } = parse(SINGLE_LINE_DISABLED);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'set', key: 'external_sip_ip', value: '1.2.3.4', enabled: true }]);
    const out    = serialize(after);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="external_sip_ip=1.2.3.4"/>');
  });

  it('disabling an existing key via set produces a commented-out entry', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'set', key: 'max_sessions', value: '1000', enabled: false }]);
    const out    = serialize(after);
    expect(out).toContain('<!--<X-PRE-PROCESS cmd="set" data="max_sessions=1000"/>-->');
    expect(out).not.toMatch(/<X-PRE-PROCESS[^!]*max_sessions/);
  });

  it('inserts a new variable before </include> when key is absent', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'set', key: 'new_var', value: 'hello' }]);
    const out    = serialize(after);
    expect(out).toContain('<X-PRE-PROCESS cmd="set" data="new_var=hello"/>');
    // New variable must appear before closing tag
    const newPos   = out.indexOf('new_var=hello');
    const closePos = out.indexOf('</include>');
    expect(newPos).toBeGreaterThan(0);
    expect(newPos).toBeLessThan(closePos);
  });

  it('last-write-wins: two set changes for the same key applies only the final one', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [
      { op: 'set', key: 'max_sessions', value: '500' },
      { op: 'set', key: 'max_sessions', value: '9999' },
    ]);
    const out    = serialize(after);
    expect(out).toContain('max_sessions=9999');
    expect(out).not.toContain('max_sessions=500');
  });
});

describe('VarsParser — applyChanges: delete', () => {
  it('removes a variable from the serialised output', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'delete', key: 'max_sessions' }]);
    expect(serialize(after)).not.toContain('max_sessions');
  });

  it('removing a multi-definition key removes all its definitions', () => {
    const { segments } = parse(MULTI_DEF_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'delete', key: 'sound_prefix' }]);
    const out    = serialize(after);
    expect(out).not.toContain('sound_prefix');
  });

  it('does not affect other variables when one is deleted', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    const after  = applyChanges(segments, idx, [{ op: 'delete', key: 'max_sessions' }]);
    expect(serialize(after)).toContain('domain_name=enrs.local');
  });

  it('deleting an unknown key is a no-op (does not throw)', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx   = buildIndex(segments);
    expect(() => applyChanges(segments, idx, [{ op: 'delete', key: 'nonexistent' }])).not.toThrow();
  });
});

describe('VarsParser — applyChanges: unknown op', () => {
  it('throws for an unrecognised operation', () => {
    const { segments } = parse(SIMPLE_CONTENT);
    const idx = buildIndex(segments);
    expect(() => applyChanges(segments, idx, [{ op: 'upsert', key: 'domain_name', value: 'x' }]))
      .toThrow(/unknown op/);
  });
});

describe('VarsParser — serialize: formatting preservation', () => {
  it('preserves blank lines in the output', () => {
    const content = `<?xml version="1.0"?>\n<include>\n\n  <X-PRE-PROCESS cmd="set" data="k=v"/>\n\n</include>`;
    const { segments } = parse(content);
    const out = serialize(segments);
    expect(out).toBe(content);
  });

  it('preserves zero-indent entry without expanding it', () => {
    const content = `<?xml version="1.0"?>\n<include>\n<X-PRE-PROCESS cmd="set" data="k=v"/>\n</include>`;
    const { segments } = parse(content);
    const out = serialize(segments);
    expect(out).toContain('\n<X-PRE-PROCESS cmd="set" data="k=v"/>');
  });
});
