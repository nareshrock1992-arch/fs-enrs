import { describe, it, expect } from 'vitest';
import { auditActionLabel, auditSummary, detailEntries } from '../pages/admin/auditFormat.js';

describe('audit record formatting', () => {
  it('turns codes into readable labels and keeps acronyms', () => {
    expect(auditActionLabel('global_setting_changed')).toBe('Global setting changed');
    expect(auditActionLabel('ivr_flow_published')).toBe('IVR flow published');
    expect(auditActionLabel('conference')).toBe('Conference');
    expect(auditActionLabel('')).toBe('');
    expect(auditActionLabel(null)).toBe('');
  });
  it('lists details with tenant names when known, raw values otherwise', () => {
    const name = (id) => (String(id) === '3' ? 'Northwind' : undefined);
    expect(detailEntries({ tenant_id: 3, method: 'POST' }, name)).toEqual([['Tenant', 'Northwind (3)'], ['Method', 'POST']]);
    expect(detailEntries({ tenant_id: 9 }, name)).toEqual([['Tenant', '9']]);
    expect(detailEntries('{"key":"test_mode_enabled"}')).toEqual([['Setting', 'test_mode_enabled']]);
    expect(detailEntries('not json')).toEqual([['Value', 'not json']]);
    expect(detailEntries(null)).toEqual([]);
  });
  it('summarises at most four fields on one line', () => {
    expect(auditSummary({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('A: 1 · B: 2 · C: 3 · D: 4');
  });
});
