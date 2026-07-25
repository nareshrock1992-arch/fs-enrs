import { describe, it, expect } from 'vitest';
import { parse, serialize, toEntries } from '../../../platform/configuration/parsers/VarsParser.js';

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
