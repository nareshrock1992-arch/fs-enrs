/**
 * Recordings list — list, total and summary share ONE filter definition.
 * Regression: the count used to ignore recording_file in `search`, so totals
 * and paging disagreed with the rows whenever a user searched by filename.
 * The pool is mocked; queries are captured and checked structurally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 42 }] };
    if (/GROUP BY r\.status/.test(sql)) return { rows: [{ status: 'COMPLETED', n: 40 }, { status: 'ARCHIVED', n: 2 }] };
    if (/GROUP BY r\.recording_type/.test(sql)) return { rows: [{ recording_type: 'ERS', n: 42 }, { recording_type: 'ENS', n: 7 }] };
    return { rows: [{ id: 1 }] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));
// The REAL tenantScope is used: tenant scoping is part of what this file proves.

const { listRecordings, buildRecordingFilter } = await import('../../controllers/recordingController.js');

const run = async (query, user = { role: 'ADMIN', tenantId: 3 }) => {
  calls.length = 0;
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await listRecordings({ query, user }, res, (e) => { throw e; });
  return res.json.mock.calls[0][0];
};
const whereOf = (sql) => sql.slice(sql.indexOf('WHERE')).replace(/\s+/g, ' ').replace(/ORDER BY.*|GROUP BY.*/, '').trim();

describe('recordings list / total / summary consistency', () => {
  beforeEach(() => { calls.length = 0; });

  it('the total uses exactly the same WHERE clause and parameters as the list (incl. filename search)', async () => {
    await run({ search: 'conf_2026', status: 'COMPLETED', date_from: '2026-10-01' });
    const list = calls[0], count = calls[1];
    expect(whereOf(list.sql)).toBe(whereOf(count.sql));
    expect(list.params.slice(0, count.params.length)).toEqual(count.params);
    expect(whereOf(count.sql)).toMatch(/r\.recording_file ILIKE/);       // the old count lacked this
  });

  it('returns a summary across the whole filtered set, not the loaded page', async () => {
    const body = await run({ recording_type: 'ERS', limit: '25' });
    expect(body.total).toBe(42);
    expect(body.summary).toEqual({ by_status: { COMPLETED: 40, ARCHIVED: 2 }, by_type: { ERS: 42, ENS: 7 }, all_types_total: 49 });
  });

  it('type tabs are counted without the type filter but with every other filter', async () => {
    await run({ recording_type: 'ERS', search: 'x' });
    const typeQ = calls.find((c) => /GROUP BY r\.recording_type/.test(c.sql));
    expect(typeQ.sql).not.toMatch(/r\.recording_type = \$/);
    expect(typeQ.sql).toMatch(/r\.notes ILIKE/);
  });

  it('tenant scoping: a tenant user is always scoped; SUPER_ADMIN only when tenant_id is given', () => {
    expect(buildRecordingFilter({ query: {}, user: { role: 'ADMIN', tenantId: 3 } }).params).toEqual([3]);
    expect(buildRecordingFilter({ query: { tenant_id: '9' }, user: { role: 'ADMIN', tenantId: 3 } }).params).toEqual([3]);
    expect(buildRecordingFilter({ query: {}, user: { role: 'SUPER_ADMIN' } }).params).toEqual([]);
    expect(buildRecordingFilter({ query: { tenant_id: '9' }, user: { role: 'SUPER_ADMIN' } }).params).toEqual([9]);
  });

  it('fails closed: no tenant → 403, malformed SUPER_ADMIN tenant_id → 400 (never "all tenants")', () => {
    for (const user of [{ role: 'ADMIN', tenantId: null }, { role: 'OPERATOR' }, { role: 'ADMIN', tenantId: '' }]) {
      expect(() => buildRecordingFilter({ query: {}, user })).toThrow(expect.objectContaining({ status: 403 }));
    }
    for (const tenant_id of ['abc', '0', '-1', '1.5']) {
      expect(() => buildRecordingFilter({ query: { tenant_id }, user: { role: 'SUPER_ADMIN' } })).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it('ignores empty filters and keeps parameters positional and in order', () => {
    const f = buildRecordingFilter({ query: { status: '', search: 'a', tag: 'b' }, user: { role: 'SUPER_ADMIN' } });
    expect(f.params).toEqual(['b', 'a']);
    expect(f.where).toMatch(/\$1::text = ANY\(r\.tags\)/);
    expect(f.where).toMatch(/r\.notes ILIKE '%' \|\| \$2::text/);
    expect(f.where).not.toMatch(/r\.status/);
  });

  it('limit is capped at 100 and page/offset are applied after the filter parameters', async () => {
    const body = await run({ limit: '5000', page: '3', status: 'COMPLETED' });
    expect(body.limit).toBe(100);
    expect(calls[0].params.slice(-2)).toEqual([100, 200]);
  });
});
