import { describe, it, expect } from 'vitest';
import { generateDialplanXml, generateDiagnosticsXml } from '../../utils/xmlGenerator.js';

// Regression guard for the "silently dropped dialplan fragment" bug class:
// a file spliced into an already-open <context name="default"> (nested
// layout) must NEVER declare its own <context> tag — FreeSWITCH's XML
// parser drops the whole fragment with no error when that happens, and
// reloadxml reports success regardless. Both layouts are legitimate
// FreeSWITCH configs, so both must be tested explicitly — never assume one.

const BINDING = { number: '1222', flow_uuid: 'abc-123', flow_name: 'Test Flow', version_number: 1 };

describe('xmlGenerator — nested layout (bare, no <context> wrapper)', () => {
  it('generateDialplanXml never emits a <context> tag when nested=true', () => {
    const xml = generateDialplanXml([BINDING], { nested: true });
    expect(xml).not.toMatch(/<context/);
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain('<include>');
    expect(xml).toContain('<extension name="enrs_ivr_1222" continue="false">');
    expect(xml).toContain('</include>');
  });

  it('generateDiagnosticsXml never emits a <context> tag when nested=true', () => {
    const xml = generateDiagnosticsXml({ nested: true });
    expect(xml).not.toMatch(/<context/);
    expect(xml).toContain('<extension name="enrs_diagnostics_probe">');
  });
});

describe('xmlGenerator — flat layout (wrapped in <context name="default">)', () => {
  it('generateDialplanXml wraps in <context name="default"> when nested=false', () => {
    const xml = generateDialplanXml([BINDING], { nested: false });
    expect(xml).toContain('<context name="default">');
    expect(xml).toContain('</context>');
    expect(xml).toContain('<extension name="enrs_ivr_1222" continue="false">');
  });

  it('generateDiagnosticsXml wraps in <context name="default"> when nested=false', () => {
    const xml = generateDiagnosticsXml({ nested: false });
    expect(xml).toContain('<context name="default">');
    expect(xml).toContain('<extension name="enrs_diagnostics_probe">');
  });
});

describe('xmlGenerator — test mode caller_id override', () => {
  it('injects caller_id_number override only for flows marked as test flows', () => {
    const xml = generateDialplanXml([BINDING], {
      nested: true,
      testMode: { enabled: true, callerId: '5551234567', testFlowUuids: new Set(['abc-123']) },
    });
    expect(xml).toContain('caller_id_number=5551234567');
  });

  it('does not inject the override for flows not marked as test flows', () => {
    const xml = generateDialplanXml([BINDING], {
      nested: true,
      testMode: { enabled: true, callerId: '5551234567', testFlowUuids: new Set(['some-other-uuid']) },
    });
    expect(xml).not.toContain('caller_id_number=5551234567');
  });

  it('does not inject the override when test mode is disabled, even for a test flow', () => {
    const xml = generateDialplanXml([BINDING], {
      nested: true,
      testMode: { enabled: false, callerId: '5551234567', testFlowUuids: new Set(['abc-123']) },
    });
    expect(xml).not.toContain('caller_id_number=5551234567');
  });

  it('produces no override markup at all when testMode is omitted', () => {
    const xml = generateDialplanXml([BINDING], { nested: true });
    expect(xml).not.toContain('caller_id_number=');
  });
});
