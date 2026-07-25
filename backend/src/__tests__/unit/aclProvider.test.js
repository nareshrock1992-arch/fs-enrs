import { describe, it, expect, beforeEach } from 'vitest';
import { AclProvider } from '../../../platform/configuration/providers/AclProvider.js';
import {
  parse, serialize, buildIndex, groupByKey, toEntries, applyChanges,
} from '../../../platform/configuration/parsers/AclParser.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Mirrors the production acl.conf.xml as closely as possible.
const STANDARD =
'<configuration name="acl.conf" description="Network Lists">\n' +
'  <network-lists>\n' +
'    <!--\n' +
'         These ACL\'s are automatically created on startup.\n' +
'    -->\n' +
'\n' +
'    <list name="lan" default="allow">\n' +
'      <node type="deny" cidr="192.168.42.0/24"/>\n' +
'      <node type="allow" cidr="192.168.42.42/32"/>\n' +
'    </list>\n' +
'\n' +
'    <list name="domains" default="deny">\n' +
'      <!-- domain= is special -->\n' +
'      <node type="allow" domain="example.com"/>\n' +
'      <!-- <node type="allow" cidr="192.168.0.0/24"/> -->\n' +
'    </list>\n' +
'\n' +
'  </network-lists>\n' +
'</configuration>';

// Minimal fixture with only a single list and one node.
const MINIMAL =
'<configuration name="acl.conf" description="Network Lists">\n' +
'  <network-lists>\n' +
'    <list name="mynet" default="deny">\n' +
'      <node type="allow" cidr="10.0.0.0/8"/>\n' +
'    </list>\n' +
'  </network-lists>\n' +
'</configuration>';

// All nodes disabled.
const ALL_DISABLED =
'<configuration name="acl.conf" description="Network Lists">\n' +
'  <network-lists>\n' +
'    <list name="lan" default="deny">\n' +
'      <!--<node type="allow" cidr="10.0.0.0/8"/>-->\n' +
'    </list>\n' +
'  </network-lists>\n' +
'</configuration>';

const stubDriver = {
  resolveConfigPath: (rel) => `/etc/freeswitch/${rel}`,
};

let provider;
beforeEach(() => {
  provider = new AclProvider(stubDriver);
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe('AclProvider — identity', () => {
  it('returns the correct provider id', () => {
    expect(provider.id).toBe('acl');
  });

  it('returns the correct name', () => {
    expect(provider.name).toBe('ACL Rules');
  });

  it('requires a driver at construction time', () => {
    expect(() => new AclProvider(null)).toThrow(/driver is required/);
  });

  it('resolves file path via the driver', () => {
    expect(provider.getFilePath()).toContain('acl.conf.xml');
  });
});

// ── parse: segment counts ──────────────────────────────────────────────────────

describe('AclParser — parse: segment structure', () => {
  it('returns a checksum for the content', () => {
    const { checksum } = parse(STANDARD);
    expect(typeof checksum).toBe('string');
    expect(checksum).toHaveLength(64);
  });

  it('same content always produces the same checksum', () => {
    expect(parse(STANDARD).checksum).toBe(parse(STANDARD).checksum);
  });

  it('different content produces a different checksum', () => {
    expect(parse(STANDARD).checksum).not.toBe(parse(MINIMAL).checksum);
  });

  it('identifies exactly 2 list-header entries in STANDARD', () => {
    const { segments } = parse(STANDARD);
    const lists = segments.filter(s => s.type === 'entry' && s._aclType === 'list');
    expect(lists).toHaveLength(2);
  });

  it('identifies exactly 4 node entries in STANDARD (3 active + 1 disabled)', () => {
    const { segments } = parse(STANDARD);
    const nodes = segments.filter(s => s.type === 'entry' && s._aclType === 'node');
    expect(nodes).toHaveLength(4);
  });

  it('block comment before the lists becomes other segments (not entries)', () => {
    const { segments } = parse(STANDARD);
    // The <!-- ... --> block comment must NOT produce any entry segment.
    const entries = segments.filter(s => s.type === 'entry');
    // Only list headers + nodes are entries; comment content must be 'other'.
    entries.forEach(e => {
      expect(e._aclType).toMatch(/^(list|node)$/);
    });
  });

  it('inline comment inside a list becomes an other segment', () => {
    const { segments } = parse(STANDARD);
    const others = segments.filter(s => s.type === 'other');
    expect(others.some(s => s.content.includes('domain= is special'))).toBe(true);
  });
});

// ── parse: list headers ────────────────────────────────────────────────────────

describe('AclParser — parse: list headers', () => {
  it('captures lan list with correct key and default policy', () => {
    const { segments } = parse(STANDARD);
    const lan = segments.find(s => s.type === 'entry' && s._aclType === 'list' && s._listName === 'lan');
    expect(lan).toBeDefined();
    expect(lan.key).toBe('_list___lan');
    expect(lan.value).toBe('allow');
    expect(lan.enabled).toBe(true);
  });

  it('captures domains list with correct key and default policy', () => {
    const { segments } = parse(STANDARD);
    const domains = segments.find(s => s.type === 'entry' && s._aclType === 'list' && s._listName === 'domains');
    expect(domains).toBeDefined();
    expect(domains.key).toBe('_list___domains');
    expect(domains.value).toBe('deny');
  });
});

// ── parse: nodes ───────────────────────────────────────────────────────────────

describe('AclParser — parse: node entries', () => {
  it('captures deny cidr node in lan', () => {
    const { segments } = parse(STANDARD);
    const node = segments.find(s => s.type === 'entry' && s._address === '192.168.42.0/24');
    expect(node).toBeDefined();
    expect(node.value).toBe('deny');
    expect(node.enabled).toBe(true);
    expect(node._nodeAttr).toBe('cidr');
    expect(node._listName).toBe('lan');
    expect(node.key).toBe('lan___192.168.42.0/24');
  });

  it('captures allow cidr node in lan', () => {
    const { segments } = parse(STANDARD);
    const node = segments.find(s => s.type === 'entry' && s._address === '192.168.42.42/32');
    expect(node).toBeDefined();
    expect(node.value).toBe('allow');
    expect(node.enabled).toBe(true);
  });

  it('captures active domain node in domains', () => {
    const { segments } = parse(STANDARD);
    const node = segments.find(s => s.type === 'entry' && s._nodeAttr === 'domain');
    expect(node).toBeDefined();
    expect(node.value).toBe('allow');
    expect(node.enabled).toBe(true);
    expect(node._listName).toBe('domains');
  });

  it('captures disabled cidr node in domains as enabled:false', () => {
    const { segments } = parse(STANDARD);
    const node = segments.find(s => s.type === 'entry' && s._address === '192.168.0.0/24');
    expect(node).toBeDefined();
    expect(node.enabled).toBe(false);
    expect(node.value).toBe('allow');
    expect(node._nodeAttr).toBe('cidr');
  });
});

// ── serialize: round-trip ─────────────────────────────────────────────────────

describe('AclParser — serialize: lossless round-trip', () => {
  it('round-trips STANDARD without modification', () => {
    const { segments } = parse(STANDARD);
    expect(serialize(segments)).toBe(STANDARD);
  });

  it('round-trips MINIMAL without modification', () => {
    const { segments } = parse(MINIMAL);
    expect(serialize(segments)).toBe(MINIMAL);
  });

  it('round-trips ALL_DISABLED without modification', () => {
    const { segments } = parse(ALL_DISABLED);
    expect(serialize(segments)).toBe(ALL_DISABLED);
  });

  it('disabled node with spaces inside comment markers is round-tripped verbatim', () => {
    const { segments } = parse(STANDARD);
    const out = serialize(segments);
    expect(out).toContain('<!-- <node type="allow" cidr="192.168.0.0/24"/> -->');
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('AclParser — applyChanges', () => {
  it('changes a node policy from deny to allow', () => {
    const { segments } = parse(STANDARD);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [
        { op: 'set', key: 'lan___192.168.42.0/24', value: 'allow' },
      ]);
    const out = serialize(after);
    expect(out).toContain('<node type="allow" cidr="192.168.42.0/24"/>');
    expect(out).not.toContain('<node type="deny" cidr="192.168.42.0/24"/>');
  });

  it('enables a disabled node', () => {
    const { segments } = parse(STANDARD);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [
        { op: 'enable', key: 'domains___192.168.0.0/24' },
      ]);
    const out = serialize(after);
    expect(out).toContain('<node type="allow" cidr="192.168.0.0/24"/>');
    expect(out).not.toContain('<!--');
  });

  it('disables an active node (uses canonical form)', () => {
    const { segments } = parse(STANDARD);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [
        { op: 'disable', key: 'lan___192.168.42.42/32' },
      ]);
    const out = serialize(after);
    expect(out).toContain('<!--<node type="allow" cidr="192.168.42.42/32"/>-->');
  });

  it('deletes a node and removes it from the output', () => {
    const { segments } = parse(MINIMAL);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [
        { op: 'delete', key: 'mynet___10.0.0.0/8' },
      ]);
    expect(serialize(after)).not.toContain('10.0.0.0/8');
  });

  it('changes a list default policy', () => {
    const { segments } = parse(MINIMAL);
    const idx = buildIndex(segments);
    const after = applyChanges(segments, idx, [
        { op: 'set', key: '_list___mynet', value: 'deny' },
      ]);
    expect(serialize(after)).toContain('<list name="mynet" default="deny">');
  });
});

// ── provider.parse: catalog integration ───────────────────────────────────────

describe('AclProvider — parse: catalog integration', () => {
  it('returns 6 entries for STANDARD (2 list + 4 nodes)', () => {
    const doc = provider.parse(STANDARD);
    expect(doc.entries).toHaveLength(6);
  });

  it('attaches _aclType to each entry', () => {
    const doc = provider.parse(STANDARD);
    doc.entries.forEach(e => {
      expect(e._aclType).toMatch(/^(list|node)$/);
    });
  });

  it('list entries have category "ACL Lists"', () => {
    const doc  = provider.parse(STANDARD);
    const list = doc.entries.find(e => e.key === '_list___lan');
    expect(list).toBeDefined();
    expect(list.category).toBe('ACL Lists');
    expect(list.label).toBe('lan');
  });

  it('node entries have category matching their list name', () => {
    const doc  = provider.parse(STANDARD);
    const node = doc.entries.find(e => e.key === 'lan___192.168.42.0/24');
    expect(node).toBeDefined();
    expect(node.category).toBe('lan');
  });

  it('attaches a label equal to the address for node entries', () => {
    const doc  = provider.parse(STANDARD);
    const node = doc.entries.find(e => e.key === 'lan___192.168.42.0/24');
    expect(node.label).toBe('192.168.42.0/24');
  });

  it('attaches alternatives array to every entry', () => {
    const doc = provider.parse(STANDARD);
    doc.entries.forEach(e => {
      expect(Array.isArray(e.alternatives)).toBe(true);
    });
  });

  it('returns a 64-char checksum', () => {
    const doc = provider.parse(STANDARD);
    expect(doc.checksum).toHaveLength(64);
  });
});

// ── provider.applyChanges ──────────────────────────────────────────────────────

describe('AclProvider — applyChanges', () => {
  it('updates node policy and rebuilds entries', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [
      { op: 'set', key: 'lan___192.168.42.0/24', value: 'allow' },
    ]);
    const node = doc2.entries.find(e => e.key === 'lan___192.168.42.0/24');
    expect(node.value).toBe('allow');
  });

  it('checksum is null after applyChanges', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [
      { op: 'set', key: '_list___lan', value: 'deny' },
    ]);
    expect(doc2.checksum).toBeNull();
  });

  it('rebuilt entries retain catalog label after change', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [
      { op: 'set', key: 'lan___192.168.42.0/24', value: 'allow' },
    ]);
    const node = doc2.entries.find(e => e.key === 'lan___192.168.42.0/24');
    expect(node.label).toBe('192.168.42.0/24');
  });
});

// ── provider.serialize ────────────────────────────────────────────────────────

describe('AclProvider — serialize', () => {
  it('round-trips STANDARD losslessly', () => {
    const doc = provider.parse(STANDARD);
    expect(provider.serialize(doc)).toBe(STANDARD);
  });

  it('reflects applied changes in serialised output', () => {
    const doc  = provider.parse(MINIMAL);
    const doc2 = provider.applyChanges(doc, [
      { op: 'set', key: '_list___mynet', value: 'allow' },
    ]);
    expect(provider.serialize(doc2)).toContain('<list name="mynet" default="allow">');
  });
});

// ── validate: clean config ─────────────────────────────────────────────────────

describe('AclProvider — validate: clean config', () => {
  it('passes for MINIMAL (deny list with allow node)', () => {
    const doc    = provider.parse(MINIMAL);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── validate: policy values ────────────────────────────────────────────────────

describe('AclProvider — validate: invalid policy value', () => {
  it('errors when a node has an invalid policy value', () => {
    const doc = provider.parse(MINIMAL);
    const bad = {
      ...doc,
      entries: doc.entries.map(e =>
        e.key === 'mynet___10.0.0.0/8' ? { ...e, value: 'permit' } : e
      ),
    };
    const result = provider.validate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('permit'))).toBe(true);
  });
});

// ── validate: permissive list warning ─────────────────────────────────────────

describe('AclProvider — validate: permissive list warning', () => {
  it('warns when a list has default=allow but no active deny nodes', () => {
    // STANDARD has "lan" with default=allow and a deny node → no warning.
    // MINIMAL has "mynet" with default=deny → no warning.
    // Construct a case with allow+no-deny.
    const content =
      '<configuration name="acl.conf" description="Network Lists">\n' +
      '  <network-lists>\n' +
      '    <list name="open" default="allow">\n' +
      '      <node type="allow" cidr="10.0.0.0/8"/>\n' +
      '    </list>\n' +
      '  </network-lists>\n' +
      '</configuration>';
    const doc    = provider.parse(content);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('"open"'))).toBe(true);
  });

  it('does not warn for lan in STANDARD (has an active deny node)', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.warnings.some(w => w.includes('"lan"'))).toBe(false);
  });
});

// ── validate: CIDR format ──────────────────────────────────────────────────────

describe('AclProvider — validate: CIDR format', () => {
  it('errors when a cidr node has an invalid CIDR address', () => {
    const doc = provider.parse(MINIMAL);
    const bad = {
      ...doc,
      entries: doc.entries.map(e =>
        e.key === 'mynet___10.0.0.0/8'
          ? { ...e, _address: 'not-a-cidr', _nodeAttr: 'cidr' }
          : e
      ),
    };
    const result = provider.validate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('not-a-cidr'))).toBe(true);
  });

  it('accepts standard IPv4 CIDR', () => {
    const doc    = provider.parse(MINIMAL);
    const result = provider.validate(doc);
    expect(result.errors.some(e => e.includes('10.0.0.0/8'))).toBe(false);
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe('AclProvider — diff', () => {
  it('returns no-change sentinel for identical content', () => {
    expect(provider.diff(STANDARD, STANDARD)).toBe('(no ACL changes)');
  });

  it('describes a changed node policy in the diff output', () => {
    const modified = STANDARD.replace(
      'type="deny" cidr="192.168.42.0/24"',
      'type="allow" cidr="192.168.42.0/24"'
    );
    const d = provider.diff(STANDARD, modified);
    expect(d).toContain('192.168.42.0/24');
  });
});
