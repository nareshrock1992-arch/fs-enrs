/**
 * restoreMediaSafely — trash restore (Phase 4, docs/MEDIA_REPORTING_MISSION.md).
 * Fake pg client + fake fs. The real end-to-end path (PostgreSQL, real files,
 * quarantine round trip) is covered by the isolated e2e run (F-22…F-25, S-24).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../infrastructure/index.js', () => {
  const stub = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { forModule: () => stub, child: () => stub, ...stub } };
});
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getEnrsSoundDir: () => '/snd/enrs' },
}));
vi.mock('../../controllers/ivrTemplates.js', () => ({ BUILTIN_IVR_TEMPLATES: {} }));

const { restoreMediaSafely, MediaLockError } = await import('../../services/mediaDependencyService.js');

const SND = '/snd/enrs';
function setup({ rows, files = {}, quarantine = [], failCommit = false, clash = null }) {
  const media = rows.map(r => ({ ...r }));
  const disk = new Set(Object.keys(files));
  const qd = new Set(quarantine);
  const calls = [];
  const state = { locks: 0, released: null, committed: false };
  const client = {
    query: vi.fn(async (sql, p = []) => {
      calls.push({ sql, p });
      if (/pg_advisory_lock\(/.test(sql)) { state.locks++; return { rows: [] }; }
      if (/pg_advisory_unlock/.test(sql)) { state.locks--; return { rows: [{ ok: true }] }; }
      if (/^(SET|RESET|BEGIN|ROLLBACK)/.test(sql)) return { rows: [] };
      if (/^COMMIT/.test(sql)) { if (failCommit) throw new Error('commit failed'); state.committed = true; return { rows: [] }; }
      if (/FROM media_files WHERE id = \$1 AND deleted_at IS NOT NULL/.test(sql)) {
        return { rows: media.filter(m => String(m.id) === String(p[0]) && m.deleted_at && (p[1] == null || m.tenant_id === p[1])) };
      }
      if (/WHERE deleted_at IS NULL AND id <> \$1/.test(sql)) return { rows: clash ? [clash] : [] };
      if (/^UPDATE media_files SET deleted_at = NULL/.test(sql)) {
        const m = media.find(x => x.id === p[0]);
        m.deleted_at = null;
        if (!p[1]) { m.fs_path = null; m.is_deployed = false; }
        return { rows: [{ ...m }] };
      }
      if (/INSERT INTO audit_logs/.test(sql)) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
    release: vi.fn((d) => { state.released = d ?? 'ok'; }),
  };
  const fs = {
    stat: vi.fn(async (f) => { if (!disk.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => true }; }),
    readdir: vi.fn(async () => [...qd].map(f => f.split('/').pop())),
    rename: vi.fn(async (from, to) => {
      if (qd.has(from)) { qd.delete(from); disk.add(to); } else if (disk.has(from)) { disk.delete(from); qd.add(to); }
      else throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
  };
  const deps = { connect: async () => client, fs, fsPathService: { getEnrsSoundDir: () => SND } };
  return { media, disk, qd, calls, state, deps, fs };
}
const row = (o = {}) => ({ id: 7, tenant_id: 10, name: 'Prompt', path_or_uri: '/up/7_prompt.wav', fs_path: `${SND}/prompt.wav`, is_deployed: true, deleted_at: 'yesterday', ...o });

describe('restoreMediaSafely', () => {
  it('moves the NEWEST quarantined copy back, un-deletes, audits, releases the locks', async () => {
    const t = setup({ rows: [row()], quarantine: [`${SND}/.deleted/7_1000_prompt.wav`, `${SND}/.deleted/7_3000_prompt.wav`, `${SND}/.deleted/17_9000_prompt.wav`] });
    const r = await restoreMediaSafely({ id: 7, tenantId: 10, userId: 3 }, t.deps);
    expect(r.status).toBe('restored');
    expect(r.file).toEqual({ action: 'restored', from: `${SND}/.deleted/7_3000_prompt.wav` });
    expect(t.disk.has(`${SND}/prompt.wav`)).toBe(true);
    expect(t.qd.has(`${SND}/.deleted/17_9000_prompt.wav`)).toBe(true);      // other record's copy untouched
    expect(r.record).toMatchObject({ deleted_at: null, is_deployed: true, fs_path: `${SND}/prompt.wav` });
    const audit = t.calls.find(c => /INSERT INTO audit_logs/.test(c.sql));
    expect(audit.p.slice(0, 2)).toEqual([3, '7']);
    expect(t.state).toMatchObject({ locks: 0, committed: true, released: 'ok' });
  });
  it('no quarantined copy → restored as NOT deployed (redeploy from the upload copy)', async () => {
    const t = setup({ rows: [row()] });
    const r = await restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps);
    expect(r.status).toBe('restored');
    expect(r.file).toEqual({ action: 'none', reason: 'quarantine_missing' });
    expect(r.record).toMatchObject({ fs_path: null, is_deployed: false });
  });
  it('deployed copy still in place (was retained) → kept, nothing moved', async () => {
    const t = setup({ rows: [row()], files: { [`${SND}/prompt.wav`]: 1 } });
    const r = await restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps);
    expect(r.file.action).toBe('kept');
    expect(t.fs.rename).not.toHaveBeenCalled();
  });
  it('a live record already owns the filename → conflict, nothing changes; other tenant id is not revealed', async () => {
    const t = setup({ rows: [row()], quarantine: [`${SND}/.deleted/7_1_prompt.wav`], clash: { id: 99, tenant_id: 20 } });
    const r = await restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps);
    expect(r).toMatchObject({ status: 'conflict', conflictId: null });
    expect(t.fs.rename).not.toHaveBeenCalled();
    expect(t.media[0].deleted_at).toBe('yesterday');
    const own = setup({ rows: [row()], clash: { id: 98, tenant_id: 10 } });
    expect((await restoreMediaSafely({ id: 7, tenantId: 10 }, own.deps)).conflictId).toBe(98);
  });
  it('other tenant / live record / bad id → not_found', async () => {
    expect((await restoreMediaSafely({ id: 7, tenantId: 20 }, setup({ rows: [row()] }).deps)).status).toBe('not_found');
    expect((await restoreMediaSafely({ id: 7, tenantId: 10 }, setup({ rows: [row({ deleted_at: null })] }).deps)).status).toBe('not_found');
    expect((await restoreMediaSafely({ id: '7;drop', tenantId: 10 }, setup({ rows: [row()] }).deps)).status).toBe('not_found');
  });
  it('a failed COMMIT moves the file back into quarantine and releases the locks', async () => {
    const t = setup({ rows: [row()], quarantine: [`${SND}/.deleted/7_5_prompt.wav`], failCommit: true });
    await expect(restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps)).rejects.toThrow('commit failed');
    expect(t.disk.has(`${SND}/prompt.wav`)).toBe(false);
    expect(t.qd.has(`${SND}/.deleted/7_5_prompt.wav`)).toBe(true);
    expect(t.state.locks).toBe(0);
  });
  it('never moves files for a record whose deployed path is outside the ENRS sound dir', async () => {
    const t = setup({ rows: [row({ fs_path: '/etc/prompt.wav' })], quarantine: [`${SND}/.deleted/7_5_prompt.wav`] });
    const r = await restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps);
    expect(r.file).toEqual({ action: 'none', reason: 'outside_media_dir' });
    expect(t.fs.rename).not.toHaveBeenCalled();
    expect(r.record.fs_path).toBeNull();
  });
  it('lock timeout → MediaLockError MEDIA_BUSY (retryable)', async () => {
    const t = setup({ rows: [row()] });
    const orig = t.deps.connect;
    t.deps.connect = async () => {
      const c = await orig();
      const q = c.query;
      c.query = vi.fn(async (sql, p) => { if (/pg_advisory_lock\(/.test(sql)) throw Object.assign(new Error('lock'), { code: '55P03' }); return q(sql, p); });
      return c;
    };
    await expect(restoreMediaSafely({ id: 7, tenantId: 10 }, t.deps)).rejects.toBeInstanceOf(MediaLockError);
  });
});
