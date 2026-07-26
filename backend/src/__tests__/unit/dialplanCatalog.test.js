import { describe, it, expect } from 'vitest';
import {
  lookupApplication,
  lookupField,
  applicationsByCategory,
  fieldsByCategory,
  knownApplicationNames,
  knownFieldNames,
} from '../../../platform/configuration/catalogs/dialplanCatalog.js';

// ── Application coverage ───────────────────────────────────────────────────────

const EXPECTED_APPLICATIONS = [
  'answer', 'bridge', 'transfer', 'execute_extension', 'hangup', 'park',
  'set', 'unset', 'export', 'multiset',
  'playback', 'record', 'record_session', 'say', 'speak',
  'lua', 'socket', 'play_and_get_digits',
  'conference',
  'log',
];

const EXPECTED_FIELDS = [
  'destination_number', 'caller_id_number', 'caller_id_name',
  'network_addr', 'sip_from_host', 'sip_to_host', 'context', 'username',
];

// ── knownApplicationNames / knownFieldNames ────────────────────────────────────

describe('knownApplicationNames', () => {
  it('contains all 20 approved applications', () => {
    const names = knownApplicationNames();
    for (const app of EXPECTED_APPLICATIONS) {
      expect(names).toContain(app);
    }
  });

  it('returns exactly 20 entries', () => {
    expect(knownApplicationNames()).toHaveLength(20);
  });
});

describe('knownFieldNames', () => {
  it('contains all 8 approved fields', () => {
    const names = knownFieldNames();
    for (const field of EXPECTED_FIELDS) {
      expect(names).toContain(field);
    }
  });

  it('returns exactly 8 entries', () => {
    expect(knownFieldNames()).toHaveLength(8);
  });
});

// ── lookupApplication ─────────────────────────────────────────────────────────

describe('lookupApplication', () => {
  it('returns a complete AppEntry for every catalogued application', () => {
    for (const name of EXPECTED_APPLICATIONS) {
      const entry = lookupApplication(name);
      expect(entry.name).toBe(name);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.category).toBe('string');
      expect(typeof entry.tooltip).toBe('string');
      expect(typeof entry.dataRequired).toBe('boolean');
      expect(typeof entry.dataDescription).toBe('string');
      expect(typeof entry.dataPlaceholder).toBe('string');
      expect(Array.isArray(entry.dataExamples)).toBe(true);
      expect(['low', 'medium', 'high']).toContain(entry.riskLevel);
      expect(typeof entry.deprecated).toBe('boolean');
      // replacedBy is null or string
      expect(entry.replacedBy === null || typeof entry.replacedBy === 'string').toBe(true);
    }
  });

  it('returns a generic fallback for an unknown application — never throws', () => {
    const entry = lookupApplication('unknown_application_xyz');
    expect(entry.name).toBe('unknown_application_xyz');
    expect(entry.label).toBe('unknown_application_xyz');
    expect(entry.category).toBe('Unknown');
    expect(entry.riskLevel).toBe('low');
    expect(entry.deprecated).toBe(false);
    expect(entry.replacedBy).toBeNull();
    expect(Array.isArray(entry.dataExamples)).toBe(true);
  });

  it('does not mutate the catalog — successive lookups return independent objects', () => {
    const a = lookupApplication('bridge');
    const b = lookupApplication('bridge');
    expect(a).not.toBe(b); // different object references
    expect(a).toEqual(b);  // same content
  });

  // Spot-check specific fields to catch future catalog regressions

  it('bridge: dataRequired=true, riskLevel=medium', () => {
    const entry = lookupApplication('bridge');
    expect(entry.dataRequired).toBe(true);
    expect(entry.riskLevel).toBe('medium');
  });

  it('answer: dataRequired=false, riskLevel=low', () => {
    const entry = lookupApplication('answer');
    expect(entry.dataRequired).toBe(false);
    expect(entry.riskLevel).toBe('low');
  });

  it('hangup: dataRequired=false, riskLevel=medium', () => {
    const entry = lookupApplication('hangup');
    expect(entry.dataRequired).toBe(false);
    expect(entry.riskLevel).toBe('medium');
  });

  it('lua: category=Scripting', () => {
    expect(lookupApplication('lua').category).toBe('Scripting');
  });

  it('conference: category=Conference', () => {
    expect(lookupApplication('conference').category).toBe('Conference');
  });

  it('log: category=Logging', () => {
    expect(lookupApplication('log').category).toBe('Logging');
  });
});

// ── lookupField ───────────────────────────────────────────────────────────────

describe('lookupField', () => {
  it('returns a complete FieldEntry for every catalogued field', () => {
    for (const name of EXPECTED_FIELDS) {
      const entry = lookupField(name);
      expect(entry.name).toBe(name);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.category).toBe('string');
      expect(Array.isArray(entry.examples)).toBe(true);
    }
  });

  it('returns a generic fallback for an unknown field — never throws', () => {
    const entry = lookupField('nonexistent_variable');
    expect(entry.name).toBe('nonexistent_variable');
    expect(entry.label).toBe('nonexistent_variable');
    expect(entry.category).toBe('Unknown');
    expect(Array.isArray(entry.examples)).toBe(true);
  });

  it('does not mutate the catalog', () => {
    const a = lookupField('destination_number');
    const b = lookupField('destination_number');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('destination_number: category=Routing', () => {
    expect(lookupField('destination_number').category).toBe('Routing');
  });

  it('sip_from_host: category=SIP', () => {
    expect(lookupField('sip_from_host').category).toBe('SIP');
  });

  it('network_addr: category=Network', () => {
    expect(lookupField('network_addr').category).toBe('Network');
  });

  it('username: category=Identity', () => {
    expect(lookupField('username').category).toBe('Identity');
  });
});

// ── applicationsByCategory ────────────────────────────────────────────────────

describe('applicationsByCategory', () => {
  it('returns an object with at least the expected categories', () => {
    const grouped = applicationsByCategory();
    expect(typeof grouped).toBe('object');
    const categories = Object.keys(grouped);
    expect(categories).toContain('Call Control');
    expect(categories).toContain('Variables');
    expect(categories).toContain('Media');
    expect(categories).toContain('Scripting');
    expect(categories).toContain('IVR');
    expect(categories).toContain('Conference');
    expect(categories).toContain('Logging');
  });

  it('every entry in each group has a name property', () => {
    const grouped = applicationsByCategory();
    for (const [, entries] of Object.entries(grouped)) {
      for (const entry of entries) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('total entries across all groups equals catalog size', () => {
    const grouped = applicationsByCategory();
    const total = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(knownApplicationNames().length);
  });

  it('Call Control contains answer, bridge, transfer, execute_extension, hangup, park', () => {
    const grouped = applicationsByCategory();
    const names = grouped['Call Control'].map(e => e.name);
    expect(names).toContain('answer');
    expect(names).toContain('bridge');
    expect(names).toContain('transfer');
    expect(names).toContain('execute_extension');
    expect(names).toContain('hangup');
    expect(names).toContain('park');
  });
});

// ── fieldsByCategory ──────────────────────────────────────────────────────────

describe('fieldsByCategory', () => {
  it('returns an object with at least the expected categories', () => {
    const grouped = fieldsByCategory();
    expect(typeof grouped).toBe('object');
    const categories = Object.keys(grouped);
    expect(categories).toContain('Routing');
    expect(categories).toContain('Identity');
    expect(categories).toContain('Network');
    expect(categories).toContain('SIP');
  });

  it('total entries across all groups equals catalog size', () => {
    const grouped = fieldsByCategory();
    const total = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(knownFieldNames().length);
  });

  it('every entry has a name property', () => {
    const grouped = fieldsByCategory();
    for (const [, entries] of Object.entries(grouped)) {
      for (const entry of entries) {
        expect(typeof entry.name).toBe('string');
      }
    }
  });
});
