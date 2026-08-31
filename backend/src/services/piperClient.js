/**
 * Piper TTS HTTP client.
 *
 * Pre-generates WAV audio from text by calling the Piper HTTP service.
 * FreeSWITCH Lua scripts never call Piper directly — they play stored WAV files
 * produced here.
 *
 * Error model:
 *   PiperUnavailableError — service unreachable or not yet ready (503)
 *   PiperSynthesisError   — service returned a non-transient error (4xx other than 503)
 *   PiperTimeoutError     — synthesis did not complete within config.piper.timeoutMs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { config } from '../config/index.js';
import { logger } from '../infrastructure/index.js';

const LOG = 'piperClient';

// ── Error types ───────────────────────────────────────────────────────────────

export class PiperError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PiperError';
    this.code = code;
  }
}

export class PiperUnavailableError extends PiperError {
  constructor(msg) {
    super(msg, 'PIPER_UNAVAILABLE');
    this.name = 'PiperUnavailableError';
  }
}

export class PiperTimeoutError extends PiperError {
  constructor(ms) {
    super(`Piper synthesis timed out after ${ms}ms`, 'PIPER_TIMEOUT');
    this.name = 'PiperTimeoutError';
  }
}

export class PiperSynthesisError extends PiperError {
  constructor(httpStatus, detail) {
    super(`Piper synthesis failed: HTTP ${httpStatus} — ${detail}`, 'PIPER_SYNTHESIS_ERROR');
    this.name = 'PiperSynthesisError';
    this.httpStatus = httpStatus;
  }
}

// ── Config shorthand ──────────────────────────────────────────────────────────

const { url: piperUrl, defaultVoice, timeoutMs, sampleRate: defaultRate } = config.piper;

// ── Health check ──────────────────────────────────────────────────────────────

/**
 * Returns { ok: true } when Piper is reachable and has voices loaded,
 * or { ok: false, reason } otherwise.  Never throws.
 */
export async function piperReady() {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(`${piperUrl}/ready`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, reason: body.reason ?? `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

/**
 * Synthesize text to WAV bytes via the Piper HTTP service.
 *
 * @param {string} text        Text to synthesize (1–5000 chars, after strip).
 * @param {object} [opts]
 * @param {string} [opts.voice]       Voice model (default: config.piper.defaultVoice)
 * @param {number} [opts.sampleRate]  Target sample rate Hz (default: config.piper.sampleRate)
 * @returns {Promise<Buffer>}  WAV audio data.
 * @throws {PiperUnavailableError}  Piper unreachable or not ready (503).
 * @throws {PiperTimeoutError}      Synthesis exceeded config.piper.timeoutMs.
 * @throws {PiperSynthesisError}    Piper returned a non-retryable error.
 */
export async function synthesize(text, { voice = defaultVoice, sampleRate = defaultRate } = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${piperUrl}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, voice, sample_rate: sampleRate }),
      signal:  ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new PiperTimeoutError(timeoutMs);
    throw new PiperUnavailableError(`Piper unreachable: ${e.message}`);
  }
  clearTimeout(timer);

  if (res.status === 503) {
    throw new PiperUnavailableError('Piper not ready — no voices loaded');
  }

  if (!res.ok) {
    let detail = `status=${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail?.error ?? JSON.stringify(body.detail) ?? detail;
    } catch { /* ignore JSON parse error */ }
    throw new PiperSynthesisError(res.status, detail);
  }

  const buf        = Buffer.from(await res.arrayBuffer());
  const durationMs = Math.round(Number(res.headers.get('x-audio-duration-sec') ?? 0) * 1000);
  const latencyMs  = Math.round(Number(res.headers.get('x-synthesis-latency-ms') ?? 0));

  logger.info({ module: LOG, voice, sampleRate, bytes: buf.length, durationMs, latencyMs },
    'Piper synthesis complete');

  return buf;
}

// ── Synthesis + file write ────────────────────────────────────────────────────

/**
 * Synthesize text and write the resulting WAV to a file on disk.
 * The file is placed in <destDir>/<uuid>.wav and the absolute path is returned.
 *
 * The destDir must be readable by the FreeSWITCH process so the path can be
 * passed to &playback() via ESL.
 *
 * @param {string} text     Text to synthesize.
 * @param {string} destDir  Absolute directory to write the WAV into.
 * @param {object} [opts]   Same as synthesize().
 * @returns {Promise<string>} Absolute path to the written WAV file.
 */
export async function synthesizeToFile(text, destDir, opts = {}) {
  const wavBytes = await synthesize(text, opts);
  await mkdir(destDir, { recursive: true });
  const filePath = path.join(destDir, `${randomUUID()}.wav`);
  await writeFile(filePath, wavBytes);
  logger.info({ module: LOG, filePath, bytes: wavBytes.length }, 'Piper WAV written to disk');
  return filePath;
}
