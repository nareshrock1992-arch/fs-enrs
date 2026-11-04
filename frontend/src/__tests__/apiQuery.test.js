import { describe, it, expect } from 'vitest';
import { qs } from '../api/client.js';

describe('query strings', () => {
  it('leaves unset filters out instead of sending "undefined"', () => {
    expect(String(qs({ status: undefined, page: 1, limit: 20 }))).toBe('page=1&limit=20');
    expect(String(qs({ q: '', org: null, tenant_id: 0 }))).toBe('q=&tenant_id=0');   // '' is sent, as before
    expect(String(qs())).toBe('');
  });
  it('keeps real values, including false and zero', () => {
    expect(String(qs({ active: false, n: 0, s: 'a b' }))).toBe('active=false&n=0&s=a+b');
  });
  it('passes an existing URLSearchParams through', () => {
    const p = new URLSearchParams('a=1');
    expect(qs(p)).toBe(p);
  });
});
