/**
 * mediaDependencyService — guarded media deletion (Phase 1).
 *
 * The DB is replaced by an in-memory emulator that evaluates the service's REAL
 * match patterns with a faithful ILIKE implementation over fake tables, so the
 * matching rules (path normalisation, escaping, case, version selection,
 * tenancy) are exercised for real. What this cannot prove is that the SQL text
 * parses on PostgreSQL — that needs a read-only check against a real database.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../infrastructure/index.js', () => {
  const stub = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { forModule: () => stub, child: () => stub, ...stub } };
});
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getEnrsSoundDir: () => '/usr/share/freeswitch/sounds/enrs' },
}));
vi.mock('../../controllers/ivrTemplates.js', () => ({ BUILTIN_IVR_TEMPLATES: {} }));

const svc = await import('../../services/mediaDependencyService.js');
const {
  deleteMediaSafely, findMediaReferences, mediaReferenceKeys, buildPatterns,
  REFERENCE_SOURCES, DependencyCheckError, DependencySchemaError, blockedDeleteBody,
  dependencyFailureBody, QUARANTINE_DIRNAME, MEDIA_LOCK_NS, MediaLockError, mediaLockKeys, lockMediaLeaves,
  extractMediaLeaves, assertMediaNotDeleted, guardMediaReferences, mediaGuardErrorResponse, MediaReferenceDeletedError,
} = svc;

const SOUND = '/usr/share/freeswitch/sounds/enrs';

// ── Faithful ILIKE (backslash escape, % and _ wildcards, case-insensitive) ──
function ilike(value, pattern) {
  if (value == null) return false;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(String(value));
}
const anyIlike = (v, pats) => pats.some((p) => ilike(v, p));
const jtext = (o) => JSON.stringify(o); // stand-in for jsonb::text (same string-value boundaries)

// ── In-memory database ───────────────────────────────────────────────────────
// Mirrors a REAL FRESH INSTALL: notification_templates (dropped by migration
// 041) and the legacy ivr_templates table (only in 001, skipped by fresh
// installs) do NOT exist unless a test adds them explicitly.
function makeDb(tables = {}) {
  const t = {
    media_files: [], ivr_flows: [], ivr_flow_versions: [], ens_configurations: [],
    ers_configurations: [], ens_campaigns: [], organizations: [], config_versions: [], ...tables,
  };
  const state = {
    calls: [], updates: [], failOn: null, failPhase: null, failError: null, phase: 'none',
    afterCommit: null, rolledBack: false,
    presence: {},          // to_regclass overrides: { 'name' or 'public.name': bool }
    incompletePresence: false,
  };
  const kindOfSql = (sql) => REFERENCE_SOURCES.find((s) => s.sql === sql)?.kind;
  const tableExists = (name) => {
    if (name in state.presence) return state.presence[name];
    const base = name.replace(/^public\./, '');
    return Object.prototype.hasOwnProperty.call(t, base) && Array.isArray(t[base]);
  };

  const run = (sql, params = []) => {
    state.calls.push({ sql, params, phase: state.phase });
    const kind = kindOfSql(sql);
    if (state.failOn && (kind === state.failOn || sql.includes(state.failOn))
        && (!state.failPhase || state.failPhase === state.phase)) {
      throw state.failError || new Error('simulated db failure');
    }
    if (sql.includes('to_regclass')) {
      const names = state.incompletePresence ? params[0].slice(1) : params[0];
      return { rows: names.map((name) => ({ name, present: tableExists(name) })) };
    }
    // Both the unlocked pre-read and the in-transaction SELECT … FOR UPDATE.
    if (sql.includes('FROM media_files WHERE id = $1 AND deleted_at IS NULL')) {
      const [id, tenant] = params;
      const sys = sql.includes('OR tenant_id IS NULL');
      const rows = t.media_files.filter((m) => String(m.id) === String(id) && !m.deleted_at &&
        (tenant == null || m.tenant_id === tenant || (sys && m.tenant_id == null))).map((m) => ({ ...m }));
      if (!sql.includes('FOR UPDATE') && state.afterPreRead) state.afterPreRead(t);
      return { rows };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('UPDATE media_files SET deleted_at')) {
      state.updates.push(params[0]);
      const m = t.media_files.find((x) => String(x.id) === String(params[0]));
      if (m) m.deleted_at = 'now';
      return { rows: [] };
    }
    if (sql.includes('FROM media_files') && sql.includes('id <> $1')) {
      const [id, fsPath, leaf] = params;
      return { rows: t.media_files.filter((m) => String(m.id) !== String(id) && !m.deleted_at && m.fs_path &&
        (m.fs_path === fsPath || m.fs_path.split('/').pop().toLowerCase() === String(leaf).toLowerCase()))
        .map((m) => ({ id: m.id })) };
    }
    const p = params[0];
    switch (kind) {
      case 'ivr_flow_draft':
        return { rows: t.ivr_flows.filter((f) => !f.deleted_at && anyIlike(jtext(f.graph), p))
          .map((f) => ({ id: String(f.id), ref_uuid: f.flow_uuid, name: f.name, tenant_id: f.tenant_id, field: 'draft' })) };
      case 'ivr_flow_published': {
        const rows = [];
        for (const f of t.ivr_flows.filter((x) => !x.deleted_at)) {
          const vs = t.ivr_flow_versions.filter((v) => v.ivr_flow_id === f.id);
          const max = Math.max(...vs.map((v) => v.version_number));
          for (const v of vs) {
            if ((v.version_number === max || v.version_number === f.last_deployed_version) && anyIlike(jtext(v.graph), p)) {
              rows.push({ id: String(f.id), ref_uuid: f.flow_uuid, name: f.name, tenant_id: f.tenant_id, field: `version ${v.version_number}` });
            }
          }
        }
        return { rows };
      }
      case 'ens_configuration':
      case 'ers_configuration': {
        const tbl = kind === 'ens_configuration' ? t.ens_configurations : t.ers_configurations;
        const cols = kind === 'ens_configuration'
          ? ['expiry_audio_url', 'no_pending_audio_url', 'unauthorized_audio_url']
          : ['queue_announcement_audio', 'queue_hold_audio', 'queue_music_path'];
        const rows = [];
        for (const r of tbl.filter((x) => !x.deleted_at)) {
          for (const c of cols) if (r[c] != null && anyIlike(r[c], p)) rows.push({ id: String(r.id), ref_uuid: null, name: r.name, tenant_id: r.tenant_id, field: c });
        }
        return { rows };
      }
      case 'ens_campaign_active':
        return { rows: t.ens_campaigns.filter((c) => {
            // Mirrors the SQL: live statuses, or completed inside the callback window.
            const cfg = t.ens_configurations.find((x) => x.id === c.ens_configuration_id);
            const anchor = c.completed_at || c.started_at || c.created_at;
            const inWindow = c.status === 'completed' && anchor != null &&
              new Date(anchor).getTime() + (cfg?.recording_retention_hours ?? 24) * 3600e3 > Date.now();
            return (params[1].includes(c.status) || inWindow) &&
              (anyIlike(c.message_audio_url, p) || anyIlike(c.recording_file, p));
          })
          .map((c) => {
            const cfg = t.ens_configurations.find((x) => x.id === c.ens_configuration_id);
            return { id: String(c.id), ref_uuid: null, name: cfg?.name ?? `Campaign ${c.id}`, tenant_id: cfg?.tenant_id ?? null, field: c.status };
          }) };
      case 'platform_config':
        return { rows: t.config_versions.filter((c) => c.is_active && anyIlike(c.xml_content, p))
          .map((c) => ({ id: String(c.id), ref_uuid: null, name: c.file_path, tenant_id: c.tenant_id, field: c.provider_id })) };
      case 'ivr_template':
        if (!Array.isArray(t.ivr_templates)) throw new Error('relation "public.ivr_templates" does not exist');
        return { rows: t.ivr_templates.filter((x) => x.is_active && anyIlike(jtext(x.graph), p))
          .map((x) => ({ id: String(x.id), ref_uuid: x.slug, name: x.name, tenant_id: null, field: 'graph' })) };
      default:
        throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
    }
  };

  // Dedicated-connection emulation: transaction control + SESSION advisory locks.
  state.held = new Map();          // lock key → count (session locks are re-entrant)
  state.lockLog = [];              // ['lock'|'unlock', ns, key, phase]
  state.released = [];             // client.release(destroy) values
  state.lockError = null;          // throw on pg_advisory_lock (e.g. lock_timeout 55P03)
  state.unlockFails = false;
  const clientRun = (sql, params = []) => {
    if (sql === 'BEGIN') { state.phase = 'tx'; state.updates = []; return { rows: [] }; }
    if (sql === 'COMMIT') { state.phase = 'post'; if (state.afterCommit) state.afterCommit(t); return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      state.rolledBack = true; state.phase = 'post';
      for (const id of state.updates) { const m = t.media_files.find((x) => String(x.id) === String(id)); if (m) m.deleted_at = null; }
      state.updates = []; return { rows: [] };
    }
    if (/^(SET|RESET) lock_timeout/.test(sql)) return { rows: [] };
    if (sql.includes('pg_advisory_lock(')) {
      state.lockLog.push(['lock', params[0], params[1], state.phase]);
      if (state.lockError) throw state.lockError;
      state.held.set(params[1], (state.held.get(params[1]) || 0) + 1);
      return { rows: [] };
    }
    if (sql.includes('pg_advisory_unlock(')) {
      state.lockLog.push(['unlock', params[0], params[1], state.phase]);
      if (state.unlockFails) throw new Error('connection lost');
      const n = state.held.get(params[1]) || 0;
      if (n > 1) state.held.set(params[1], n - 1); else state.held.delete(params[1]);
      return { rows: [{ ok: n > 0 }] };
    }
    return run(sql, params);
  };
  const client = {
    query: vi.fn(async (sql, params) => clientRun(sql, params)),
    release: vi.fn((destroy) => { state.released.push(!!destroy); }),
  };
  const connect = vi.fn(async () => { state.phase = 'pre'; return client; });
  const query = vi.fn(async (sql, params) => run(sql, params));
  const fs = { mkdir: vi.fn(async () => {}), rename: vi.fn(async () => { state.heldAtRename = state.held.size; }), unlink: vi.fn(async () => {}) };
  const fsPathService = { getEnrsSoundDir: () => SOUND };
  return { t, state, client, deps: { connect, query, fs, fsPathService, templates: {} } };
}

const deployed = (over = {}) => ({
  id: 7, tenant_id: 1, name: 'Welcome', deleted_at: null,
  fs_path: `${SOUND}/1700000000_welcome.wav`, path_or_uri: '/app/uploads/1700000000_welcome.wav', ...over,
});
const URI = '/media/1700000000_welcome.wav';
const playNode = (uri) => ({ entry_node_id: 'a', nodes: { a: { id: 'a', type: 'play', audio_url: uri } } });

// ═════════════════════════════════════════════════════════════════════════════
describe('reference keys & patterns', () => {
  it('derives leaves from the deployed and staging paths (deduplicated, sorted)', () => {
    expect(mediaReferenceKeys(deployed())).toEqual(['1700000000_welcome.wav']);
    expect(mediaReferenceKeys({ fs_path: `${SOUND}/a.wav`, path_or_uri: '/up/b.wav' })).toEqual(['a.wav', 'b.wav']);
    expect(mediaReferenceKeys({ fs_path: 'C:\\sounds\\enrs\\x.wav' })).toEqual(['x.wav']);
    expect(mediaReferenceKeys({ fs_path: null, path_or_uri: '  ' })).toEqual([]);
  });

  it('escapes LIKE wildcards so "_" and "%" in filenames match literally', () => {
    const { scalar } = buildPatterns(['a_b.wav']);
    expect(anyIlike('/media/a_b.wav', scalar)).toBe(true);
    expect(anyIlike('/media/axb.wav', scalar)).toBe(false);
    const { scalar: pct } = buildPatterns(['50%.wav']);
    expect(anyIlike('/media/50%.wav', pct)).toBe(true);
    expect(anyIlike('/media/50abc.wav', pct)).toBe(false);
  });

  it('matches /media/<leaf>, absolute paths and bare filenames — but not a different file with the same suffix', () => {
    const { scalar } = buildPatterns(['hold.wav']);
    expect(anyIlike('/media/hold.wav', scalar)).toBe(true);
    expect(anyIlike(`${SOUND}/hold.wav`, scalar)).toBe(true);
    expect(anyIlike('hold.wav', scalar)).toBe(true);
    expect(anyIlike('/media/HOLD.WAV', scalar)).toBe(true);        // case-insensitive (conservative)
    expect(anyIlike('/media/onhold.wav', scalar)).toBe(false);     // different file
    expect(anyIlike('/media/hold.wav.bak', scalar)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — every reference source blocks the delete', () => {
  const cases = [
    ['IVR draft graph', 'ivr_flow_draft', (t) => {
      t.ivr_flows.push({ id: 1, flow_uuid: 'f1', name: 'Main IVR', tenant_id: 1, graph: playNode(URI) });
    }],
    ['latest published IVR version', 'ivr_flow_published', (t) => {
      t.ivr_flows.push({ id: 1, flow_uuid: 'f1', name: 'Main IVR', tenant_id: 1, graph: playNode('/media/other.wav') });
      t.ivr_flow_versions.push({ ivr_flow_id: 1, version_number: 1, graph: playNode('/media/x.wav') },
                               { ivr_flow_id: 1, version_number: 2, graph: playNode(URI) });
    }],
    ['last DEPLOYED IVR version (not the latest)', 'ivr_flow_published', (t) => {
      t.ivr_flows.push({ id: 1, flow_uuid: 'f1', name: 'Main IVR', tenant_id: 1, last_deployed_version: 1, graph: playNode('/media/x.wav') });
      t.ivr_flow_versions.push({ ivr_flow_id: 1, version_number: 1, graph: playNode(URI) },
                               { ivr_flow_id: 1, version_number: 2, graph: playNode('/media/x.wav') });
    }],
    ['ENS config (absolute sound-dir path)', 'ens_configuration', (t) => {
      t.ens_configurations.push({ id: 3, name: 'Fire ENS', tenant_id: 1, expiry_audio_url: `${SOUND}/1700000000_welcome.wav` });
    }],
    ['ERS config (bare filename)', 'ers_configuration', (t) => {
      t.ers_configurations.push({ id: 4, name: 'Fire ERS', tenant_id: 1, queue_music_path: '1700000000_welcome.wav' });
    }],
    ['running ENS campaign', 'ens_campaign_active', (t) => {
      t.ens_campaigns.push({ id: 9, status: 'running', message_audio_url: URI });
    }],
    ['active FreeSWITCH config XML', 'platform_config', (t) => {
      t.config_versions.push({ id: 6, is_active: true, provider_id: 'conference', file_path: 'conference.conf.xml',
        tenant_id: null, xml_content: `<param name="moh-sound" value="${SOUND}/1700000000_welcome.wav"/>` });
    }],
  ];

  for (const [label, kind, seed] of cases) {
    it(`blocks when referenced by ${label}`, async () => {
      const db = makeDb({ media_files: [deployed()] });
      seed(db.t);
      const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
      expect(r.status).toBe('blocked');
      expect(r.blocking.map((x) => x.kind)).toContain(kind);
      expect(db.state.updates).toEqual([]);                 // no soft delete
      expect(db.deps.fs.rename).not.toHaveBeenCalled();     // file untouched
      expect(db.deps.fs.unlink).not.toHaveBeenCalled();
      const body = blockedDeleteBody(r);
      expect(body.error).toBe('MEDIA_IN_USE');
      expect(body.dependencies.length).toBeGreaterThan(0);
    });
  }

  it('does NOT block on an old, undeployed, superseded IVR version', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ivr_flows.push({ id: 1, flow_uuid: 'f1', name: 'Main', tenant_id: 1, last_deployed_version: 3, graph: playNode('/media/x.wav') });
    db.t.ivr_flow_versions.push(
      { ivr_flow_id: 1, version_number: 1, graph: playNode(URI) },
      { ivr_flow_id: 1, version_number: 3, graph: playNode('/media/x.wav') },
    );
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
  });

  it('does NOT block on completed campaigns past their callback window, cancelled campaigns, inactive configs or deleted flows', async () => {
    const db = makeDb({ media_files: [deployed()] });
    const threeDaysAgo = new Date(Date.now() - 72 * 3600e3).toISOString();
    db.t.ens_campaigns.push({ id: 1, status: 'completed', completed_at: threeDaysAgo, message_audio_url: URI },
                            { id: 2, status: 'cancelled', created_at: new Date().toISOString(), recording_file: URI });
    db.t.config_versions.push({ id: 1, is_active: false, xml_content: `${SOUND}/1700000000_welcome.wav` });
    db.t.ivr_flows.push({ id: 1, flow_uuid: 'f', name: 'Old', tenant_id: 1, deleted_at: 'x', graph: playNode(URI) });
    db.t.ens_configurations.push({ id: 1, name: 'gone', tenant_id: 1, deleted_at: 'x', expiry_audio_url: URI });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
  });

  it('BLOCKS while a completed campaign is still inside the ENS callback window (default 24 h)', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ens_campaigns.push({ id: 5, status: 'completed', completed_at: new Date(Date.now() - 2 * 3600e3).toISOString(), message_audio_url: URI });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('blocked');
    expect(r.blocking).toEqual([expect.objectContaining({ kind: 'ens_campaign_active', field: 'completed' })]);
    expect(db.state.updates).toEqual([]);                 // no soft delete
    expect(db.deps.fs.rename).not.toHaveBeenCalled();     // file untouched
  });

  it('honours the configuration\'s recording_retention_hours (48 h config: blocked at 30 h, not at 50 h)', async () => {
    const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const inside = makeDb({ media_files: [deployed()] });
    inside.t.ens_configurations.push({ id: 3, name: 'Long retention', tenant_id: 1, recording_retention_hours: 48 });
    inside.t.ens_campaigns.push({ id: 6, ens_configuration_id: 3, status: 'completed', completed_at: at(30), message_audio_url: URI });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, inside.deps)).status).toBe('blocked');

    const outside = makeDb({ media_files: [deployed()] });
    outside.t.ens_configurations.push({ id: 3, name: 'Long retention', tenant_id: 1, recording_retention_hours: 48 });
    outside.t.ens_campaigns.push({ id: 6, ens_configuration_id: 3, status: 'completed', completed_at: at(50), message_audio_url: URI });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, outside.deps)).status).toBe('deleted');
  });

  it('uses started_at, then created_at, when completed_at is missing (same anchor as the callback)', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ens_campaigns.push({ id: 8, status: 'completed', created_at: new Date(Date.now() - 3600e3).toISOString(), message_audio_url: URI });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).status).toBe('blocked');
  });

  it('treats IVR templates as non-blocking warnings', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ivr_templates = [{ id: 1, slug: 'ens', name: 'ENS template', is_active: true, graph: playNode(URI) }]; // legacy table present
    db.deps.templates = { builtin_x: { name: 'Built-in', graph: playNode(URI) } };
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.warnings.map((w) => w.kind)).toEqual(['ivr_template', 'ivr_template']);
    expect(r.warnings.some((w) => w.builtin)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — unreferenced media', () => {
  it('soft-deletes, then MOVES the deployed file into the quarantine dir (never unlinks)', async () => {
    const db = makeDb({ media_files: [deployed()] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(db.state.updates).toEqual([7]);
    expect(r.file.action).toBe('quarantined');
    expect(db.deps.fs.unlink).not.toHaveBeenCalled();
    const [from, to] = db.deps.fs.rename.mock.calls[0];
    expect(from).toBe(`${SOUND}/1700000000_welcome.wav`);
    expect(to.startsWith(`${SOUND}/${QUARANTINE_DIRNAME}/7_`)).toBe(true);
  });

  it('touches the filesystem only AFTER the transaction committed', async () => {
    const db = makeDb({ media_files: [deployed()] });
    const order = [];
    db.deps.fs.rename.mockImplementation(async () => { order.push(`rename@${db.state.phase}`); });
    await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(order).toEqual(['rename@post']);
    // and the soft delete happened inside the transaction
    const upd = db.state.calls.find((c) => c.sql.startsWith('UPDATE media_files'));
    expect(upd.phase).toBe('tx');
  });

  it('takes the namespaced SESSION lock BEFORE the transaction, then the row lock inside it', async () => {
    const db = makeDb({ media_files: [deployed()] });
    await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    const lock = db.state.lockLog.find((l) => l[0] === 'lock');
    expect(lock).toEqual(['lock', MEDIA_LOCK_NS, '1700000000_welcome.wav', 'pre']);
    const tx = db.state.calls.filter((c) => c.phase === 'tx').map((c) => c.sql);
    expect(tx[0]).toMatch(/FOR UPDATE/);
    expect(db.state.calls.some((c) => /pg_advisory_xact_lock/.test(c.sql))).toBe(false);
  });

  it('HOLDS the lock through commit, re-check and file move; releases it afterwards', async () => {
    const db = makeDb({ media_files: [deployed()] });
    await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(db.state.heldAtRename).toBe(1);                                    // held during the move
    const post = db.state.calls.filter((c) => c.phase === 'post');
    expect(post.length).toBeGreaterThan(0);                                   // re-check ran post-commit…
    expect(db.state.lockLog.filter((l) => l[0] === 'unlock' && l[3] === 'post')).toHaveLength(1); // …unlock after it
    expect(db.state.held.size).toBe(0);                                       // nothing left held
    expect(db.state.released).toEqual([false]);                               // client returned normally
  });

  it('deletes an undeployed record without any filesystem operation', async () => {
    const db = makeDb({ media_files: [deployed({ fs_path: null })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file).toEqual({ action: 'none', reason: 'not_deployed' });
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('reports a missing deployed file without failing the delete', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.deps.fs.rename.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file).toEqual({ action: 'none', reason: 'file_missing' });
  });

  it('never moves a file that lives outside the ENRS sound directory', async () => {
    const db = makeDb({ media_files: [deployed({ fs_path: '/etc/passwd' })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file.reason).toBe('outside_media_dir');
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — shared physical files & duplicate filenames', () => {
  it('keeps the physical file when another live record points to the same file', async () => {
    const db = makeDb({ media_files: [deployed(), deployed({ id: 8, tenant_id: 2 })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file).toMatchObject({ action: 'retained', reason: 'shared_with_other_media' });
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('treats a same-name file deployed by another record as shared (basename collision)', async () => {
    const db = makeDb({ media_files: [deployed(), deployed({ id: 8, fs_path: `${SOUND}/1700000000_WELCOME.wav` })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.file.reason).toBe('shared_with_other_media');
  });

  it('ignores soft-deleted records when deciding whether a file is shared', async () => {
    const db = makeDb({ media_files: [deployed(), deployed({ id: 8, deleted_at: 'x' })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.file.action).toBe('quarantined');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — tenant boundaries', () => {
  it("cannot see or delete another tenant's media", async () => {
    const db = makeDb({ media_files: [deployed({ tenant_id: 2 })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('not_found');
    expect(db.state.updates).toEqual([]);
  });

  it("is blocked by another tenant's reference to the shared file, with that reference redacted", async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ivr_flows.push({ id: 1, flow_uuid: 'secret', name: 'Tenant 2 private IVR', tenant_id: 2, graph: playNode(URI) });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('blocked');
    expect(r.hiddenCount).toBe(1);
    expect(r.blocking[0]).toEqual({ kind: 'ivr_flow_draft', blocking: true, other_tenant: true });
    expect(JSON.stringify(blockedDeleteBody(r))).not.toContain('Tenant 2 private IVR');
  });

  it('shows full reference details to an unrestricted (SUPER_ADMIN) viewer', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.t.ivr_flows.push({ id: 1, flow_uuid: 'f', name: 'Tenant 2 IVR', tenant_id: 2, graph: playNode(URI) });
    const r = await deleteMediaSafely({ id: 7, tenantId: null }, db.deps);
    expect(r.blocking[0]).toMatchObject({ kind: 'ivr_flow_draft', name: 'Tenant 2 IVR', id: '1' });
  });

  it('legacy route semantics: a tenant may delete system (tenant_id NULL) media', async () => {
    const db = makeDb({ media_files: [deployed({ tenant_id: null })] });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).status).toBe('not_found');
    const db2 = makeDb({ media_files: [deployed({ tenant_id: null })] });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1, allowSystemShared: true }, db2.deps)).status).toBe('deleted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — fail closed', () => {
  for (const src of ['ivr_flow_draft', 'ivr_flow_published', 'ens_configuration', 'ers_configuration',
                     'ens_campaign_active', 'platform_config']) {
    it(`a ${src} query error aborts: rollback, nothing deleted, no file touched`, async () => {
      const db = makeDb({ media_files: [deployed()] });
      db.state.failOn = src;
      await expect(deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).rejects.toBeInstanceOf(DependencyCheckError);
      expect(db.state.rolledBack).toBe(true);
      expect(db.t.media_files[0].deleted_at).toBeNull();
      expect(db.deps.fs.rename).not.toHaveBeenCalled();
      expect(db.deps.fs.unlink).not.toHaveBeenCalled();
    });
  }

  it('findMediaReferences never returns "no references" on error', async () => {
    const q = vi.fn(async () => { throw new Error('connection reset'); });
    await expect(findMediaReferences(q, deployed())).rejects.toBeInstanceOf(DependencyCheckError);
  });

  it('rejects malformed ids without touching the database', async () => {
    const db = makeDb({ media_files: [deployed()] });
    expect((await deleteMediaSafely({ id: '7; DROP TABLE x', tenantId: 1 }, db.deps)).status).toBe('not_found');
    expect(db.deps.connect).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deleteMediaSafely — concurrent changes', () => {
  it('keeps the file when a reference is committed between the check and the file step', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.afterCommit = (t) => t.ivr_flows.push({ id: 1, flow_uuid: 'f', name: 'Saved meanwhile', tenant_id: 1, graph: playNode(URI) });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file).toEqual({ action: 'retained', reason: 'referenced_after_delete' });
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('keeps the file when another record deploys the same file meanwhile', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.afterCommit = (t) => t.media_files.push(deployed({ id: 9 }));
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.file.reason).toBe('shared_with_other_media');
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('keeps the file when the post-commit re-check itself fails', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.failOn = 'ivr_flow_draft';
    db.state.failPhase = 'post';
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.file).toEqual({ action: 'retained', reason: 'recheck_failed' });
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('a second concurrent delete of the same record finds nothing to delete', async () => {
    const db = makeDb({ media_files: [deployed()] });
    const a = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    const b = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(a.status).toBe('deleted');
    expect(b.status).toBe('not_found');
    expect(db.deps.fs.rename).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('schema awareness — real fresh-install schema', () => {
  const REQUIRED_KINDS = ['ivr_flow_draft', 'ivr_flow_published', 'ens_configuration', 'ers_configuration',
                          'ens_campaign_active', 'platform_config'];
  const kindsOf = (calls) => calls
    .map((c) => REFERENCE_SOURCES.find((s) => s.sql === c.sql)?.kind).filter(Boolean);

  it('notification_templates (dropped by migration 041) is not a source and is never queried', async () => {
    expect(REFERENCE_SOURCES.map((s) => s.kind)).not.toContain('notification_template');
    const db = makeDb({ media_files: [deployed()] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    for (const c of db.state.calls) {
      expect(c.sql).not.toMatch(/notification_templates/);
      expect(JSON.stringify(c.params)).not.toMatch(/notification_templates/);
    }
  });

  it('a stray notification_templates row can never block a delete', async () => {
    const db = makeDb({ media_files: [deployed()], notification_templates: [{ id: 5, media_file_id: 7, name: 'x' }] });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).status).toBe('deleted');
  });

  it('executes EVERY required source, in the transaction and in the post-commit re-check', async () => {
    const db = makeDb({ media_files: [deployed()] });
    await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(kindsOf(db.state.calls.filter((c) => c.phase === 'tx')).sort()).toEqual([...REQUIRED_KINDS].sort());
    expect(kindsOf(db.state.calls.filter((c) => c.phase === 'post')).sort()).toEqual([...REQUIRED_KINDS].sort());
  });

  it('skips ONLY the optional ivr_templates check when that table is absent, and reports it', async () => {
    const db = makeDb({ media_files: [deployed()] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.skippedSources).toEqual(['ivr_template']);
    expect(kindsOf(db.state.calls)).not.toContain('ivr_template');
  });

  it('checks the ivr_templates table when it exists — schema-qualified in lookup AND query', async () => {
    const db = makeDb({ media_files: [deployed()], ivr_templates: [
      { id: 1, slug: 'legacy', name: 'Legacy template', is_active: true, graph: playNode(URI) }] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');                          // templates never block
    expect(r.skippedSources).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ kind: 'ivr_template', name: 'Legacy template' })]);
    const lookup = db.state.calls.find((c) => c.sql.includes('to_regclass'));
    expect(lookup.params[0]).toContain('public.ivr_templates');
    expect(REFERENCE_SOURCES.find((s) => s.kind === 'ivr_template').sql).toMatch(/FROM public\.ivr_templates/);
  });

  it('does NOT match a same-named ivr_templates table in another schema', async () => {
    const db = makeDb({ media_files: [deployed()], ivr_templates: [
      { id: 1, slug: 'x', name: 'Other-schema table', is_active: true, graph: playNode(URI) }] });
    db.state.presence = { ivr_templates: true, 'public.ivr_templates': false };  // exists only outside public
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.skippedSources).toEqual(['ivr_template']);
    expect(r.warnings).toEqual([]);
    expect(kindsOf(db.state.calls)).not.toContain('ivr_template');
  });

  it('detects built-in template references even when the ivr_templates table is absent', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.deps.templates = { builtin_ens: { name: 'Built-in ENS', graph: playNode(URI) } };
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(r.skippedSources).toEqual(['ivr_template']);
    expect(r.warnings).toEqual([expect.objectContaining({ kind: 'ivr_template', builtin: true, name: 'Built-in ENS' })]);
  });

  it('a REQUIRED table missing is an explicit schema error — fail closed, nothing deleted', async () => {
    const db = makeDb({ media_files: [deployed()] });
    delete db.t.config_versions;
    const err = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps).catch((e) => e);
    expect(err).toBeInstanceOf(DependencySchemaError);
    expect(err).toBeInstanceOf(DependencyCheckError);            // still "nothing deleted"
    expect(err.code).toBe('DEPENDENCY_SCHEMA_ERROR');
    expect(err.missingTables).toEqual(['config_versions']);
    expect(db.state.rolledBack).toBe(true);
    expect(db.state.updates).toEqual([]);
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
    expect(dependencyFailureBody(err)).toMatchObject({ error: 'DEPENDENCY_SCHEMA_ERROR' });
    expect(dependencyFailureBody(err).message).toMatch(/config_versions/);
  });

  it('a table-existence lookup failure fails closed (no delete, no file touched)', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.failOn = 'to_regclass';
    db.state.failError = Object.assign(new Error('permission denied for schema public'), { code: '42501' });
    await expect(deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).rejects.toBeInstanceOf(DependencyCheckError);
    expect(db.state.updates).toEqual([]);
    expect(db.t.media_files[0].deleted_at).toBeNull();
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
  });

  it('an incomplete existence-lookup result fails closed', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.incompletePresence = true;
    await expect(deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).rejects.toBeInstanceOf(DependencyCheckError);
    expect(db.state.updates).toEqual([]);
  });

  it('a permission error inside a source query fails closed', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.failOn = 'ens_configuration';
    db.state.failError = Object.assign(new Error('permission denied for table ens_configurations'), { code: '42501' });
    const err = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps).catch((e) => e);
    expect(err).toBeInstanceOf(DependencyCheckError);
    expect(err.code).toBe('DEPENDENCY_CHECK_FAILED');
    expect(err.cause.code).toBe('42501');
    expect(db.state.updates).toEqual([]);
    expect(dependencyFailureBody(err).error).toBe('DEPENDENCY_CHECK_FAILED');
  });

  it('a genuine SQL error in the optional template query (table present) still fails closed', async () => {
    const db = makeDb({ media_files: [deployed()], ivr_templates: [] });
    db.state.failOn = 'ivr_template';
    db.state.failError = Object.assign(new Error('column "slug" does not exist'), { code: '42703' });
    await expect(deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps)).rejects.toBeInstanceOf(DependencyCheckError);
    expect(db.state.updates).toEqual([]);
  });

  it('a record with no file path cannot be referenced by name — no lookups, deleted', async () => {
    const db = makeDb({ media_files: [deployed({ fs_path: null, path_or_uri: null })] });
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(db.state.calls.some((c) => c.sql.includes('to_regclass'))).toBe(false);
    expect(kindsOf(db.state.calls)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('shared media lock — identity, ordering, hygiene', () => {
  it('lock keys are de-duplicated, lower-cased and sorted (global order)', () => {
    expect(mediaLockKeys(['b.wav', 'A.wav', 'a.WAV', null, 'c.wav'])).toEqual(['a.wav', 'b.wav', 'c.wav']);
  });

  it('writers take TRANSACTION locks with the same two-key namespace, in sorted order — timeout scoped to acquisition', async () => {
    const calls = [];
    await lockMediaLeaves(async (sql, p) => { calls.push([sql, p]); return { rows: sql.includes('current_setting') ? [{ prev: '0' }] : [] }; }, ['Z.wav', 'a.wav', 'z.wav']);
    expect(calls).toEqual([
      [`SELECT current_setting('lock_timeout') AS prev`, undefined],
      [`SELECT set_config('lock_timeout', $1, true)`, ['10s']],
      ['SELECT pg_advisory_xact_lock($1, hashtext($2))', [MEDIA_LOCK_NS, 'a.wav']],
      ['SELECT pg_advisory_xact_lock($1, hashtext($2))', [MEDIA_LOCK_NS, 'z.wav']],
      [`SELECT set_config('lock_timeout', $1, true)`, ['0']],   // restored BEFORE any later row lock
    ]);
  });

  it('locks every filename of a record (deployed + staging leaf) in sorted order', async () => {
    const db = makeDb({ media_files: [deployed({ fs_path: `${SOUND}/b_deployed.wav`, path_or_uri: '/up/a_staging.wav' })] });
    await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(db.state.lockLog.filter((l) => l[0] === 'lock').map((l) => l[2])).toEqual(['a_staging.wav', 'b_deployed.wav']);
    expect(db.state.held.size).toBe(0);
  });

  it('lock_timeout (55P03) → MediaLockError MEDIA_BUSY, nothing deleted, client released clean', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.lockError = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const err = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps).catch((e) => e);
    expect(err).toBeInstanceOf(MediaLockError);
    expect(err).toBeInstanceOf(DependencyCheckError);
    expect(err.code).toBe('MEDIA_BUSY');
    expect(dependencyFailureBody(err).error).toBe('MEDIA_BUSY');
    expect(db.state.updates).toEqual([]);
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
    expect(db.state.held.size).toBe(0);
    expect(db.state.released).toEqual([false]);
  });

  it('filenames changed between pre-read and row lock → MEDIA_CHANGED, rolled back, nothing deleted', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.afterPreRead = (t) => { t.media_files[0].fs_path = `${SOUND}/redeployed_other.wav`; };
    const err = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps).catch((e) => e);
    expect(err.code).toBe('MEDIA_CHANGED');
    expect(db.state.rolledBack).toBe(true);
    expect(db.t.media_files[0].deleted_at).toBeNull();
    expect(db.deps.fs.rename).not.toHaveBeenCalled();
    expect(db.state.held.size).toBe(0);
  });

  it('a failed unlock destroys the connection instead of returning it to the pool', async () => {
    const db = makeDb({ media_files: [deployed()] });
    db.state.unlockFails = true;
    const r = await deleteMediaSafely({ id: 7, tenantId: 1 }, db.deps);
    expect(r.status).toBe('deleted');
    expect(db.state.released).toEqual([true]);
  });

  it('locks are released on EVERY outcome: blocked, not found, check failure', async () => {
    const blocked = makeDb({ media_files: [deployed()] });
    blocked.t.ivr_flows.push({ id: 1, flow_uuid: 'f', name: 'x', tenant_id: 1, graph: playNode(URI) });
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, blocked.deps)).status).toBe('blocked');
    expect(blocked.state.held.size).toBe(0);
    expect(blocked.state.rolledBack).toBe(true);

    const gone = makeDb({ media_files: [deployed()] });
    gone.state.afterPreRead = (t) => { t.media_files[0].deleted_at = 'concurrent'; };
    expect((await deleteMediaSafely({ id: 7, tenantId: 1 }, gone.deps)).status).toBe('not_found');
    expect(gone.state.held.size).toBe(0);

    const failing = makeDb({ media_files: [deployed()] });
    failing.state.failOn = 'ivr_flow_draft';
    await expect(deleteMediaSafely({ id: 7, tenantId: 1 }, failing.deps)).rejects.toBeInstanceOf(DependencyCheckError);
    expect(failing.state.held.size).toBe(0);
    expect(failing.state.released).toEqual([false]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reference-writer guard', () => {
  it('extracts filenames consistently with deletion keys (lower-cased, sorted, deduped)', () => {
    const graph = { entry_node_id: 'a', nodes: {
      a: { type: 'play', audio_url: '/media/1700_Welcome.WAV', prompt_text: 'Press 1 for sales/support' },
      b: { type: 'gather', prompt_audio_url: `${SOUND}/menu.wav`, no_input_audio_url: '/media/1700_welcome.wav' },
      c: { type: 'set', value: 'local_stream://moh', label: 'Hold music.wav please' },
    } };
    expect(extractMediaLeaves(graph, 'hold.mp3', null, ['  ', '/media/x'])).toEqual(['1700_welcome.wav', 'hold.mp3', 'menu.wav', 'x']);
    // Same identity the delete locks: basename of fs_path, lower-cased
    expect(mediaLockKeys(mediaReferenceKeys({ fs_path: `${SOUND}/1700_Welcome.WAV` }))).toEqual(['1700_welcome.wav']);
  });

  it('assertMediaNotDeleted: rejects only filenames that exist solely as deleted library media', async () => {
    const tq = vi.fn(async () => ({ rows: [{ leaf: 'gone.wav' }] }));
    const err = await assertMediaNotDeleted(tq, ['gone.wav', 'unknown.wav']).catch((e) => e);
    expect(err).toBeInstanceOf(MediaReferenceDeletedError);
    expect(err.files).toEqual(['gone.wav']);
    expect(tq.mock.calls[0][0]).toMatch(/NOT EXISTS[\s\S]*deleted_at IS NULL[\s\S]*EXISTS[\s\S]*deleted_at IS NOT NULL/);
    await expect(assertMediaNotDeleted(vi.fn(async () => ({ rows: [] })), ['ok.wav'])).resolves.toBeUndefined();
  });

  it('assertMediaNotDeleted fails closed on query errors', async () => {
    await expect(assertMediaNotDeleted(vi.fn(async () => { throw new Error('db down'); }), ['a.wav'])).rejects.toThrow('db down');
  });

  it('guardMediaReferences: scoped lock_timeout, sorted xact locks, timeout restored, THEN the deleted check', async () => {
    const calls = [];
    const tq = vi.fn(async (sql) => { calls.push(sql.trim().split('\n')[0]); return { rows: sql.includes('current_setting') ? [{ prev: '5min' }] : [] }; });
    const leaves = await guardMediaReferences(tq, { a: '/media/b.wav' }, '/media/A.wav');
    expect(leaves).toEqual(['a.wav', 'b.wav']);
    expect(calls[0]).toMatch(/current_setting\('lock_timeout'\)/);
    expect(tq.mock.calls[1][1]).toEqual(['10s']);
    expect(calls.slice(2, 4)).toEqual(['SELECT pg_advisory_xact_lock($1, hashtext($2))', 'SELECT pg_advisory_xact_lock($1, hashtext($2))']);
    expect(tq.mock.calls[2][1]).toEqual([MEDIA_LOCK_NS, 'a.wav']);
    expect(tq.mock.calls[4][1]).toEqual(['5min']);
    expect(calls[5]).toMatch(/^SELECT l AS leaf/);
  });

  it('guardMediaReferences takes no locks when nothing is referenced', async () => {
    const tq = vi.fn();
    expect(await guardMediaReferences(tq, { nodes: { a: { type: 'hangup' } } }, 'plain text')).toEqual([]);
    expect(tq).not.toHaveBeenCalled();
  });

  it('maps guard errors to HTTP: 409 MEDIA_DELETED, 503 MEDIA_BUSY / MEDIA_CHANGED, else null', () => {
    expect(mediaGuardErrorResponse(new MediaReferenceDeletedError(['x.wav']))).toMatchObject({ status: 409, body: { error: 'MEDIA_DELETED', files: ['x.wav'] } });
    expect(mediaGuardErrorResponse({ code: '55P03' })).toMatchObject({ status: 503, body: { error: 'MEDIA_BUSY' } });
    expect(mediaGuardErrorResponse(new MediaLockError('MEDIA_CHANGED', null))).toMatchObject({ status: 503, body: { error: 'MEDIA_CHANGED' } });
    expect(mediaGuardErrorResponse(new Error('other'))).toBeNull();
  });
});

describe('deploy / scan under the shared media lock', () => {
  const { deployMediaLocked, importScannedFileLocked, guardedQuery } = svc;
  // Fake transaction: records statements; `cur` is what the FOR UPDATE re-read returns.
  const fakeTx = ({ cur, live = [] } = {}) => {
    const log = [];
    const tq = async (sql, params) => {
      log.push({ sql, params });
      if (/FOR UPDATE/.test(sql)) return { rows: cur ? [cur] : [] };
      if (/SELECT 1 FROM media_files/.test(sql)) return { rows: live };
      if (/SELECT l AS leaf/.test(sql)) return { rows: [] };
      return { rows: [{ id: 99 }] };
    };
    return { log, withTx: (fn) => fn(tq) };
  };
  const rec = { id: 7, fs_path: `${SOUND}/A.wav`, path_or_uri: '/up/A.wav' };

  it('deploy: locks first, re-reads FOR UPDATE, copies, then records fs_path', async () => {
    const { log, withTx } = fakeTx({ cur: rec }); const copy = vi.fn(async () => `${SOUND}/A.wav`);
    expect(await deployMediaLocked(rec, 'A.wav', copy, { withTx })).toBe(`${SOUND}/A.wav`);
    const i = (re) => log.findIndex((l) => re.test(l.sql));
    expect(i(/lock_timeout/)).toBe(0);
    expect(i(/pg_advisory_xact_lock/)).toBeLessThan(i(/FOR UPDATE/));
    expect(log.filter((l) => /pg_advisory_xact_lock/.test(l.sql)).map((l) => l.params[1])).toEqual(['a.wav']);
    expect(i(/UPDATE media_files SET fs_path/)).toBeGreaterThan(i(/FOR UPDATE/));
    expect(copy).toHaveBeenCalledTimes(1);
  });
  it('deploy: record deleted meanwhile → null, nothing copied or written', async () => {
    const { log, withTx } = fakeTx({ cur: null }); const copy = vi.fn();
    expect(await deployMediaLocked(rec, 'A.wav', copy, { withTx })).toBeNull();
    expect(copy).not.toHaveBeenCalled();
    expect(log.some((l) => /UPDATE media_files/.test(l.sql))).toBe(false);
  });
  it('deploy: record files changed → 503 MEDIA_CHANGED, nothing copied', async () => {
    const { withTx } = fakeTx({ cur: { ...rec, fs_path: `${SOUND}/B.wav` } }); const copy = vi.fn();
    await expect(deployMediaLocked(rec, 'A.wav', copy, { withTx })).rejects.toMatchObject({ code: 'MEDIA_CHANGED', status: 503 });
    expect(copy).not.toHaveBeenCalled();
  });
  it('deploy: lock timeout is tagged 503 MEDIA_BUSY', async () => {
    const withTx = (fn) => fn(async (sql) => { if (/xact_lock/.test(sql)) throw Object.assign(new Error('lock timeout'), { code: '55P03' }); return { rows: [] }; });
    await expect(deployMediaLocked(rec, 'A.wav', vi.fn(), { withTx })).rejects.toMatchObject({ status: 503, httpBody: { error: 'MEDIA_BUSY' } });
  });
  const statFs = (s) => ({ stat: vi.fn(async () => { if (s instanceof Error) throw s; return { isFile: () => true, size: s }; }) });
  it('scan: file moved away under the lock → skipped, no insert', async () => {
    const { withTx } = fakeTx(); const insert = vi.fn();
    const r = await importScannedFileLocked(`${SOUND}/X.wav`, insert, { withTx, fs: statFs(Object.assign(new Error('gone'), { code: 'ENOENT' })) });
    expect(r).toBeNull(); expect(insert).not.toHaveBeenCalled();
  });
  it('scan: size changed or now tracked by a live record → skipped', async () => {
    const insert = vi.fn();
    expect(await importScannedFileLocked(`${SOUND}/X.wav`, insert, { expectedSize: 10, withTx: fakeTx().withTx, fs: statFs(11) })).toBeNull();
    expect(await importScannedFileLocked(`${SOUND}/X.wav`, insert, { withTx: fakeTx({ live: [{}] }).withTx, fs: statFs(10) })).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });
  it('scan: present + untracked → lock taken, then inserted', async () => {
    const { log, withTx } = fakeTx(); const insert = vi.fn(async () => ({ id: 1 }));
    expect(await importScannedFileLocked(`${SOUND}/X.wav`, insert, { expectedSize: 10, withTx, fs: statFs(10) })).toEqual({ id: 1 });
    expect(log.find((l) => /xact_lock/.test(l.sql)).params[1]).toBe('x.wav');
  });
  it('guardedQuery: guard runs before the statement in the same transaction', async () => {
    const { log, withTx } = fakeTx();
    await guardedQuery(['/media/q.wav'], { withTx })('INSERT INTO t VALUES ($1)', [1]);
    const at = (re) => log.findIndex((l) => re.test(l.sql));
    expect([at(/lock_timeout/), at(/xact_lock/), at(/SELECT l AS leaf/), at(/INSERT INTO t/)]).toEqual([0, 2, 4, 5]);
  });
});
