/**
 * Media Library list — the page, the totals and the category breakdown share ONE
 * filter definition, pagination input can never reach SQL malformed, and the
 * response stays backwards compatible for the IVR / ENS media pickers.
 * The pool is mocked: queries are captured and checked structurally. This does
 * NOT prove the SQL runs on a real PostgreSQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let totalsRow = { total: 12, deployed: 9, pending: 3, size_bytes: '123456789', duration_sec: '61.505' };
let catRows   = [{ category: 'general', n: 7 }, { category: 'ivr', n: 5 }];
let failWith  = null;
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (failWith) throw failWith;
    if (/AS total/.test(sql))               return { rows: [totalsRow] };
    if (/GROUP BY m\.category/.test(sql))   return { rows: catRows };
    return { rows: [{ id: 1, name: 'a.wav' }] };
  }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const { listMedia, buildMediaFilter, normalizeMediaPaging, MEDIA_MAX_LIMIT } =
  await import('../../controllers/mediaLibraryController.js');

const TENANT_USER = { role: 'ADMIN', tenantId: 3 };
const run = async (query, user = TENANT_USER) => {
  calls.length = 0;
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  const next = vi.fn();
  await listMedia({ query, user }, res, next);
  return { body: res.json.mock.calls[0]?.[0], next };
};
const listQ   = () => calls.find(c => /LIMIT \$\d+ OFFSET \$\d+/.test(c.sql));
const totalsQ = () => calls.find(c => /AS total/.test(c.sql));
const catQ    = () => calls.find(c => /GROUP BY m\.category/.test(c.sql));
// The main WHERE (after FROM) — the totals query also contains `FILTER (WHERE …)`.
const whereOf = (sql) => sql.slice(sql.indexOf('WHERE', sql.indexOf('FROM media_files m'))).replace(/\s+/g, ' ')
  .replace(/ ORDER BY.*| GROUP BY.*/, '').trim();

beforeEach(() => {
  calls.length = 0; failWith = null;
  totalsRow = { total: 12, deployed: 9, pending: 3, size_bytes: '123456789', duration_sec: '61.505' };
  catRows   = [{ category: 'general', n: 7 }, { category: 'ivr', n: 5 }];
});

describe('list / totals / category breakdown consistency', () => {
  it('list and totals use exactly the same WHERE clause and parameters', async () => {
    await run({ search: 'welcome', category: 'ivr', deployed: 'true' });
    expect(whereOf(listQ().sql)).toBe(whereOf(totalsQ().sql));
    expect(listQ().params.slice(0, totalsQ().params.length)).toEqual(totalsQ().params);
    expect(totalsQ().params).toEqual([3, 'ivr', 'welcome', true]);
  });

  it('the category breakdown ignores the category filter but keeps every other filter', async () => {
    await run({ search: 'welcome', category: 'ivr', deployed: 'false' });
    expect(catQ().sql).not.toMatch(/m\.category = \$/);
    expect(catQ().params).toEqual([3, 'welcome', false]);
    expect(catQ().sql).toMatch(/m\.tenant_id = \$1::int/);
    expect(catQ().sql).toMatch(/m\.is_deployed = \$3::boolean/);
  });

  it('every query excludes soft-deleted rows', async () => {
    await run({});
    for (const c of calls) expect(c.sql).toMatch(/m\.deleted_at IS NULL/);
  });

  it('runs exactly three queries per request (no N+1)', async () => {
    await run({ search: 'x' });
    expect(calls).toHaveLength(3);
  });
});

describe('summary', () => {
  it('reports totals over the whole filtered set, converting pg string types', async () => {
    const { body } = await run({ limit: '30' });
    expect(body.summary).toEqual({
      total: 12, deployed: 9, pending: 3, size_bytes: 123456789, duration_sec: 61.51,
      by_category: { general: 7, ivr: 5 },
    });
    expect(body.total).toBe(body.summary.total);          // one source of truth
  });

  it('aggregates deployed / pending / size / duration in SQL with NULLs counted as 0', async () => {
    await run({});
    const sql = totalsQ().sql;
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE m\.is_deployed\)/);
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE NOT m\.is_deployed\)/);
    expect(sql).toMatch(/COALESCE\(SUM\(m\.size_bytes\), 0\)/);
    expect(sql).toMatch(/COALESCE\(SUM\(m\.duration_sec\), 0\)/);
  });

  it('empty result → valid zero summary and empty breakdown', async () => {
    totalsRow = { total: 0, deployed: 0, pending: 0, size_bytes: '0', duration_sec: '0' };
    catRows = [];
    const { body } = await run({ search: 'nothing-matches' });
    expect(body).toMatchObject({ files: expect.any(Array), total: 0 });
    expect(body.summary).toEqual({ total: 0, deployed: 0, pending: 0, size_bytes: 0, duration_sec: 0, by_category: {} });
  });
});

describe('tenant scoping (unchanged behaviour)', () => {
  it('a tenant user is always scoped to their tenant; ?tenant_id is ignored', () => {
    expect(buildMediaFilter({ query: { tenant_id: '9' }, user: TENANT_USER }).params).toEqual([3]);
  });
  it('SUPER_ADMIN: all tenants by default, one tenant when ?tenant_id is given', () => {
    expect(buildMediaFilter({ query: {}, user: { role: 'SUPER_ADMIN' } }).params).toEqual([]);
    expect(buildMediaFilter({ query: { tenant_id: '9' }, user: { role: 'SUPER_ADMIN' } }).params).toEqual([9]);
  });
  it('tenant scope is applied to all three queries', async () => {
    await run({}, { role: 'OPERATOR', tenantId: 5 });
    for (const c of calls) expect(c.params[0]).toBe(5);
  });
});

describe('search / filters', () => {
  it('search matches name, description or an exact tag, all bound to ONE parameter', () => {
    const f = buildMediaFilter({ query: { search: 'greet' }, user: { role: 'SUPER_ADMIN' } });
    expect(f.params).toEqual(['greet']);
    expect(f.where).toMatch(/m\.name ILIKE '%' \|\| \$1::text \|\| '%'/);
    expect(f.where).toMatch(/m\.description ILIKE '%' \|\| \$1::text \|\| '%'/);
    expect(f.where).toMatch(/\$1::text = ANY\(m\.tags\)/);
  });
  it('% and _ keep their existing LIKE wildcard meaning (not escaped) and stay parameterised', () => {
    for (const s of ['50%', 'a_b', "x'; DROP TABLE media_files; --"]) {
      const f = buildMediaFilter({ query: { search: s }, user: { role: 'SUPER_ADMIN' } });
      expect(f.params).toEqual([s]);                       // passed verbatim as a bind value
      expect(f.where).not.toContain(s);                     // never interpolated into SQL
    }
  });
  it('deployed: "true" → true, any other non-empty value → false, empty/absent → no filter', () => {
    const p = (deployed) => buildMediaFilter({ query: { deployed }, user: { role: 'SUPER_ADMIN' } }).params;
    expect(p('true')).toEqual([true]);
    expect(p('false')).toEqual([false]);
    expect(p('yes')).toEqual([false]);                     // unchanged legacy semantics
    expect(p('')).toEqual([]);
    expect(p(undefined)).toEqual([]);
  });
  it('empty-ish values ("", "undefined", "null") are treated as no filter', () => {
    const f = buildMediaFilter({ query: { search: 'undefined', category: 'null', deployed: '' }, user: { role: 'SUPER_ADMIN' } });
    expect(f.params).toEqual([]);
  });
});

describe('pagination normalisation', () => {
  it.each([
    [{},                              { page: 1, limit: 50, offset: 0 }],
    [{ limit: '-5' },                 { page: 1, limit: 50, offset: 0 }],     // previously reached SQL → 500
    [{ limit: '0' },                  { page: 1, limit: 50, offset: 0 }],
    [{ limit: '1000' },               { page: 1, limit: MEDIA_MAX_LIMIT, offset: 0 }],
    [{ limit: '2.9', page: '3.7' },   { page: 3, limit: 2, offset: 4 }],     // truncated
    [{ limit: '0.5' },                { page: 1, limit: 50, offset: 0 }],     // < 1 after truncation
    [{ limit: 'abc', page: 'x' },     { page: 1, limit: 50, offset: 0 }],
    [{ page: '-2' },                  { page: 1, limit: 50, offset: 0 }],
    [{ page: '1e20' },                { page: 1_000_000, limit: 50, offset: 49_999_950 }],
    [{ page: ['2', '3'] },            { page: 1, limit: 50, offset: 0 }],     // repeated query param
    [{ page: '2', limit: '30' },      { page: 2, limit: 30, offset: 30 }],
  ])('%j → %j', (q, expected) => {
    expect(normalizeMediaPaging(q)).toEqual(expected);
  });

  it('LIMIT/OFFSET are always bound as integers after the filter params, and echoed back normalised', async () => {
    const { body } = await run({ limit: '-5', page: 'abc', category: 'ivr' });
    expect(listQ().params.slice(-2)).toEqual([50, 0]);
    expect(Number.isInteger(listQ().params.at(-1))).toBe(true);
    expect(body).toMatchObject({ page: 1, limit: 50 });
  });
});

describe('sorting', () => {
  it('only allow-listed fields reach ORDER BY; anything else falls back to created_at', async () => {
    await run({ sort: 'name; DROP TABLE media_files', dir: 'asc' });
    expect(listQ().sql).toMatch(/ORDER BY m\.created_at ASC NULLS LAST, m\.id ASC/);
    expect(listQ().sql).not.toMatch(/DROP/);
  });
  it.each(['name', 'category', 'created_at', 'size_bytes', 'duration_sec'])('sort=%s is honoured', async (s) => {
    await run({ sort: s });
    expect(listQ().sql).toMatch(new RegExp(`ORDER BY m\\.${s} DESC NULLS LAST, m\\.id DESC`));
  });
  it('dir is ASC only for "asc"; anything else is DESC (never interpolated raw)', async () => {
    await run({ sort: 'name', dir: 'asc; DELETE' });
    expect(listQ().sql).toMatch(/ORDER BY m\.name DESC NULLS LAST, m\.id DESC/);
  });
  it('a unique tie-breaker (m.id) makes paging deterministic for equal sort values', async () => {
    await run({ sort: 'category' });
    expect(listQ().sql).toMatch(/, m\.id DESC\s+LIMIT/);
  });
});

describe('compatibility', () => {
  it('keeps every existing response field (files, total, page, limit) and only adds summary', async () => {
    const { body } = await run({});
    expect(Object.keys(body).sort()).toEqual(['files', 'limit', 'page', 'summary', 'total']);
    expect(body.files).toEqual([{ id: 1, name: 'a.wav' }]);
  });
  it('IVR / ENS picker request (search, limit 30, deployed=true) behaves as before', async () => {
    const { body } = await run({ search: 'greet', limit: '30', deployed: 'true' }, { role: 'SUPERVISOR', tenantId: 3 });
    expect(body).toMatchObject({ page: 1, limit: 30 });
    expect(listQ().params).toEqual([3, 'greet', true, 30, 0]);
    expect(listQ().sql).toMatch(/ORDER BY m\.created_at DESC/);           // default order unchanged
  });
  it('still returns the columns existing UI code reads (incl. path fields — contract unchanged in Phase C)', async () => {
    await run({});
    for (const col of ['m.is_deployed', 'm.fs_path', 'm.path_or_uri', 'm.duration_sec', 'm.size_bytes']) {
      expect(listQ().sql).toContain(col);
    }
  });
});

describe('errors', () => {
  it('a database error is passed to next() (errorHandler) and no partial response is sent', async () => {
    failWith = Object.assign(new Error('boom'), { code: '57014' });
    const { body, next } = await run({});
    expect(body).toBeUndefined();
    expect(next).toHaveBeenCalledWith(failWith);
  });
});
