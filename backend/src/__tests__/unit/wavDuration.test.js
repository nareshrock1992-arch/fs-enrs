import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { wavDurationFromBuffer, wavDurationSec } from '../../utils/wavDuration.js';

// 8 kHz mono 16-bit PCM (byte rate 16000), optionally with a LIST chunk before "data".
function wav(seconds, { list = false, dataSizeField } = {}) {
  const data = Buffer.alloc(Math.round(16000 * seconds));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(16000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const extra = list ? Buffer.concat([Buffer.from('LIST'), Buffer.from([10, 0, 0, 0]), Buffer.from('INFOabcdef')]) : Buffer.alloc(0);
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(dataSizeField ?? data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, dh, data]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('wavDurationFromBuffer', () => {
  it('reads the length from the fmt / data chunks', () => {
    const b = wav(2.5);
    expect(wavDurationFromBuffer(b, b.length)).toBe(2.5);
  });
  it('is correct with extra chunks before data (a fixed 44-byte header would be wrong)', () => {
    const b = wav(3, { list: true });
    expect(wavDurationFromBuffer(b, b.length)).toBe(3);
  });
  it('a streaming placeholder size (0 or 0xFFFFFFFF) uses the bytes on disk', () => {
    for (const f of [0, 0xFFFFFFFF]) { const b = wav(1.5, { dataSizeField: f }); expect(wavDurationFromBuffer(b, b.length)).toBe(1.5); }
  });
  it('anything that is not a WAV gives null', () => {
    for (const b of [Buffer.from('ID3 not a wav at all...'), Buffer.alloc(4), Buffer.from('RIFF\0\0\0\0AVI LIST')]) expect(wavDurationFromBuffer(b, b.length)).toBeNull();
    expect(wavDurationFromBuffer('x', 1)).toBeNull();
  });
});

describe('wavDurationSec (file access)', () => {
  let root, sounds, outside;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wavdur-'));
    sounds = path.join(root, 'sounds'); outside = path.join(root, 'outside');
    mkdirSync(sounds); mkdirSync(outside);
    writeFileSync(path.join(sounds, 'tts.wav'), wav(4));
    writeFileSync(path.join(outside, 'secret.wav'), wav(9));
    writeFileSync(path.join(sounds, 'notes.txt'), 'x');
    try { symlinkSync(path.join(outside, 'secret.wav'), path.join(sounds, 'link.wav')); } catch { /* no symlinks on this FS */ }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads a .wav inside an allowed directory', async () => {
    expect(await wavDurationSec(path.join(sounds, 'tts.wav'), [sounds])).toBe(4);
  });
  it('refuses files outside the allowed directories, also through a symlink or ../', async () => {
    expect(await wavDurationSec(path.join(outside, 'secret.wav'), [sounds])).toBeNull();
    expect(await wavDurationSec(path.join(sounds, '..', 'outside', 'secret.wav'), [sounds])).toBeNull();
    expect(await wavDurationSec(path.join(sounds, 'link.wav'), [sounds])).toBeNull();
  });
  it('missing, non-.wav or empty input gives null (shown as "Not recorded")', async () => {
    for (const p of [path.join(sounds, 'gone.wav'), path.join(sounds, 'notes.txt'), '', null, undefined]) expect(await wavDurationSec(p, [sounds])).toBeNull();
    expect(await wavDurationSec(path.join(sounds, 'tts.wav'), [])).toBeNull();
  });
});
