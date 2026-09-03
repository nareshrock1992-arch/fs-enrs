/**
 * Unit tests for the campaign TTS synthesis path (ensureCampaignTtsWav).
 *
 * Guards the four invariants from Phase 2 remediation:
 *  1. Synthesis happens once per campaign, not per recipient (idempotent + deduplicated).
 *  2. Piper failure → skip dispatch for this tick without crashing the engine.
 *  3. Existing recording_file / message_audio_url → Piper is never called.
 *  4. No &speak() / session:execute("speak") reaches ESL or Lua when Piper is configured.
 *
 * Import strategy — why dynamic imports are used for campaignEngine and piperClient:
 *
 * Vitest v1 TDZ root cause: statically importing BOTH campaignEngine AND piperClient
 * in the same test file triggers a "__vi_import_1__ before initialization" error.
 * campaignEngine itself statically imports piperClient; when Vitest hoists the vi.mock
 * registrations and then initialises the static imports in declaration order, the
 * interleaved __vi_import_N__ assignments create an unresolvable TDZ cycle.
 *
 * Fix: dynamic-import both inside beforeAll (identical to callerIdSeparation.test.js).
 * The vi.mock registrations are still hoisted before any import, so the dynamic calls
 * inside beforeAll receive the mocked versions from the registry.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Module mocks (hoisted before all imports) ─────────────────────────────────

vi.mock('../../services/piperClient.js', () => {
  class PiperError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  class PiperUnavailableError extends PiperError {
    constructor(m) { super('PIPER_UNAVAILABLE', m); }
  }
  class PiperTimeoutError extends PiperError {
    constructor(m) { super('PIPER_TIMEOUT', m); }
  }
  return {
    synthesize:            vi.fn(),
    PiperError,
    PiperUnavailableError,
    PiperTimeoutError,
    synthesizeToFile:      vi.fn(),
  };
});

vi.mock('../../config/fsConfig.js', () => ({
  fsConfig: { recordingDir: '/var/lib/freeswitch/recordings' },
}));

vi.mock('../../db/pool.js',                () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../services/eslService.js',    () => ({ originateCampaignCall: vi.fn() }));
vi.mock('../../services/socketService.js', () => ({ emitInternal: vi.fn() }));
vi.mock('../../infrastructure/index.js',   () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/index.js', () => ({
  config: {
    freeswitch: { defaultGateway: 'default', ttsEngine: 'flite|kal' },
    esl:        { domain: '127.0.0.1' },
    piper:      { url: 'http://127.0.0.1:5002', defaultVoice: 'en_US-lessac-medium', timeoutMs: 30000, sampleRate: 8000 },
  },
}));

// ── Static imports — only modules that don't form a circular TDZ ─────────────
// fs is not mocked; vi.spyOn wraps the four promises methods in beforeAll.
// query and originateCampaignCall are from mocked modules with no cross-dependency.
import { promises as fsPromises } from 'fs';
import { query } from '../../db/pool.js';
import { originateCampaignCall } from '../../services/eslService.js';

// ── Populated by beforeAll (dynamic to avoid Vitest v1 TDZ) ──────────────────
let ensureCampaignTtsWav, processCampaign, stopEngine;
let synthesize, PiperError;

beforeAll(async () => {
  // Dynamic imports resolve to the mocked versions (vi.mock registrations are
  // already hoisted above the static import block).
  const engine = await import('../../services/campaignEngine.js');
  ensureCampaignTtsWav = engine.ensureCampaignTtsWav;
  processCampaign      = engine.processCampaign;
  stopEngine           = engine.stopEngine;

  const piper = await import('../../services/piperClient.js');
  synthesize  = piper.synthesize;
  PiperError  = piper.PiperError;

  // Spy on the four fs.promises methods used by ensureCampaignTtsWav.
  // Installed once here; vi.clearAllMocks() in each beforeEach resets call
  // history without removing the spy wrapper.
  vi.spyOn(fsPromises, 'access');
  vi.spyOn(fsPromises, 'mkdir');
  vi.spyOn(fsPromises, 'writeFile');
  vi.spyOn(fsPromises, 'rename');
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWavBytes(n = 1000) {
  const buf = Buffer.alloc(n);
  buf.write('RIFF', 0); buf.writeUInt32LE(n - 8, 4); buf.write('WAVE', 8);
  return buf;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ensureCampaignTtsWav — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsPromises.mkdir.mockResolvedValue(undefined);
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);
  });

  it('synthesizes via Piper and returns the final WAV path', async () => {
    synthesize.mockResolvedValue(makeWavBytes());
    const result = await ensureCampaignTtsWav(42, 'Hello world');

    expect(result).toBe('/var/lib/freeswitch/recordings/tts/ens_tts_campaign_42.wav');
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith('Hello world', { sampleRate: 8000 });
  });

  it('writes to a temp file then atomically renames to the final path', async () => {
    synthesize.mockResolvedValue(makeWavBytes());
    await ensureCampaignTtsWav(43, 'Test');

    const finalPath = '/var/lib/freeswitch/recordings/tts/ens_tts_campaign_43.wav';
    expect(fsPromises.writeFile).toHaveBeenCalledOnce();
    const tempPath = fsPromises.writeFile.mock.calls[0][0];
    expect(tempPath).toMatch(/\.tmp\./);
    expect(tempPath).not.toBe(finalPath);
    expect(fsPromises.rename).toHaveBeenCalledWith(tempPath, finalPath);
  });

  it('creates the tts subdirectory if it does not exist', async () => {
    synthesize.mockResolvedValue(makeWavBytes());
    await ensureCampaignTtsWav(44, 'Test');
    expect(fsPromises.mkdir).toHaveBeenCalledWith(
      '/var/lib/freeswitch/recordings/tts',
      { recursive: true }
    );
  });

  it('samples at 8000 Hz (G.711 telephony standard)', async () => {
    synthesize.mockResolvedValue(makeWavBytes());
    await ensureCampaignTtsWav(45, 'Test');
    expect(synthesize.mock.calls[0][1]).toMatchObject({ sampleRate: 8000 });
  });
});

describe('ensureCampaignTtsWav — idempotency', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reuses existing WAV without calling Piper when the file is already on disk', async () => {
    fsPromises.access.mockResolvedValue(undefined);

    const result = await ensureCampaignTtsWav(100, 'Anything');

    expect(result).toBe('/var/lib/freeswitch/recordings/tts/ens_tts_campaign_100.wav');
    expect(synthesize).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });
});

describe('ensureCampaignTtsWav — in-process concurrency dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsPromises.mkdir.mockResolvedValue(undefined);
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);
  });

  it('deduplicates concurrent calls — Piper is invoked only once per campaign', async () => {
    let resolveWav;
    synthesize.mockReturnValue(new Promise(r => { resolveWav = r; }));

    const [p1, p2, p3] = [
      ensureCampaignTtsWav(200, 'Alert'),
      ensureCampaignTtsWav(200, 'Alert'),
      ensureCampaignTtsWav(200, 'Alert'),
    ];

    resolveWav(makeWavBytes());
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(synthesize).toHaveBeenCalledOnce();
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toContain('ens_tts_campaign_200.wav');
  });
});

describe('ensureCampaignTtsWav — Piper failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsPromises.mkdir.mockResolvedValue(undefined);
  });

  it('returns null when Piper is unavailable', async () => {
    synthesize.mockRejectedValue(new PiperError('PIPER_UNAVAILABLE', 'Connection refused'));
    const result = await ensureCampaignTtsWav(300, 'Emergency alert');
    expect(result).toBeNull();
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });

  it('returns null when Piper times out', async () => {
    synthesize.mockRejectedValue(new PiperError('PIPER_TIMEOUT', 'Request timed out'));
    const result = await ensureCampaignTtsWav(301, 'Emergency alert');
    expect(result).toBeNull();
  });

  it('returns null when Piper returns a WAV that is too small to be valid', async () => {
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);
    synthesize.mockResolvedValue(Buffer.alloc(50, 0));
    const result = await ensureCampaignTtsWav(302, 'Test');
    expect(result).toBeNull();
  });

  it('allows the next tick to retry after a failure (map entry cleaned up)', async () => {
    synthesize
      .mockRejectedValueOnce(new PiperError('PIPER_UNAVAILABLE', 'Down'))
      .mockResolvedValueOnce(makeWavBytes());
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);

    const first  = await ensureCampaignTtsWav(303, 'Alert');
    const second = await ensureCampaignTtsWav(303, 'Alert');

    expect(first).toBeNull();
    expect(second).toContain('ens_tts_campaign_303.wav');
    expect(synthesize).toHaveBeenCalledTimes(2);
  });
});

describe('ensureCampaignTtsWav — text safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsPromises.mkdir.mockResolvedValue(undefined);
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);
    synthesize.mockResolvedValue(makeWavBytes());
  });

  it('passes text containing apostrophes to Piper unchanged', async () => {
    await ensureCampaignTtsWav(400, "Don't panic, it's okay");
    expect(synthesize.mock.calls[0][0]).toBe("Don't panic, it's okay");
  });

  it('passes text containing quotes and pipes to Piper unchanged', async () => {
    await ensureCampaignTtsWav(401, 'Say "hello" | pipe');
    expect(synthesize.mock.calls[0][0]).toBe('Say "hello" | pipe');
  });

  it('truncates text to 4900 characters to avoid Piper payload overflow', async () => {
    const longText = 'x'.repeat(5000);
    await ensureCampaignTtsWav(402, longText);
    expect(synthesize.mock.calls[0][0].length).toBe(4900);
  });

  it('passes short text through unmodified', async () => {
    await ensureCampaignTtsWav(403, 'Short message');
    expect(synthesize.mock.calls[0][0]).toBe('Short message');
  });
});

// Source-inspection tests use the real readFileSync (fs module is not mocked).
describe('ESL originate — no &speak() when Piper is configured', () => {
  it('eslService originateCampaignCall no longer has a &speak() path', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../../services/eslService.js', import.meta.url), 'utf8');

    expect(src).not.toMatch(/&speak\(/);
    expect(src).not.toMatch(/ttsEngine.*\|.*messageText/);
  });
});

describe('Lua speak() — no session:execute("speak") in active ENS/ERS scripts', () => {
  const luaFiles = [
    'Lua-scripts/ens_blast_trigger.lua',
    'Lua-scripts/ens_playback_handler.lua',
    'Lua-scripts/ers_conference_bridge.lua',
  ];

  for (const rel of luaFiles) {
    it(`${rel} does not call session:execute("speak")`, async () => {
      const { readFileSync } = await import('fs');
      const repoRoot = new URL('../../../../', import.meta.url);
      const src = readFileSync(new URL(rel, repoRoot), 'utf8');
      expect(src).not.toMatch(/session:execute\s*\(\s*["']speak["']/);
    });

    it(`${rel} uses PIPER_LUA_URL, not ENRS_TTS_ENGINE`, async () => {
      const { readFileSync } = await import('fs');
      const repoRoot = new URL('../../../../', import.meta.url);
      const src = readFileSync(new URL(rel, repoRoot), 'utf8');
      expect(src).toContain('PIPER_LUA_URL');
      expect(src).not.toContain('ENRS_TTS_ENGINE');
      expect(src).not.toContain('ENRS_TTS_VOICE');
    });
  }
});

// ── Audio priority regression — Tests A, B, C from Phase 2 matrix ─────────────
//
// processCampaign() is exported for testing. These tests verify the audio priority
// chain: recording_file → message_audio_url → Piper TTS. Piper (synthesize) must
// never be called when a pre-existing audio path is set on the campaign row.
describe('processCampaign — audio priority (Tests A + B + C)', () => {
  const BASE = {
    id:                   500,
    status:               'queued',
    campaign_timeout_min: null,
    started_at:           null,
    max_concurrent:       5,
    calls_per_second:     1,
    adaptive_throttling:  false,
    batch_size:           10,
    sip_caller_id:        '5000',
    peak_concurrent:      0,
    campaign_priority:    0,
    recording_file:       null,
    message_audio_url:    null,
    message_text:         null,
  };

  const DEST = {
    id:            99,
    phone_number:  '0501234567',
    contact_name:  'Test',
    attempt_count: 1,
    max_attempts:  3,
    gateway_name:  'gw1',
    contact_id:    null,
  };

  // Standard DB query sequence processCampaign() expects:
  //   queued→running, counts, SKIP LOCKED claim, dialing_count++, call_uuid assign
  function queueStandard() {
    query
      .mockResolvedValueOnce({ rows: [{ id: 500 }] })
      .mockResolvedValueOnce({ rows: [{ dialing: 0, ready: 1, pending: 0 }] })
      .mockResolvedValueOnce({ rows: [DEST] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stopEngine();
    originateCampaignCall.mockResolvedValue(undefined);
  });

  it('Test A — recording_file set: synthesize() never called, WAV path forwarded', async () => {
    queueStandard();
    await processCampaign({ ...BASE, recording_file: '/recordings/blast.wav' });

    expect(synthesize).not.toHaveBeenCalled();
    expect(originateCampaignCall).toHaveBeenCalledOnce();
    expect(originateCampaignCall.mock.calls[0][0]).toMatchObject({
      playbackFile: '/recordings/blast.wav',
      messageText:  null,
    });
  });

  it('Test B — message_audio_url set: synthesize() never called, URL forwarded', async () => {
    queueStandard();
    await processCampaign({ ...BASE, message_audio_url: '/uploads/audio.wav' });

    expect(synthesize).not.toHaveBeenCalled();
    expect(originateCampaignCall).toHaveBeenCalledOnce();
    expect(originateCampaignCall.mock.calls[0][0]).toMatchObject({
      playbackFile: '/uploads/audio.wav',
      messageText:  null,
    });
  });

  it('Test C — text-only: synthesize() called once, TTS WAV written and forwarded', async () => {
    // TTS path inserts one extra query (UPDATE recording_file write-back).
    query
      .mockResolvedValueOnce({ rows: [{ id: 500 }] })
      .mockResolvedValueOnce({ rows: [{ dialing: 0, ready: 1, pending: 0 }] })
      .mockResolvedValueOnce({ rows: [] })          // recording_file write-back
      .mockResolvedValueOnce({ rows: [DEST] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    fsPromises.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsPromises.mkdir.mockResolvedValue(undefined);
    fsPromises.writeFile.mockResolvedValue(undefined);
    fsPromises.rename.mockResolvedValue(undefined);
    synthesize.mockResolvedValue(makeWavBytes());

    await processCampaign({ ...BASE, message_text: 'Emergency alert!' });

    expect(synthesize).toHaveBeenCalledOnce();
    expect(originateCampaignCall).toHaveBeenCalledOnce();
    const { playbackFile, messageText } = originateCampaignCall.mock.calls[0][0];
    expect(playbackFile).toMatch(/ens_tts_campaign_500\.wav$/);
    expect(messageText).toBeNull();
  });
});
