/**
 * Unit tests for backend/src/services/piperClient.js
 *
 * All tests mock globalThis.fetch — no real Piper process needed.
 * Tests cover: success path, connection refused, timeout, 503 not-ready,
 * 400 synthesis error, 422 validation error, piperReady(), synthesizeToFile().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeWavBytes(sampleRate = 8000, channels = 1, frames = 800) {
  const dataSize  = frames * channels * 2;
  const buf       = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function makeResponse(status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const responseHeaders = new Headers({
    'content-type': isBuffer ? 'audio/wav' : 'application/json',
    'x-audio-duration-sec': '0.1',
    'x-synthesis-latency-ms': '50',
    ...headers,
  });
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    arrayBuffer: async () => isBuffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0),
    json: async () => isBuffer ? {} : (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// ── module re-import after fetch mock ─────────────────────────────────────────

// vitest re-evaluates modules — mock fetch before importing the module under test
let synthesize, synthesizeToFile, piperReady, PiperUnavailableError, PiperTimeoutError, PiperSynthesisError;

beforeEach(async () => {
  vi.resetModules();
  // Re-import fresh each time so config is picked up
  const mod = await import('../../services/piperClient.js');
  synthesize          = mod.synthesize;
  synthesizeToFile    = mod.synthesizeToFile;
  piperReady          = mod.piperReady;
  PiperUnavailableError = mod.PiperUnavailableError;
  PiperTimeoutError     = mod.PiperTimeoutError;
  PiperSynthesisError   = mod.PiperSynthesisError;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── piperReady ────────────────────────────────────────────────────────────────

describe('piperReady', () => {
  it('returns ok:true when /ready responds 200', async () => {
    vi.stubGlobal('fetch', async () => makeResponse(200, { status: 'ready', voices: ['en_US-lessac-medium'] }));
    const result = await piperReady();
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with reason when /ready responds 503', async () => {
    vi.stubGlobal('fetch', async () => makeResponse(503, { status: 'not_ready', reason: 'no voices loaded' }));
    const result = await piperReady();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no voices loaded');
  });

  it('returns ok:false when fetch throws (connection refused)', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' }); });
    const result = await piperReady();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });
});

// ── synthesize — success ──────────────────────────────────────────────────────

describe('synthesize — success', () => {
  it('returns a Buffer containing the WAV bytes on HTTP 200', async () => {
    const wav = makeWavBytes(8000, 1, 800);
    vi.stubGlobal('fetch', async () => makeResponse(200, wav));
    const result = await synthesize('Hello world.');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.slice(0, 4).toString()).toBe('RIFF');
    expect(result.length).toBe(wav.length);
  });

  it('passes text, voice and sample_rate in the request body', async () => {
    const wav = makeWavBytes();
    let capturedBody;
    vi.stubGlobal('fetch', async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeResponse(200, wav);
    });
    await synthesize('Test.', { voice: 'en_US-lessac-medium', sampleRate: 8000 });
    expect(capturedBody).toMatchObject({ text: 'Test.', voice: 'en_US-lessac-medium', sample_rate: 8000 });
  });
});

// ── synthesize — error cases ──────────────────────────────────────────────────

describe('synthesize — connection refused', () => {
  it('throws PiperUnavailableError when fetch throws ECONNREFUSED', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5002'), { name: 'Error' }); });
    await expect(synthesize('hello')).rejects.toThrow(PiperUnavailableError);
  });
});

describe('synthesize — timeout', () => {
  it('throws PiperTimeoutError when AbortError is raised', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); });
    await expect(synthesize('hello')).rejects.toThrow(PiperTimeoutError);
  });
});

describe('synthesize — 503 not ready', () => {
  it('throws PiperUnavailableError on 503', async () => {
    vi.stubGlobal('fetch', async () => makeResponse(503, { status: 'not_ready', reason: 'no voices loaded' }));
    await expect(synthesize('hello')).rejects.toThrow(PiperUnavailableError);
  });
});

describe('synthesize — 400 invalid voice', () => {
  it('throws PiperSynthesisError with httpStatus=400 on voice_unavailable', async () => {
    vi.stubGlobal('fetch', async () => makeResponse(400, { detail: { error: 'voice_unavailable', available: [] } }));
    const err = await synthesize('hello').catch(e => e);
    expect(err).toBeInstanceOf(PiperSynthesisError);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('PIPER_SYNTHESIS_ERROR');
  });
});

describe('synthesize — 422 validation error', () => {
  it('throws PiperSynthesisError with httpStatus=422 on Pydantic validation error', async () => {
    vi.stubGlobal('fetch', async () => makeResponse(422, { detail: [{ loc: ['body', 'text'], msg: 'value error' }] }));
    const err = await synthesize('').catch(e => e);
    expect(err).toBeInstanceOf(PiperSynthesisError);
    expect(err.httpStatus).toBe(422);
  });
});

// ── synthesizeToFile ──────────────────────────────────────────────────────────

describe('synthesizeToFile', () => {
  it('writes WAV to disk and returns an absolute path ending in .wav', async () => {
    const { tmpdir } = await import('node:os');
    const { readFile } = await import('node:fs/promises');
    const wav = makeWavBytes();
    vi.stubGlobal('fetch', async () => makeResponse(200, wav));

    const dir  = tmpdir();
    const dest = await synthesizeToFile('Hello.', dir);

    expect(dest).toMatch(/\.wav$/);
    expect(dest.startsWith(dir)).toBe(true);
    const written = await readFile(dest);
    expect(written.slice(0, 4).toString()).toBe('RIFF');
    expect(written.length).toBe(wav.length);
  });

  it('propagates PiperUnavailableError from synthesize', async () => {
    const { tmpdir } = await import('node:os');
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('ECONNREFUSED'), { name: 'Error' }); });
    await expect(synthesizeToFile('Hello.', tmpdir())).rejects.toThrow(PiperUnavailableError);
  });
});
