import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { can, visibleNav } from '../auth/permissions.js';
import { NAV } from '../components/layout/navigation.js';
import {
  COLUMNS, DEFAULT_PREFS, PAGE_SIZES, prefsKey, loadPrefs, savePrefs, choosableColumns, visibleColumns,
  toggleColumn, nextSort, ariaSort, buildQuery, hasActiveFilters, EMPTY_FILTERS, cellText,
  IMPORT_COLUMNS, importTemplate, importIssueText, orgLabel,
} from '../pages/contacts/contactTable.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const throwingStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

describe('contacts access follows the server routes (D5)', () => {
  const links = (role) => visibleNav(NAV, { role }).flatMap(n => (n.children ? n.children.map(c => c.to) : [n.to]));
  it('the menu offers Emergency Contacts only to roles the list API accepts', () => {
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'OPERATOR']) expect(links(role), role).toContain('/contacts');
    for (const role of ['SUPERVISOR', 'VIEWER']) expect(links(role), role).not.toContain('/contacts');
  });
  it('only SUPER_ADMIN and ADMIN may change contacts', () => {
    expect(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'].filter(role => can({ role }, 'contacts.edit')))
      .toEqual(['SUPER_ADMIN', 'ADMIN']);
  });
});

describe('column preferences', () => {
  it('defaults to the previous columns (Name, Mobile, Role, Organization) plus Tenant when offered', () => {
    expect(visibleColumns(DEFAULT_PREFS, false).map(c => c.label)).toEqual(['Name', 'Mobile', 'Role', 'Organization']);
    expect(visibleColumns(DEFAULT_PREFS, true).map(c => c.label)).toEqual(['Name', 'Mobile', 'Role', 'Organization', 'Tenant']);
  });

  it('Name cannot be hidden; Tenant is offered only to SUPER_ADMIN under All Tenants', () => {
    expect(choosableColumns(false).map(c => c.key)).not.toContain('name');
    expect(choosableColumns(false).map(c => c.key)).not.toContain('tenant');
    expect(choosableColumns(true).map(c => c.key)).toContain('tenant');
    expect(visibleColumns({ columns: [] }, true).map(c => c.key)).toEqual(['name']);
  });

  it('toggling keeps the fixed column order', () => {
    let p = toggleColumn(DEFAULT_PREFS, 'email');
    p = toggleColumn(p, 'mobile');
    expect(p.columns).toEqual(['email', 'role', 'organization', 'tenant']);
    expect(visibleColumns(p, false).map(c => c.key)).toEqual(['name', 'email', 'role', 'organization']);
  });

  it('are saved per user and survive a reload', () => {
    const s = memoryStorage();
    savePrefs(s, 7, { columns: ['email', 'status'], pageSize: 100 });
    expect(s.m.has(prefsKey(7))).toBe(true);
    expect(loadPrefs(s, 7)).toEqual({ columns: ['email', 'status'], pageSize: 100 });
    expect(loadPrefs(s, 8)).toEqual(DEFAULT_PREFS);
  });

  it('fall back to defaults for unknown columns, odd page sizes, bad JSON or blocked storage', () => {
    const s = memoryStorage();
    s.setItem(prefsKey(1), JSON.stringify({ columns: ['email', 'password_hash'], pageSize: 7 }));
    expect(loadPrefs(s, 1)).toEqual({ columns: ['email'], pageSize: 50 });
    s.setItem(prefsKey(2), '{not json');
    expect(loadPrefs(s, 2)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(throwingStorage, 3)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(throwingStorage, 3, DEFAULT_PREFS)).not.toThrow();
    expect(loadPrefs(null, 3)).toEqual(DEFAULT_PREFS);
    expect(PAGE_SIZES).toContain(DEFAULT_PREFS.pageSize);
  });
});

describe('sorting', () => {
  it('cycles none → ascending → descending → none, and a new column starts ascending', () => {
    let s = nextSort(null, 'role');
    expect(s).toEqual({ key: 'role', dir: 'asc' });
    expect(ariaSort(s, 'role')).toBe('ascending');
    s = nextSort(s, 'role');
    expect(ariaSort(s, 'role')).toBe('descending');
    expect(ariaSort(s, 'name')).toBe('none');
    expect(nextSort(s, 'role')).toBeNull();
    expect(nextSort(s, 'email')).toEqual({ key: 'email', dir: 'asc' });
  });
  it('every column sorts by a key the server accepts', () => {
    const server = ['name', 'mobile', 'extension', 'email', 'role', 'organization', 'department', 'location', 'status', 'tenant', 'created_at', 'updated_at'];
    for (const c of COLUMNS) expect(server, c.key).toContain(c.sort);
  });
});

describe('query building', () => {
  it('leaves out empty filters and trims the search', () => {
    expect(buildQuery({ filters: EMPTY_FILTERS, search: '  ' })).toEqual({});
    expect(buildQuery({
      filters: { ...EMPTY_FILTERS, organization_id: '3', is_active: 'false' },
      search: ' ann ', sort: { key: 'role', dir: 'desc' }, page: 2, pageSize: 100,
    })).toEqual({ organization_id: '3', is_active: 'false', search: 'ann', sort: 'role', dir: 'desc', page: 2, limit: 100 });
  });
  it('the export query has no page / limit (all matching rows)', () => {
    const q = buildQuery({ filters: { ...EMPTY_FILTERS, role: 'Medic' }, search: 'x' });
    expect(q).not.toHaveProperty('page');
    expect(q).not.toHaveProperty('limit');
  });
  it('knows when a filter or search is active', () => {
    expect(hasActiveFilters(EMPTY_FILTERS, '')).toBe(false);
    expect(hasActiveFilters(EMPTY_FILTERS, 'a')).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, location_id: '1' }, '')).toBe(true);
  });
});

describe('cells', () => {
  const r = { first_name: 'Ann', last_name: 'Zed', mobile_number: '+1', is_active: false, organization_name: 'Org', tenant_name: 'T' };
  it('renders text for every column', () => {
    expect(cellText('name', r)).toBe('Ann Zed');
    expect(cellText('status', r)).toBe('Inactive');
    expect(cellText('status', { ...r, is_active: true })).toBe('Active');
    expect(cellText('tenant', r)).toBe('T');
    expect(cellText('email', r)).toBe('');
  });
});

describe('CSV import help (D1, D2)', () => {
  it('documents exactly the columns the server reads', () => {
    expect(IMPORT_COLUMNS).toEqual(['first_name', 'last_name', 'mobile_number', 'extension_number', 'email', 'role', 'is_active']);
    expect(importTemplate().split('\r\n')[0]).toBe(IMPORT_COLUMNS.join(','));
    expect(importTemplate()).not.toMatch(/\bphone\b|\bpin\b/);
  });
  it('turns any row problem into one line of text (never an object)', () => {
    expect(importIssueText({ line: 4, error: 'mobile required' })).toBe('Line 4: mobile required');
    expect(importIssueText({ line: 2, reason: 'Contact already exists' })).toBe('Line 2: Contact already exists');
    expect(importIssueText({ line: 5, error: { nested: true } })).toBe('Line 5: {"nested":true}');
    expect(importIssueText('plain')).toBe('plain');
    expect(importIssueText(null)).toBe('');
  });
});

describe('SUPER_ADMIN target tenant (governance rule)', () => {
  it('organization options show their tenant under All Tenants only', () => {
    const org = { id: 1, name: 'HQ', tenant_name: 'Tenant B' };
    expect(orgLabel(org, true)).toBe('HQ — Tenant B');
    expect(orgLabel(org, false)).toBe('HQ');
    expect(orgLabel({ id: 2, name: 'No tenant name' }, true)).toBe('No tenant name');
    expect(orgLabel(null, true)).toBe('');
  });
});

describe('CSV upload carries the selected tenant (multipart)', () => {
  const store = new Map();
  const setUser = (user, tenant) => {
    store.set('enrs_user', JSON.stringify(user));
    if (tenant) store.set('enrs_active_tenant', JSON.stringify(tenant)); else store.delete('enrs_active_tenant');
  };
  let sent;
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { sent = init.body; return { ok: true, status: 200, json: async () => ({ inserted: 0 }) }; }));
  });
  afterEach(() => { vi.unstubAllGlobals(); store.clear(); sent = undefined; });

  it('SUPER_ADMIN with a tenant selected sends tenant_id; under All Tenants it does not', async () => {
    const { api } = await import('../api/client.js');
    setUser({ role: 'SUPER_ADMIN' }, { id: 7 });
    await api.contacts.bulkUpload(3, new Blob(['a']));
    expect(sent.get('tenant_id')).toBe('7');
    expect(sent.get('organization_id')).toBe('3');
    setUser({ role: 'SUPER_ADMIN' }, null);
    await api.contacts.bulkUpload(3, new Blob(['a']));
    expect(sent.get('tenant_id')).toBeNull();
  });

  it('a tenant ADMIN never sends a tenant_id (the server uses the token)', async () => {
    const { api } = await import('../api/client.js');
    setUser({ role: 'ADMIN' }, { id: 9 });
    await api.contacts.bulkUpload(3, new Blob(['a']));
    expect(sent.get('tenant_id')).toBeNull();
  });
});
