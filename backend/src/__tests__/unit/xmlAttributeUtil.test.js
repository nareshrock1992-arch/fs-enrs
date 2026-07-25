import { describe, it, expect } from 'vitest';
import { checkXmlAttributeValue } from '../../../platform/configuration/xml/XmlAttributeUtil.js';

// Regression guard for the bong-ring false positive (Phase 7.3 hardening).
//
// FreeSWITCH TGML uses '>=' as a loop directive. The value
//   v=-7;%(100,0,941.0,1477.0);v=-7;>=2;+=.1;%(1400,0,350,440)
// contains '>' which is legal per XML 1.0 §3.1 but was previously rejected by
// the incorrect regex /["<>&]/ used in VarsProvider.validate().

const BONG_RING_VALUE = 'v=-7;%(100,0,941.0,1477.0);v=-7;>=2;+=.1;%(1400,0,350,440)';

describe('checkXmlAttributeValue — valid values', () => {
  it('accepts an empty string', () => {
    expect(checkXmlAttributeValue('')).toEqual({ valid: true });
  });

  it('accepts a plain alphanumeric value', () => {
    expect(checkXmlAttributeValue('hello-world')).toEqual({ valid: true });
  });

  it('accepts a value containing ">" (XML 1.0 §3.1 permits it)', () => {
    expect(checkXmlAttributeValue('>').valid).toBe(true);
    expect(checkXmlAttributeValue('>=2').valid).toBe(true);
  });

  it('accepts the exact bong-ring TGML value (regression)', () => {
    const result = checkXmlAttributeValue(BONG_RING_VALUE);
    expect(result.valid).toBe(true);
  });

  it('accepts &amp; (recognized named entity)', () => {
    expect(checkXmlAttributeValue('foo &amp; bar').valid).toBe(true);
  });

  it('accepts &lt; (recognized named entity)', () => {
    expect(checkXmlAttributeValue('a &lt; b').valid).toBe(true);
  });

  it('accepts &gt; (recognized named entity)', () => {
    expect(checkXmlAttributeValue('a &gt; b').valid).toBe(true);
  });

  it('accepts &quot; (recognized named entity)', () => {
    expect(checkXmlAttributeValue('say &quot;hello&quot;').valid).toBe(true);
  });

  it('accepts &apos; (recognized named entity)', () => {
    expect(checkXmlAttributeValue("it&apos;s").valid).toBe(true);
  });

  it('accepts &#NNN; decimal character references', () => {
    expect(checkXmlAttributeValue('&#64;example.com').valid).toBe(true);
    expect(checkXmlAttributeValue('&#9;').valid).toBe(true);
  });

  it('accepts &#xHHH; hexadecimal character references', () => {
    expect(checkXmlAttributeValue('&#x40;example.com').valid).toBe(true);
    expect(checkXmlAttributeValue('&#xFF;').valid).toBe(true);
  });

  it('accepts multiple valid entities in the same value', () => {
    expect(checkXmlAttributeValue('&lt;node&gt; &amp; &quot;attr&quot;').valid).toBe(true);
  });

  it('accepts a value with no special characters', () => {
    expect(checkXmlAttributeValue('127.0.0.1').valid).toBe(true);
    expect(checkXmlAttributeValue('true').valid).toBe(true);
    expect(checkXmlAttributeValue('3600').valid).toBe(true);
  });
});

describe('checkXmlAttributeValue — invalid values', () => {
  it('rejects a value containing "<"', () => {
    const result = checkXmlAttributeValue('foo<bar');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/<'/);
  });

  it('rejects a value that is only "<"', () => {
    expect(checkXmlAttributeValue('<').valid).toBe(false);
  });

  it('rejects a value with "<" alongside valid TGML ">" characters', () => {
    expect(checkXmlAttributeValue('<foo>=2').valid).toBe(false);
  });

  it('rejects a bare "&" (no entity reference)', () => {
    const result = checkXmlAttributeValue('foo & bar');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/&/);
  });

  it('rejects a bare "&" at the end of the string', () => {
    expect(checkXmlAttributeValue('foo&').valid).toBe(false);
  });

  it('rejects an undefined entity reference like &foo;', () => {
    expect(checkXmlAttributeValue('&foo;').valid).toBe(false);
  });

  it('rejects an entity-like string missing the semicolon (&amp without ;)', () => {
    expect(checkXmlAttributeValue('foo &amp bar').valid).toBe(false);
  });
});

describe('checkXmlAttributeValue — edge cases', () => {
  it('returns valid:true for non-string input (null)', () => {
    expect(checkXmlAttributeValue(null)).toEqual({ valid: true });
  });

  it('returns valid:true for non-string input (undefined)', () => {
    expect(checkXmlAttributeValue(undefined)).toEqual({ valid: true });
  });

  it('returns valid:true for non-string input (number)', () => {
    expect(checkXmlAttributeValue(42)).toEqual({ valid: true });
  });

  it('handles a value with only entity references and no bare &', () => {
    expect(checkXmlAttributeValue('&amp;&lt;&gt;').valid).toBe(true);
  });

  it('detects a bare & after valid entity references', () => {
    // &amp; is valid, but the trailing bare & is not
    expect(checkXmlAttributeValue('&amp; & more').valid).toBe(false);
  });
});
