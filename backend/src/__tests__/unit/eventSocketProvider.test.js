import { describe, it, expect, beforeEach } from 'vitest';
import { EventSocketProvider } from '../../../platform/configuration/providers/EventSocketProvider.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const STANDARD = `<?xml version="1.0"?>
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="nat-map" value="false"/>
    <param name="listen-ip" value="127.0.0.1"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="StrongPass1!"/>
    <!--<param name="apply-inbound-acl" value="loopback.auto"/>-->
  </settings>
</configuration>`;

const DEFAULT_PASSWORD = `<?xml version="1.0"?>
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="listen-ip" value="127.0.0.1"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="ClueCon"/>
  </settings>
</configuration>`;

const EXPOSED_IP = `<?xml version="1.0"?>
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="listen-ip" value="0.0.0.0"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="StrongPass1!"/>
  </settings>
</configuration>`;

const BAD_PORT = `<?xml version="1.0"?>
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="listen-ip" value="127.0.0.1"/>
    <param name="listen-port" value="99999"/>
    <param name="password" value="StrongPass1!"/>
  </settings>
</configuration>`;

// Minimal stub — EventSocketProvider only uses driver.resolveConfigPath().
const stubDriver = {
  resolveConfigPath: (rel) => `/etc/freeswitch/${rel}`,
};

// ── Setup ──────────────────────────────────────────────────────────────────────

let provider;

beforeEach(() => {
  provider = new EventSocketProvider(stubDriver);
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe('EventSocketProvider — identity', () => {
  it('returns the correct provider id', () => {
    expect(provider.id).toBe('event-socket');
  });

  it('returns the correct name', () => {
    expect(provider.name).toBe('Event Socket');
  });

  it('requires a driver at construction time', () => {
    expect(() => new EventSocketProvider(null)).toThrow(/driver is required/);
  });

  it('resolves file path via the driver', () => {
    expect(provider.getFilePath()).toContain('event_socket.conf.xml');
  });
});

// ── parse: catalog integration ─────────────────────────────────────────────────

describe('EventSocketProvider — parse: catalog metadata', () => {
  it('returns entries for every param in the content', () => {
    const doc = provider.parse(STANDARD);
    expect(doc.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('attaches catalog label for known params', () => {
    const doc = provider.parse(STANDARD);
    const pw  = doc.entries.find(e => e.key === 'password');
    expect(pw).toBeDefined();
    expect(pw.label).toBe('ESL Password');
  });

  it('marks disabled params as enabled:false', () => {
    const doc = provider.parse(STANDARD);
    const acl = doc.entries.find(e => e.key === 'apply-inbound-acl');
    expect(acl).toBeDefined();
    expect(acl.enabled).toBe(false);
  });

  it('marks active params as enabled:true', () => {
    const doc = provider.parse(STANDARD);
    const ip = doc.entries.find(e => e.key === 'listen-ip');
    expect(ip.enabled).toBe(true);
    expect(ip.value).toBe('127.0.0.1');
  });

  it('attaches disabledHint for alternatives', () => {
    const doc = provider.parse(STANDARD);
    // No duplicate keys in STANDARD, so all alternatives arrays are empty.
    // Verify alternatives is always an array.
    doc.entries.forEach(e => {
      expect(Array.isArray(e.alternatives)).toBe(true);
    });
  });

  it('returns a checksum', () => {
    const doc = provider.parse(STANDARD);
    expect(typeof doc.checksum).toBe('string');
    expect(doc.checksum).toHaveLength(64);
  });

  it('synthesises catalog entry for unknown params', () => {
    const content = STANDARD.replace(
      '<param name="nat-map" value="false"/>',
      '<param name="nat-map" value="false"/>\n    <param name="custom-param" value="42"/>'
    );
    const doc = provider.parse(content);
    const custom = doc.entries.find(e => e.key === 'custom-param');
    expect(custom).toBeDefined();
    expect(custom.label).toBe('custom-param'); // synthesised from key
  });
});

// ── applyChanges ───────────────────────────────────────────────────────────────

describe('EventSocketProvider — applyChanges', () => {
  it('updates a param value and rebuilds entries', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [{ op: 'set', key: 'listen-port', value: '9021' }]);
    const port = doc2.entries.find(e => e.key === 'listen-port');
    expect(port.value).toBe('9021');
  });

  it('enables a disabled param', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [{ op: 'enable', key: 'apply-inbound-acl' }]);
    const acl  = doc2.entries.find(e => e.key === 'apply-inbound-acl');
    expect(acl.enabled).toBe(true);
  });

  it('checksum is null after applyChanges (not yet serialised)', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [{ op: 'set', key: 'password', value: 'NewPass' }]);
    expect(doc2.checksum).toBeNull();
  });

  it('rebuilt entries retain catalog label after change', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [{ op: 'set', key: 'password', value: 'NewPass' }]);
    const pw   = doc2.entries.find(e => e.key === 'password');
    expect(pw.label).toBe('ESL Password');
  });
});

// ── serialize ──────────────────────────────────────────────────────────────────

describe('EventSocketProvider — serialize', () => {
  it('round-trips unmodified content losslessly', () => {
    const doc = provider.parse(STANDARD);
    expect(provider.serialize(doc)).toBe(STANDARD);
  });

  it('reflects applied changes in serialised output', () => {
    const doc  = provider.parse(STANDARD);
    const doc2 = provider.applyChanges(doc, [{ op: 'set', key: 'listen-port', value: '9021' }]);
    expect(provider.serialize(doc2)).toContain('value="9021"');
  });
});

// ── validate: clean config ─────────────────────────────────────────────────────

describe('EventSocketProvider — validate: clean config', () => {
  it('passes validation for a correctly configured file', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── validate: default password ────────────────────────────────────────────────

describe('EventSocketProvider — validate: default ESL password', () => {
  it('emits a warning when password is ClueCon', () => {
    const doc    = provider.parse(DEFAULT_PASSWORD);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('ClueCon'))).toBe(true);
  });

  it('does not warn when a non-default password is set', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.warnings.some(w => w.includes('ClueCon'))).toBe(false);
  });
});

// ── validate: listen-ip exposure ──────────────────────────────────────────────

describe('EventSocketProvider — validate: listen-ip exposure', () => {
  it('warns when listen-ip is 0.0.0.0', () => {
    const doc    = provider.parse(EXPOSED_IP);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('0.0.0.0'))).toBe(true);
  });

  it('does not warn for listen-ip 127.0.0.1', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.warnings.some(w => w.includes('0.0.0.0'))).toBe(false);
  });
});

// ── validate: port range ──────────────────────────────────────────────────────

describe('EventSocketProvider — validate: listen-port range', () => {
  it('errors when listen-port is out of range (99999)', () => {
    const doc    = provider.parse(BAD_PORT);
    const result = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('listen-port'))).toBe(true);
  });

  it('accepts port 8021 as valid', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.errors.some(e => e.includes('listen-port'))).toBe(false);
  });

  it('errors when listen-port is 0', () => {
    const content = STANDARD.replace('value="8021"', 'value="0"');
    const doc     = provider.parse(content);
    const result  = provider.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('listen-port'))).toBe(true);
  });

  it('accepts port 65535 as valid', () => {
    const content = STANDARD.replace('value="8021"', 'value="65535"');
    const doc     = provider.parse(content);
    const result  = provider.validate(doc);
    expect(result.errors.some(e => e.includes('listen-port'))).toBe(false);
  });
});

// ── validate: XML attribute safety ────────────────────────────────────────────

describe('EventSocketProvider — validate: XML attribute safety', () => {
  it('errors when a value contains a bare < character', () => {
    // checkXmlAttributeValue flags '<' as invalid in attribute values.
    // Inject directly into entries since the parser cannot produce this value.
    const doc = provider.parse(STANDARD);
    const bad = {
      ...doc,
      entries: doc.entries.map(e =>
        e.key === 'password' ? { ...e, value: 'bad<value' } : e
      ),
    };
    const result = provider.validate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('password'))).toBe(true);
  });

  it('passes when values contain only safe characters', () => {
    const doc    = provider.parse(STANDARD);
    const result = provider.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe('EventSocketProvider — diff', () => {
  it('returns no-change sentinel when content is identical', () => {
    expect(provider.diff(STANDARD, STANDARD)).toBe('(no parameter changes)');
  });

  it('describes a changed parameter in the diff output', () => {
    const modified = STANDARD.replace('value="8021"', 'value="9021"');
    const d = provider.diff(STANDARD, modified);
    expect(d).toContain('listen-port');
  });
});
