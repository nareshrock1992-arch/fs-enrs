import { describe, it, expect } from 'vitest';
import { createLatestGuard, ersSummary, ensSummary, loadErrorMessage, csvCell, csvLine } from '../pages/reports/reportState.js';
import { can, visibleNav } from '../auth/permissions.js';

describe('latest-request guard (stale responses never overwrite newer ones)', () => {
  it('only the most recent token is current', () => {
    const g = createLatestGuard();
    const a = g.next();
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it('a slow first request resolving after a fast second one is discarded', async () => {
    const g = createLatestGuard();
    const shown = [];
    const run = async (label, ms) => {
      const t = g.next();
      await new Promise(r => setTimeout(r, ms));
      if (g.isCurrent(t)) shown.push(label);
    };
    await Promise.all([run('old filter', 30), run('new filter', 5)]);
    expect(shown).toEqual(['new filter']);
  });
});

describe('report summaries come from the server (whole filtered set, not the page)', () => {
  it('ERS summary maps server fields; missing summary → null (no page-derived numbers)', () => {
    expect(ersSummary({ summary: { total: 120, active: 2, completed: 100, responders: 900, responders_answered: 450 } }))
      .toEqual({ total: 120, active: 2, completed: 100, responders: 900, answered: 450 });
    expect(ersSummary({ incidents: [{ status: 'ACTIVE' }] })).toBeNull();
  });
  it('ENS summary maps server fields and coerces bad values to 0', () => {
    expect(ensSummary({ summary: { total: '7', running: null, completed: 5, destinations: 70, destinations_answered: 'x' } }))
      .toEqual({ total: 7, running: 0, completed: 5, destinations: 70, answered: 0 });
    expect(ensSummary(undefined)).toBeNull();
  });
  it('load errors produce a message (the API text when present)', () => {
    expect(loadErrorMessage(new Error('from must be a date (YYYY-MM-DD)'))).toBe('from must be a date (YYYY-MM-DD)');
    expect(loadErrorMessage(undefined)).toBe('The report could not be loaded.');
  });
});

describe('CSV export cells', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('Plant, North')).toBe('"Plant, North"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvLine([1, 'x,y', null, undefined, 'ok'])).toBe('1,"x,y",,,ok');
  });
  it('neutralises spreadsheet formulas in text but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('navigation matches server permissions', () => {
  const NAV = [
    { label: 'Dashboard', to: '/' },
    { label: 'IVR Builder', children: [{ label: 'Media Library', to: '/media', capability: 'media.view' }] },
    { label: 'Reports', children: [
      { label: 'ERS Reports', to: '/reports/ers', capability: 'reports.view' },
      { label: 'Conference Recordings', to: '/recordings', capability: 'recordings.view' },
    ] },
    { label: 'Users', to: '/users', adminOnly: true },
    { label: 'Tenants', to: '/tenants', superAdminOnly: true },
  ];
  const labels = (role) => visibleNav(NAV, { role }).flatMap(n => [n.label, ...(n.children || []).map(c => c.label)]);

  it('reports.view mirrors adminOrOp (SUPER_ADMIN, ADMIN, OPERATOR)', () => {
    expect(['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER'].map(r => can({ role: r }, 'reports.view')))
      .toEqual([true, true, true, false, false]);
  });
  it('VIEWER sees no Reports group and no Media Library (both would be 403)', () => {
    expect(labels('VIEWER')).toEqual(['Dashboard']);
  });
  it('SUPERVISOR sees Media Library but no Reports', () => {
    expect(labels('SUPERVISOR')).toEqual(['Dashboard', 'IVR Builder', 'Media Library']);
  });
  it('OPERATOR sees reports and recordings; ADMIN also users; SUPER_ADMIN everything', () => {
    expect(labels('OPERATOR')).toEqual(['Dashboard', 'IVR Builder', 'Media Library', 'Reports', 'ERS Reports', 'Conference Recordings']);
    expect(labels('ADMIN')).toContain('Users');
    expect(labels('ADMIN')).not.toContain('Tenants');
    expect(labels('SUPER_ADMIN')).toContain('Tenants');
  });
});
