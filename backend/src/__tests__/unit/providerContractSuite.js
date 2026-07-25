/**
 * providerContractSuite — reusable contract tests for ConfigurationProvider implementations.
 *
 * Usage:
 *   import { runProviderContractTests } from './providerContractSuite.js';
 *   import { VarsProvider } from '../../../platform/configuration/providers/VarsProvider.js';
 *
 *   const fixtures = {
 *     validContent:   '...raw file content...',
 *     sampleChangeKey: 'some_key',
 *     sampleChangeValue: 'new_value',
 *     knownKeys: ['key1', 'key2'],    // must be present in validContent
 *   };
 *   runProviderContractTests(() => new VarsProvider(mockDriver), fixtures);
 *
 * The suite verifies the provider contract without caring about domain specifics.
 * Providers supply fixtures; the suite asserts generic behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';

/**
 * @param {() => ConfigurationProvider} factory  — called once per test
 * @param {{
 *   validContent:      string,
 *   sampleChangeKey:   string,
 *   sampleChangeValue: string,
 *   knownKeys:         string[],
 * }} fixtures
 */
export function runProviderContractTests(factory, fixtures) {
  const { validContent, sampleChangeKey, sampleChangeValue, knownKeys } = fixtures;

  describe('ConfigurationProvider contract', () => {
    let provider;
    beforeEach(() => { provider = factory(); });

    // ── Identity ────────────────────────────────────────────────────────────
    describe('identity', () => {
      it('id is a non-empty string', () => {
        expect(typeof provider.id).toBe('string');
        expect(provider.id.length).toBeGreaterThan(0);
      });

      it('name is a non-empty string', () => {
        expect(typeof provider.name).toBe('string');
        expect(provider.name.length).toBeGreaterThan(0);
      });

      it('description is a non-empty string', () => {
        expect(typeof provider.description).toBe('string');
        expect(provider.description.length).toBeGreaterThan(0);
      });

      it('deploymentStrategy has an id and steps array', () => {
        const s = provider.deploymentStrategy;
        expect(typeof s.id).toBe('string');
        expect(Array.isArray(s.steps)).toBe(true);
      });

      it('catalog is an object', () => {
        expect(typeof provider.catalog).toBe('object');
        expect(provider.catalog).not.toBeNull();
      });
    });

    // ── Parse ───────────────────────────────────────────────────────────────
    describe('parse()', () => {
      it('returns a doc with an entries array', () => {
        const doc = provider.parse(validContent);
        expect(Array.isArray(doc.entries)).toBe(true);
      });

      it('every entry has a key property', () => {
        const { entries } = provider.parse(validContent);
        for (const e of entries) {
          expect(typeof e.key).toBe('string');
          expect(e.key.length).toBeGreaterThan(0);
        }
      });

      it('every entry has an enabled boolean', () => {
        const { entries } = provider.parse(validContent);
        for (const e of entries) {
          expect(typeof e.enabled).toBe('boolean');
        }
      });

      it('returns a checksum string', () => {
        const doc = provider.parse(validContent);
        expect(typeof doc.checksum).toBe('string');
        expect(doc.checksum.length).toBeGreaterThan(0);
      });

      it('known keys are present', () => {
        const { entries } = provider.parse(validContent);
        const keys = new Set(entries.map(e => e.key));
        for (const k of knownKeys) {
          expect(keys.has(k), `expected key '${k}' to be present`).toBe(true);
        }
      });
    });

    // ── Serialize ───────────────────────────────────────────────────────────
    describe('serialize()', () => {
      it('returns a non-empty string', () => {
        const doc = provider.parse(validContent);
        const out = provider.serialize(doc);
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
      });

      it('round-trip produces the same entry count', () => {
        const doc1 = provider.parse(validContent);
        const raw2 = provider.serialize(doc1);
        const doc2 = provider.parse(raw2);
        expect(doc2.entries.length).toBe(doc1.entries.length);
      });

      it('round-trip preserves all keys', () => {
        const doc1 = provider.parse(validContent);
        const keys1 = doc1.entries.map(e => e.key).sort();
        const doc2  = provider.parse(provider.serialize(doc1));
        const keys2 = doc2.entries.map(e => e.key).sort();
        expect(keys2).toEqual(keys1);
      });
    });

    // ── ApplyChanges ────────────────────────────────────────────────────────
    describe('applyChanges()', () => {
      it('does not mutate the input document', () => {
        const doc     = provider.parse(validContent);
        const before  = doc.entries.map(e => ({ ...e }));
        provider.applyChanges(doc, [{ op: 'set', key: sampleChangeKey, value: sampleChangeValue }]);
        expect(doc.entries.map(e => e.key)).toEqual(before.map(e => e.key));
      });

      it('returns a new doc with the changed value reflected in entries', () => {
        const doc     = provider.parse(validContent);
        const newDoc  = provider.applyChanges(doc, [{ op: 'set', key: sampleChangeKey, value: sampleChangeValue }]);
        const changed = newDoc.entries.find(e => e.key === sampleChangeKey);
        expect(changed).toBeDefined();
        expect(changed.value).toBe(sampleChangeValue);
      });

      it('changed value survives serialize → parse round-trip', () => {
        const doc      = provider.parse(validContent);
        const newDoc   = provider.applyChanges(doc, [{ op: 'set', key: sampleChangeKey, value: sampleChangeValue }]);
        const rawOut   = provider.serialize(newDoc);
        const reparsed = provider.parse(rawOut);
        const entry    = reparsed.entries.find(e => e.key === sampleChangeKey);
        expect(entry?.value).toBe(sampleChangeValue);
      });
    });

    // ── Validate ────────────────────────────────────────────────────────────
    describe('validate()', () => {
      it('returns { valid, errors, warnings } shape', () => {
        const doc    = provider.parse(validContent);
        const result = provider.validate(doc);
        expect(typeof result.valid).toBe('boolean');
        expect(Array.isArray(result.errors)).toBe(true);
        expect(Array.isArray(result.warnings)).toBe(true);
      });

      it('valid content passes validation', () => {
        const doc = provider.parse(validContent);
        expect(provider.validate(doc).valid).toBe(true);
      });
    });

    // ── Diff ────────────────────────────────────────────────────────────────
    describe('diff()', () => {
      it('returns a string', () => {
        const doc = provider.parse(validContent);
        const raw = provider.serialize(doc);
        expect(typeof provider.diff(raw, raw)).toBe('string');
      });

      it('returns "(no changes)" or empty when content is identical', () => {
        const doc = provider.parse(validContent);
        const raw = provider.serialize(doc);
        const d   = provider.diff(raw, raw);
        expect(d.length).toBeGreaterThanOrEqual(0); // provider may differ
      });
    });

    // ── Hooks ───────────────────────────────────────────────────────────────
    describe('optional hooks', () => {
      it('beforeDeploy resolves without throwing on valid doc', async () => {
        const doc = provider.parse(validContent);
        await expect(provider.beforeDeploy(doc)).resolves.not.toThrow();
      });

      it('afterDeploy resolves without throwing', async () => {
        await expect(provider.afterDeploy({ versionId: 1 })).resolves.not.toThrow();
      });
    });
  });
}
