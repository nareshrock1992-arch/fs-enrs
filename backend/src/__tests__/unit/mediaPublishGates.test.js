/**
 * Media safety — corrective fixes + Option D:
 *   • filename extraction aligned with the delete side (spaces, URLs, schemes)
 *   • lock-only guard for phone-recorded campaign files
 *   • IVR publish validation: baseline warning-only DB checks (restored); the
 *     /media/ path-shape check (pending decision)
 * The DB is mocked here; the real-PostgreSQL behaviour is exercised by the
 * isolated harnesses (scratchpad iso/stage2a-run.sh, iso/stageD-run.sh).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plain function (not vi.fn): a rejected promise from the fake DB must reach
// the validator's own .catch, not vitest's mock-result tracking.
let dbImpl = async () => ({ rows: [] });
let dbCalls = 0;
const queryMock = { mockReset: () => { dbCalls = 0; }, mockImplementation: (f) => { dbImpl = f; } };
vi.mock('../../db/pool.js', () => ({ query: (...a) => { dbCalls++; return dbImpl(...a); }, withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../infrastructure/index.js', () => {
  const stub = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { forModule: () => stub, child: () => stub, ...stub } };
});
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getEnrsSoundDir: () => '/usr/share/freeswitch/sounds/enrs' },
}));
vi.mock('../../controllers/ivrTemplates.js', () => ({ BUILTIN_IVR_TEMPLATES: {} }));

const { extractMediaLeaves, mediaReferenceKeys, mediaLockKeys, guardMedia, mediaLeafOf } =
  await import('../../services/mediaDependencyService.js');
const { validateGraph } = await import('../../utils/ivrGraphValidator.js');

// ── 1. Extraction aligned with delete-side normalisation ─────────────────────
describe('extractMediaLeaves — aligned with the delete side', () => {
  it('filenames containing spaces are extracted (bare, path, /media/, Windows path)', () => {
    expect(extractMediaLeaves('My Prompt.wav')).toEqual(['my prompt.wav']);
    expect(extractMediaLeaves('/usr/share/freeswitch/sounds/enrs/My Prompt.WAV')).toEqual(['my prompt.wav']);
    expect(extractMediaLeaves('/media/My Prompt.wav')).toEqual(['my prompt.wav']);
    expect(extractMediaLeaves('C:\\sounds\\My Prompt.wav')).toEqual(['my prompt.wav']);
  });
  it('the extracted key equals the key a delete locks for the same file', () => {
    const delKeys = mediaLockKeys(mediaReferenceKeys({ fs_path: '/usr/share/freeswitch/sounds/enrs/My Prompt.wav', path_or_uri: 'uploads\\1_My Prompt.wav' }));
    expect(delKeys).toEqual(['1_my prompt.wav', 'my prompt.wav']);
    expect(extractMediaLeaves('/media/My Prompt.wav', 'uploads/1_My Prompt.wav')).toEqual(delKeys);
  });
  it('URLs: leaf of the path, query/fragment ignored, percent-decoding applied', () => {
    expect(extractMediaLeaves('https://cdn.example/media/hold%20music.mp3?v=2#t')).toEqual(['hold music.mp3']);
    expect(extractMediaLeaves('http://example.com/')).toEqual([]);
  });
  it('file_string:// lists are split into their files', () => {
    expect(extractMediaLeaves('file_string:///media/a.wav!/x/B.wav!say:hello')).toEqual(['a.wav', 'b.wav']);
  });
  it('ordinary text, TTS prompts and non-file sources are never filenames', () => {
    expect(extractMediaLeaves(
      'Press 1 for sales, 2 for support.',
      'Thank you for calling. Goodbye.',
      'say:en number pronounced 911.wav',
      'tone_stream://%(2000,4000,440,480)',
      'local_stream://moh/hold.wav',
      'silence_stream://1000',
      'phrase:welcome.wav',
      'line one.wav\nline two.wav',
      '$${hold_music}', '1000', '',
    )).toEqual([]);
  });
  it('mediaLeafOf is the shared normaliser', () => {
    expect(mediaLeafOf('a\\b\\C.wav')).toBe('C.wav');
    expect(mediaLeafOf('/media/x.wav/')).toBe('x.wav');
  });
});

// ── 2. Campaign recordings: lock-only ────────────────────────────────────────
describe('guardMedia — lock-only values', () => {
  const rec = '/opt/freeswitch/recordings/ens/ens_3_5551234_1700000000.wav';
  it('locks check + lockOnly leaves in ONE sorted acquisition, checks only `check`', async () => {
    const calls = [];
    const tq = vi.fn(async (sql, p) => { calls.push([sql.trim().split('\n')[0], p]); return { rows: sql.includes('current_setting') ? [{ prev: '0' }] : [] }; });
    await guardMedia(tq, { check: ['/media/zz_msg.wav'], lockOnly: [rec] });
    expect(calls.filter(([s]) => s.includes('xact_lock')).map(([, p]) => p[1])).toEqual(['ens_3_5551234_1700000000.wav', 'zz_msg.wav']);
    const chk = calls.find(([s]) => s.startsWith('SELECT l AS leaf'));
    expect(chk[1]).toEqual([['zz_msg.wav']]);
  });
  it('a recording whose name collides with soft-deleted library media is NOT rejected', async () => {
    // A DB that would report every queried leaf as deleted-only.
    const tq = vi.fn(async (sql, p) => (sql.includes('SELECT l AS leaf') ? { rows: p[0].map((leaf) => ({ leaf })) } : { rows: [{ prev: '0' }] }));
    await expect(guardMedia(tq, { lockOnly: [rec] })).resolves.toEqual([]);
    expect(tq.mock.calls.some(([s]) => s.includes('SELECT l AS leaf'))).toBe(false);
  });
  it('library message audio that is soft-deleted IS rejected (409, tagged)', async () => {
    const tq = vi.fn(async (sql, p) => (sql.includes('SELECT l AS leaf') ? { rows: p[0].map((leaf) => ({ leaf })) } : { rows: [{ prev: '0' }] }));
    await expect(guardMedia(tq, { check: ['/media/gone.wav'], lockOnly: [rec] }))
      .rejects.toMatchObject({ code: 'MEDIA_DELETED', status: 409, files: ['gone.wav'] });
  });
  it('lock timeout during acquisition → tagged 503 MEDIA_BUSY', async () => {
    const tq = vi.fn(async (sql) => { if (sql.includes('xact_lock')) throw Object.assign(new Error('lock timeout'), { code: '55P03' }); return { rows: [{ prev: '0' }] }; });
    await expect(guardMedia(tq, { lockOnly: [rec] })).rejects.toMatchObject({ status: 503, httpBody: { error: 'MEDIA_BUSY' } });
  });
});

// ── 3. IVR publish validation (restored baseline semantics) ──────────────────
// Approved restoration: DB errors in the ENS / ERS / media-ID checks are
// warnings again (baseline 6ab4dc6), and the validator no longer rejects
// soft-deleted /media/ references — the publish transaction's media guard
// returns 409 MEDIA_DELETED for those (proven on real PostgreSQL by the
// isolated harnesses). The /media/ path-shape check is still present pending a
// separate decision (see report).
const graphWith = (nodes) => ({ entry_node_id: 'n1', nodes: { ...nodes, n9: { type: 'hangup' } } });
const play = (extra) => ({ n1: { type: 'play', next: 'n9', ...extra } });
const ids = ({ fail = false } = {}) => queryMock.mockImplementation(async (sql, p = []) => {
  if (fail) throw new Error('relation does not exist');
  return { rows: (p[0] || []).map((id) => ({ id })) };   // every ID exists
});

describe('validateGraph — /media/ references', () => {
  beforeEach(() => queryMock.mockReset());

  it('library or unknown (manually managed) /media/ files pass, with no media query', async () => {
    ids();
    const r = await validateGraph(graphWith(play({ audio_url: '/media/manual sound.wav' })), 1);
    expect(r.valid).toBe(true);
    expect(dbCalls).toBe(0);
  });
  it('a /media/ reference is NOT rejected by the validator (deleted media → 409 from the publish guard)', async () => {
    ids();
    const r = await validateGraph(graphWith(play({ audio_url: '/media/gone.wav' })), 1);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('path-shape check (pending decision): traversal / malformed /media/ paths are rejected; nested paths allowed', async () => {
    ids();
    for (const bad of ['/media/../etc/x.wav', '/media/a//b.wav', '/media/./x.wav', '/media/']) {
      const r = await validateGraph(graphWith(play({ audio_url: bad })), 1);
      expect(r.valid, bad).toBe(false);
      expect(r.errors[0]).toMatch(/is not a valid \/media\/ path/);
      expect(r.dependencyErrors).toEqual(r.errors);           // publish-only: draft save ignores it
    }
    expect((await validateGraph(graphWith(play({ audio_url: '/media/sub/x.wav' })), 1)).errors).toEqual([]);
  });

  // Approved narrow correction: the editor keeps play's '/media/' default when the
  // source is switched to a session variable; exec_play ignores audio_url then.
  it('dynamic-source play node keeping the unused "/media/" placeholder is NOT rejected', async () => {
    ids();
    const r = await validateGraph(graphWith(play({ audio_source_type: 'variable', audio_variable: 'recorded_file_path', audio_url: '/media/' })), 1);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
  it('static-source play node with the bare "/media/" (no file chosen) is still rejected', async () => {
    ids();
    for (const node of [play({ audio_url: '/media/' }), play({ audio_source_type: 'url', audio_url: '/media/' })]) {
      const r = await validateGraph(graphWith(node), 1);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toMatch(/audio_url "\/media\/" is not a valid \/media\/ path/);
    }
  });
  it('dynamic source does not exempt anything else: a malformed audio_url value is still rejected', async () => {
    ids();
    const r = await validateGraph(graphWith(play({ audio_source_type: 'variable', audio_variable: 'v', audio_url: '/media/../x.wav' })), 1);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/is not a valid \/media\/ path/);
  });
});

describe('validateGraph — ENS / ERS / media-ID DB errors are warnings (baseline behaviour)', () => {
  beforeEach(() => queryMock.mockReset());
  const cases = [
    ['ENS configuration', { n1: { type: 'ens', ens_configuration_id: 4, next: 'n9' } }],
    ['ERS configuration', { n1: { type: 'ers', ers_configuration_id: 5, next: 'n9' } }],
    ['Media file',        play({ audio_file_id: 6 })],
  ];
  for (const [what, nodes] of cases) {
    it(`${what}: DB error → baseline warning "FK check skipped", graph still valid`, async () => {
      ids({ fail: true });
      const r = await validateGraph(graphWith(nodes), 1);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toContain(`${what} FK check skipped (schema upgrade pending)`);
    });
    it(`${what}: check succeeds → valid, no warning`, async () => {
      ids();
      const r = await validateGraph(graphWith(nodes), 1);
      expect(r.errors).toEqual([]);
      expect(r.warnings.some((w) => w.includes('skipped'))).toBe(false);
    });
  }
});
