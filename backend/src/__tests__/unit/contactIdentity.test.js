/**
 * Contact identity rules (services/contactIdentity.js) — pure functions.
 *
 *  CI-U1 extension normalisation (NULL, empty, whitespace, punctuation, case)
 *  CI-U2 mobile normalisation (NULL, empty, punctuation, 00 → +, local ≠ international)
 *  CI-U3 classification: new / update / other organization / conflict (never merged)
 *  CI-U4 recipient de-duplication (first kept, order kept, numberless kept)
 *  CI-U5 masking and unique-violation detection
 *  CI-U6 broadcast-users legacy last-9-digit match keeps country codes significant
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeExtension, normalizeMobile, dialKey, maskIdentifier, classifyIdentity,
  isIdentityViolation, uniqueByDialTarget, legacyMobileMatch, OTHER_ORG_MESSAGE, CONFLICT_MESSAGE,
} from '../../services/contactIdentity.js';

describe('CI-U1: extension normalisation', () => {
  it.each([
    [null, null], [undefined, null], ['', null], ['   ', null], ['-', null], ['( )', null],
    ['1001', '1001'], [' 1001 ', '1001'], ['10 01', '1001'], ['10-01', '1001'], ['(10).01', '1001'],
    ['Ab12', 'ab12'], ['AB-12', 'ab12'], [1001, '1001'], ['\t1001\n', '1001'],
  ])('%j → %j', (input, expected) => expect(normalizeExtension(input)).toBe(expected));
});

describe('CI-U2: mobile normalisation', () => {
  it.each([
    [null, null], [undefined, null], ['', null], ['   ', null], ['+', null], ['()-', null], ['abc', null],
    ['0501234567', '0501234567'], ['050-123-4567', '0501234567'], ['050 123 4567', '0501234567'],
    ['+966 50 123 4567', '+966501234567'], ['+966-50-123-4567', '+966501234567'], ['(+966) 501234567', '+966501234567'],
    ['00966501234567', '+966501234567'], ['00 966 50 123 4567', '+966501234567'],
    ['966501234567', '966501234567'], ['9+66', '966'], ['++966', '+966'], [966501234567, '966501234567'],
  ])('%j → %j', (input, expected) => expect(normalizeMobile(input)).toBe(expected));

  it('local, national and international forms stay different identities (no guessing of country codes)', () => {
    const forms = ['0501234567', '+966501234567', '966501234567', '501234567'].map(normalizeMobile);
    expect(new Set(forms).size).toBe(4);
  });
});

describe('CI-U3: classification', () => {
  const A = { id: 1, organization_id: 10 };
  const B = { id: 2, organization_id: 10 };
  const X = { id: 3, organization_id: 99 };

  it('no match → new', () => {
    expect(classifyIdentity({ byExtension: null, byMobile: null }, 10)).toEqual({ kind: 'new' });
  });
  it('same organization → update, naming what matched', () => {
    expect(classifyIdentity({ byExtension: A, byMobile: null }, 10)).toEqual({ kind: 'update', contact: A, matchedBy: 'extension' });
    expect(classifyIdentity({ byExtension: null, byMobile: A }, 10)).toEqual({ kind: 'update', contact: A, matchedBy: 'mobile' });
    expect(classifyIdentity({ byExtension: A, byMobile: A }, 10)).toEqual({ kind: 'update', contact: A, matchedBy: 'both' });
  });
  it('another organization → other_organization (the contact itself is not returned)', () => {
    expect(classifyIdentity({ byExtension: X, byMobile: null }, 10)).toEqual({ kind: 'other_organization', field: 'extension' });
    expect(classifyIdentity({ byExtension: null, byMobile: X }, 10)).toEqual({ kind: 'other_organization', field: 'mobile' });
    expect(classifyIdentity({ byExtension: X, byMobile: X }, 10)).toEqual({ kind: 'other_organization', field: 'both' });
  });
  it('extension and mobile of two different contacts → conflict, never merged', () => {
    expect(classifyIdentity({ byExtension: A, byMobile: B }, 10)).toMatchObject({ kind: 'conflict', sameOrganization: true });
    expect(classifyIdentity({ byExtension: A, byMobile: X }, 10)).toMatchObject({ kind: 'conflict', sameOrganization: false });
    expect(classifyIdentity({ byExtension: X, byMobile: A }, 10)).toMatchObject({ kind: 'conflict', sameOrganization: false });
  });
  it('the messages never name another organization or contact', () => {
    for (const m of [...Object.values(OTHER_ORG_MESSAGE), CONFLICT_MESSAGE]) expect(m).not.toMatch(/\d/);
  });
});

describe('CI-U4: recipient de-duplication', () => {
  it('keeps the first item per normalised number, keeps order and numberless items', () => {
    const items = [
      { id: 1, n: '+966 50 123 4567' }, { id: 2, n: null }, { id: 3, n: '+966501234567' },
      { id: 4, n: '1001' }, { id: 5, n: '00966501234567' }, { id: 6, n: '' }, { id: 7, n: '10-01' },
    ];
    const { kept, dropped } = uniqueByDialTarget(items, (i) => i.n);
    expect(kept.map((i) => i.id)).toEqual([1, 2, 4, 6]);
    expect(dropped.map((i) => i.id)).toEqual([3, 5, 7]);
  });
  it('distinct numbers are all kept (nothing changes without duplicates)', () => {
    const items = ['0501', '0502', '1001', '+9665'].map((n, id) => ({ id, n }));
    expect(uniqueByDialTarget(items, (i) => i.n)).toEqual({ kept: items, dropped: [] });
  });
  it('dialKey treats an extension and the same digits as a mobile alike', () => {
    expect(dialKey('1001')).toBe(dialKey(' 10-01 '));
    expect(dialKey('sip-ab')).toBe('sipab');
  });
});

describe('CI-U5: masking and violation detection', () => {
  it('masks to the last three characters', () => {
    expect(maskIdentifier('+966501234567')).toBe('***567');
    expect(maskIdentifier(null)).toBeNull();
  });
  it('recognises only the identity unique indexes', () => {
    expect(isIdentityViolation({ code: '23505', constraint: 'uq_contacts_mobile_norm' })).toBe(true);
    expect(isIdentityViolation({ code: '23505', message: 'duplicate key value violates unique constraint "uq_contacts_extension_norm"' })).toBe(true);
    expect(isIdentityViolation({ code: '23505', constraint: 'users_email_key' })).toBe(false);
    expect(isIdentityViolation({ code: '23503', constraint: 'uq_contacts_mobile_norm' })).toBe(false);
    expect(isIdentityViolation(null)).toBe(false);
  });
});

describe('CI-U6: broadcast-users legacy match keeps country codes significant', () => {
  it.each([
    ['0501234567', '+966501234567', true],          // local ↔ international: the legacy case
    ['050-123-4567', '00966 50 123 4567', true],
    ['+966501234567', '0501234567', true],
    ['501234567', '+966501234567', true],           // 9 digits, no trunk prefix: local
    ['+966501234567', '966501234567', true],        // same digits, only the + differs
    ['+966 50 123 4567', '+966501234567', true],    // identical number
    ['+971501234567', '+966501234567', false],      // different country codes: never the same
    ['971501234567', '+966501234567', false],       // country code without +, still different
    ['+44 7501 234567', '+966501234567', false],
    ['0501234567', '0601234567', false],            // last 9 differ
    ['', '+966501234567', false], [null, '+966501234567', false], ['+966501234567', 'abc', false],
  ])('%j vs %j → %s', (stored, incoming, expected) => {
    expect(legacyMobileMatch(stored, incoming)).toBe(expected);
    expect(legacyMobileMatch(incoming, stored)).toBe(expected);
  });
});
