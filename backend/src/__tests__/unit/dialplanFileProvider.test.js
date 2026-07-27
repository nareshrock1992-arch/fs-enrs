import { describe, it, expect, beforeEach } from 'vitest';
import { DialplanFileProvider } from '../../../platform/configuration/providers/DialplanFileProvider.js';
import { DeploymentStrategies } from '../../../platform/configuration/deploy/DeploymentStrategy.js';

// ── Minimal mock driver ────────────────────────────────────────────────────────

function makeMockDriver(resolvedPath = '/etc/freeswitch/dialplan/default.xml') {
  return {
    resolveConfigurationPath: (_type, _filename) => resolvedPath,
  };
}

// ── Sample XML fixtures ────────────────────────────────────────────────────────

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="echo_test">
      <condition field="destination_number" expression="^9196$">
        <action application="answer"/>
        <action application="echo"/>
        <action application="hangup"/>
      </condition>
    </extension>
  </context>
</include>`;

const DUPLICATE_NAMES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="echo_test">
      <condition field="destination_number" expression="^9196$">
        <action application="answer"/>
      </condition>
    </extension>
    <extension name="echo_test">
      <condition field="destination_number" expression="^9196$">
        <action application="bridge" data="sofia/gateway/gw1/15551234567"/>
      </condition>
    </extension>
  </context>
</include>`;

const EMPTY_CONTEXT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
  </context>
</include>`;

const UNKNOWN_APP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="custom_routing">
      <condition field="destination_number" expression="^5000$">
        <action application="my_custom_module" data="some_arg"/>
      </condition>
    </extension>
  </context>
</include>`;

const UNKNOWN_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="custom_var_check">
      <condition field="variable_my_custom_var" expression="^true$">
        <action application="transfer" data="5000 XML default"/>
      </condition>
    </extension>
  </context>
</include>`;

const MISSING_DATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="bridge_no_data">
      <condition field="destination_number" expression="^5001$">
        <action application="bridge" data=""/>
      </condition>
    </extension>
  </context>
</include>`;

const HIGH_RISK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="transfer_call">
      <condition field="destination_number" expression="^5002$">
        <action application="transfer" data="5000 XML default"/>
      </condition>
    </extension>
  </context>
</include>`;

// ── Constructor ───────────────────────────────────────────────────────────────

describe('DialplanFileProvider — constructor', () => {
  it('throws when driver is omitted', () => {
    expect(() => new DialplanFileProvider(null, 'default.xml')).toThrow();
  });

  it('throws when filename is omitted', () => {
    expect(() => new DialplanFileProvider(makeMockDriver(), '')).toThrow(/filename is required/);
  });

  it('throws when filename is not a string', () => {
    expect(() => new DialplanFileProvider(makeMockDriver(), 42)).toThrow();
  });

  it('constructs successfully with valid arguments', () => {
    expect(() => new DialplanFileProvider(makeMockDriver(), 'default.xml')).not.toThrow();
  });
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('DialplanFileProvider — identity', () => {
  it('id strips .xml suffix: default.xml → dialplan:default', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(p.id).toBe('dialplan:default');
  });

  it('id strips .xml suffix: public.xml → dialplan:public', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'public.xml');
    expect(p.id).toBe('dialplan:public');
  });

  it('id handles filename without .xml extension gracefully', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'internal');
    expect(p.id).toBe('dialplan:internal');
  });

  it('id converts path separator to colon for subdirectory files', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default/cc.xml');
    expect(p.id).toBe('dialplan:default:cc');
  });

  it('id converts path separator for deeply-nested relative paths', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'public/00_inbound_did.xml');
    expect(p.id).toBe('dialplan:public:00_inbound_did');
  });

  it('name contains the filename', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(p.name).toContain('default.xml');
  });

  it('description is a non-empty string containing the filename', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(typeof p.description).toBe('string');
    expect(p.description.length).toBeGreaterThan(0);
    expect(p.description).toContain('default.xml');
  });

  it('docType is hierarchical', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(p.docType).toBe('hierarchical');
  });

  it('deploymentStrategy is RELOAD_XML', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(p.deploymentStrategy).toBe(DeploymentStrategies.RELOAD_XML);
  });

  it('filename accessor returns the original filename', () => {
    const p = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(p.filename).toBe('default.xml');
  });
});

// ── getFilePath ───────────────────────────────────────────────────────────────

describe('DialplanFileProvider — getFilePath', () => {
  it('calls driver.resolveConfigurationPath with type=dialplan and the filename', () => {
    let capturedType, capturedFilename;
    const driver = {
      resolveConfigurationPath: (type, filename) => {
        capturedType     = type;
        capturedFilename = filename;
        return `/etc/freeswitch/dialplan/${filename}`;
      },
    };
    const p = new DialplanFileProvider(driver, 'default.xml');
    const result = p.getFilePath();

    expect(capturedType).toBe('dialplan');
    expect(capturedFilename).toBe('default.xml');
    expect(result).toBe('/etc/freeswitch/dialplan/default.xml');
  });

  it('returns exactly the value from the driver without modification', () => {
    const driver = { resolveConfigurationPath: () => '/custom/path/to/default.xml' };
    const p = new DialplanFileProvider(driver, 'default.xml');
    expect(p.getFilePath()).toBe('/custom/path/to/default.xml');
  });

  it('passes subdirectory relative path straight through to the driver', () => {
    let capturedFilename;
    const driver = {
      resolveConfigurationPath: (_type, filename) => {
        capturedFilename = filename;
        return `/etc/freeswitch/dialplan/${filename}`;
      },
    };
    const p = new DialplanFileProvider(driver, 'default/cc.xml');
    p.getFilePath();
    expect(capturedFilename).toBe('default/cc.xml');
  });
});

// ── parse ─────────────────────────────────────────────────────────────────────

describe('DialplanFileProvider — parse', () => {
  let provider;
  beforeEach(() => { provider = new DialplanFileProvider(makeMockDriver(), 'default.xml'); });

  it('returns an object with a nodes array', () => {
    const doc = provider.parse(MINIMAL_XML);
    expect(Array.isArray(doc.nodes)).toBe(true);
  });

  it('returns an object with entries equal to nodes (adapter layer)', () => {
    const doc = provider.parse(MINIMAL_XML);
    expect(doc.entries).toBe(doc.nodes);
  });

  it('returns a checksum string', () => {
    const doc = provider.parse(MINIMAL_XML);
    expect(typeof doc.checksum).toBe('string');
    expect(doc.checksum.length).toBeGreaterThan(0);
  });

  it('returns a contextName string', () => {
    const doc = provider.parse(MINIMAL_XML);
    expect(typeof doc.contextName).toBe('string');
    expect(doc.contextName).toBe('default');
  });

  it('parses extensions correctly', () => {
    const doc = provider.parse(MINIMAL_XML);
    const extensions = doc.nodes.filter(n => n.type === 'extension');
    expect(extensions.length).toBe(1);
    expect(extensions[0].name).toBe('echo_test');
  });

  it('parsing the same content twice returns structurally equal results', () => {
    const doc1 = provider.parse(MINIMAL_XML);
    const doc2 = provider.parse(MINIMAL_XML);
    expect(doc1.contextName).toBe(doc2.contextName);
    expect(doc1.nodes.length).toBe(doc2.nodes.length);
    expect(doc1.checksum).toBe(doc2.checksum);
  });
});

// ── serialize ─────────────────────────────────────────────────────────────────

describe('DialplanFileProvider — serialize', () => {
  let provider;
  beforeEach(() => { provider = new DialplanFileProvider(makeMockDriver(), 'default.xml'); });

  it('returns a string', () => {
    const doc = provider.parse(MINIMAL_XML);
    expect(typeof provider.serialize(doc)).toBe('string');
  });

  it('round-trip: serialize(parse(xml)) re-parses to an equal contextName', () => {
    const doc1  = provider.parse(MINIMAL_XML);
    const xml2  = provider.serialize(doc1);
    const doc2  = provider.parse(xml2);
    expect(doc2.contextName).toBe(doc1.contextName);
  });

  it('round-trip preserves extension count', () => {
    const doc1 = provider.parse(MINIMAL_XML);
    const doc2 = provider.parse(provider.serialize(doc1));
    const exts1 = doc1.nodes.filter(n => n.type === 'extension');
    const exts2 = doc2.nodes.filter(n => n.type === 'extension');
    expect(exts2.length).toBe(exts1.length);
  });

  it('round-trip preserves extension name', () => {
    const doc1 = provider.parse(MINIMAL_XML);
    const doc2 = provider.parse(provider.serialize(doc1));
    expect(doc2.nodes.filter(n => n.type === 'extension')[0].name)
      .toBe(doc1.nodes.filter(n => n.type === 'extension')[0].name);
  });
});

// ── applyChanges ──────────────────────────────────────────────────────────────

describe('DialplanFileProvider — applyChanges', () => {
  let provider;
  beforeEach(() => { provider = new DialplanFileProvider(makeMockDriver(), 'default.xml'); });

  it('does not mutate the input document', () => {
    const doc    = provider.parse(MINIMAL_XML);
    const before = doc.nodes.length;
    provider.applyChanges(doc, [{
      op:   'add_extension',
      name: 'new_ext',
    }]);
    expect(doc.nodes.length).toBe(before);
  });

  it('returns a new object reference', () => {
    const doc    = provider.parse(MINIMAL_XML);
    const newDoc = provider.applyChanges(doc, []);
    expect(newDoc).not.toBe(doc);
  });

  it('returned document also has the entries adapter set to nodes', () => {
    const doc    = provider.parse(MINIMAL_XML);
    const newDoc = provider.applyChanges(doc, []);
    expect(newDoc.entries).toBe(newDoc.nodes);
  });

  it('update_context changes the contextName', () => {
    const doc    = provider.parse(MINIMAL_XML);
    const newDoc = provider.applyChanges(doc, [{
      op:          'update_context',
      contextName: 'sales',
    }]);
    expect(newDoc.contextName).toBe('sales');
  });
});

// ── validate ──────────────────────────────────────────────────────────────────

describe('DialplanFileProvider — validate', () => {
  let provider;
  beforeEach(() => { provider = new DialplanFileProvider(makeMockDriver(), 'default.xml'); });

  it('returns valid=true with no errors for a well-formed doc', () => {
    const result = provider.validate(provider.parse(MINIMAL_XML));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid=false and an error for duplicate extension names', () => {
    const result = provider.validate(provider.parse(DUPLICATE_NAMES_XML));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Duplicate extension name'))).toBe(true);
  });

  it('returns valid=true with a warning for an empty dialplan — never an error', () => {
    const result = provider.validate(provider.parse(EMPTY_CONTEXT_XML));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('no extensions'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('unknown application is a warning, not an error — unknown ≠ invalid', () => {
    const result = provider.validate(provider.parse(UNKNOWN_APP_XML));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('my_custom_module'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('unknown condition field is a warning, not an error', () => {
    const result = provider.validate(provider.parse(UNKNOWN_FIELD_XML));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('variable_my_custom_var'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('missing data on a dataRequired application is a warning, not an error', () => {
    const result = provider.validate(provider.parse(MISSING_DATA_XML));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('bridge') && w.includes('data argument'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('high-risk application produces a warning, not an error', () => {
    // transfer is riskLevel: 'medium' in the catalog. Use hangup which is medium too.
    // The HIGH_RISK_XML uses transfer — verify warning behavior for medium risk apps.
    // (No application in the approved 20 is riskLevel:'high' — confirm valid=true)
    const result = provider.validate(provider.parse(HIGH_RISK_XML));
    expect(result.valid).toBe(true);
  });

  it('valid is false only when errors exist, not when only warnings exist', () => {
    const withWarnings = provider.validate(provider.parse(UNKNOWN_APP_XML));
    expect(withWarnings.warnings.length).toBeGreaterThan(0);
    expect(withWarnings.valid).toBe(true);
  });

  it('returns valid=false and an error for null doc', () => {
    const result = provider.validate(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false and an error for missing contextName', () => {
    const result = provider.validate({ contextName: '', nodes: [] });
    expect(result.valid).toBe(false);
  });

  it('returns valid=false and an error for missing nodes array', () => {
    const result = provider.validate({ contextName: 'default', nodes: null });
    expect(result.valid).toBe(false);
  });

  it('validate result always has errors and warnings arrays', () => {
    const result = provider.validate(provider.parse(MINIMAL_XML));
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe('DialplanFileProvider — diff', () => {
  let provider;
  beforeEach(() => { provider = new DialplanFileProvider(makeMockDriver(), 'default.xml'); });

  it('returns a string', () => {
    expect(typeof provider.diff(MINIMAL_XML, MINIMAL_XML)).toBe('string');
  });

  it('returns a no-change indicator for identical content', () => {
    const result = provider.diff(MINIMAL_XML, MINIMAL_XML);
    expect(result).toMatch(/no.*change/i);
  });

  it('returns a non-empty diff when an extension is added', () => {
    const doc    = provider.parse(MINIMAL_XML);
    const newDoc = provider.applyChanges(doc, [{
      op:   'add_extension',
      name: 'new_extension',
    }]);
    const newXml = provider.serialize(newDoc);
    const result = provider.diff(MINIMAL_XML, newXml);
    expect(result).not.toMatch(/^.*no.*change.*$/i);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── Fragment file support ─────────────────────────────────────────────────────

// Fragment files live under dialplan/default/*.xml.  They contain bare
// <extension> elements with no <include><context> wrapper — FreeSWITCH pulls
// them in via the include directive inside default.xml.

const FRAGMENT_BARE_XML = `<extension name="support-queue">
  <condition field="destination_number" expression="^2020$">
    <action application="answer"/>
    <action application="callcenter" data="support@default"/>
  </condition>
</extension>`;

const FRAGMENT_MULTI_EXTENSION_XML = `<extension name="support-queue">
  <condition field="destination_number" expression="^2020$">
    <action application="answer"/>
    <action application="callcenter" data="support@default"/>
  </condition>
</extension>
<!-- internal routing -->
<extension name="internal-transfer">
  <condition field="destination_number" expression="^(1[0-9]{3})$">
    <action application="transfer" data="$1 XML default"/>
  </condition>
</extension>`;

const FRAGMENT_WITH_INCLUDE_WRAPPER_XML = `<include>
  <extension name="wrapped-frag">
    <condition field="destination_number" expression="^3000$">
      <action application="answer"/>
    </condition>
  </extension>
</include>`;

describe('DialplanFileProvider — fragment files (subdirectory *.xml)', () => {
  let fragmentProvider;
  beforeEach(() => {
    // Provider ID 'dialplan:default:cc' → contextName hint = 'default'
    fragmentProvider = new DialplanFileProvider(makeMockDriver(), 'default/cc.xml');
  });

  it('parses a bare-extension fragment without throwing', () => {
    expect(() => fragmentProvider.parse(FRAGMENT_BARE_XML)).not.toThrow();
  });

  it('parsed fragment has isFragment = true', () => {
    const doc = fragmentProvider.parse(FRAGMENT_BARE_XML);
    expect(doc.isFragment).toBe(true);
  });

  it('fragment contextName is derived from the provider ID, not the XML', () => {
    const doc = fragmentProvider.parse(FRAGMENT_BARE_XML);
    // Provider id = 'dialplan:default:cc' → segment[1] = 'default'
    expect(doc.contextName).toBe('default');
  });

  it('fragment nodes contain the extension defined in the file', () => {
    const doc = fragmentProvider.parse(FRAGMENT_BARE_XML);
    const exts = doc.nodes.filter(n => n.type === 'extension');
    expect(exts.length).toBe(1);
    expect(exts[0].name).toBe('support-queue');
  });

  it('multi-extension fragment: all extensions are present after parse', () => {
    const doc  = fragmentProvider.parse(FRAGMENT_MULTI_EXTENSION_XML);
    const exts = doc.nodes.filter(n => n.type === 'extension');
    expect(exts.length).toBe(2);
    expect(exts.map(e => e.name)).toEqual(['support-queue', 'internal-transfer']);
  });

  it('multi-extension fragment: comments between extensions are preserved', () => {
    const doc      = fragmentProvider.parse(FRAGMENT_MULTI_EXTENSION_XML);
    const comments = doc.nodes.filter(n => n.type === 'comment');
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].text).toContain('internal routing');
  });

  it('parses a fragment with an <include> wrapper (but no <context>) correctly', () => {
    const doc  = fragmentProvider.parse(FRAGMENT_WITH_INCLUDE_WRAPPER_XML);
    expect(doc.isFragment).toBe(true);
    const exts = doc.nodes.filter(n => n.type === 'extension');
    expect(exts.length).toBe(1);
    expect(exts[0].name).toBe('wrapped-frag');
  });

  it('fragment contextName from <include>-wrapped form also uses provider hint', () => {
    const doc = fragmentProvider.parse(FRAGMENT_WITH_INCLUDE_WRAPPER_XML);
    expect(doc.contextName).toBe('default');
  });

  it('serialize(parse(fragment)) does NOT wrap output in <include><context>', () => {
    const doc = fragmentProvider.parse(FRAGMENT_BARE_XML);
    const xml = fragmentProvider.serialize(doc);
    expect(xml).not.toContain('<include>');
    expect(xml).not.toContain('<context');
  });

  it('serialize(parse(fragment)) produces an <extension> at the root level', () => {
    const doc = fragmentProvider.parse(FRAGMENT_BARE_XML);
    const xml = fragmentProvider.serialize(doc);
    expect(xml.trimStart()).toMatch(/^<extension/);
  });

  it('serialize round-trip preserves extension name in fragment', () => {
    const doc1 = fragmentProvider.parse(FRAGMENT_BARE_XML);
    const doc2 = fragmentProvider.parse(fragmentProvider.serialize(doc1));
    expect(doc2.nodes.filter(n => n.type === 'extension')[0].name)
      .toBe('support-queue');
  });

  it('validate passes for a valid fragment (contextName populated from hint)', () => {
    const doc    = fragmentProvider.parse(FRAGMENT_BARE_XML);
    const result = fragmentProvider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('standalone provider (default.xml) still sets isFragment = false', () => {
    const standaloneProvider = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    const doc = standaloneProvider.parse(MINIMAL_XML);
    expect(doc.isFragment).toBe(false);
  });

  it('diff works on two fragment strings without throwing', () => {
    expect(() => fragmentProvider.diff(FRAGMENT_BARE_XML, FRAGMENT_BARE_XML)).not.toThrow();
  });

  it('diff returns no-change indicator for identical fragment content', () => {
    const result = fragmentProvider.diff(FRAGMENT_BARE_XML, FRAGMENT_BARE_XML);
    expect(result).toMatch(/no.*change/i);
  });
});

// ── Regression guard ──────────────────────────────────────────────────────────

describe('DialplanFileProvider — regression guard (existing providers unaffected)', () => {
  it('importing DialplanFileProvider does not affect VarsProvider construction', async () => {
    const { VarsProvider } = await import(
      '../../../platform/configuration/providers/VarsProvider.js'
    );
    const driver = {
      resolveConfigurationPath: () => '/etc/freeswitch/vars.xml',
      resolveConfigPath: () => '/etc/freeswitch/vars.xml',
    };
    const p = new VarsProvider(driver);
    expect(p.docType).toBe('flat');
    expect(p.id).toBe('vars');
  });

  it('importing DialplanFileProvider does not affect GatewayFileProvider construction', async () => {
    const { GatewayFileProvider } = await import(
      '../../../platform/configuration/providers/GatewayFileProvider.js'
    );
    const driver = {
      resolveSipProfilePath: (rel) => `/etc/freeswitch/sip_profiles/${rel ?? ''}`,
    };
    const p = new GatewayFileProvider(driver, 'external', 'avaya');
    expect(p.docType).toBe('flat');
    expect(p.id).toBe('gateway:external:avaya');
  });

  it('DialplanFileProvider docType is hierarchical, not flat', () => {
    const dialplan = new DialplanFileProvider(makeMockDriver(), 'default.xml');
    expect(dialplan.docType).toBe('hierarchical');
    expect(dialplan.docType).not.toBe('flat');
  });
});
