import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { crc32, buildStoredZip, uniqueEntryNames } from '../../utils/zipStore.js';

// Minimal reader for the archives we write (store-only): walks the central directory.
function readZip(buf) {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    expect(buf.readUInt16LE(off + 8)).toBe(0);                       // stored
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + size);
    out.push({ name, crc, data, flags: buf.readUInt16LE(p + 8) });
    p += 46 + nlen;
  }
  return out;
}

describe('zipStore', () => {
  it('CRC-32 matches the standard check value and zlib (when available)', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xCBF43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    const b = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff));
    if (typeof zlib.crc32 === 'function') expect(crc32(b)).toBe(zlib.crc32(b));
  });
  it('writes a valid store-only archive: names (UTF-8 flag), bytes and CRCs round-trip', () => {
    const entries = [
      { name: 'Welcome tone.wav', data: Buffer.from('RIFF....WAVEfmt data-1') },
      { name: 'Ünïcødé – prompt.mp3', data: Buffer.from([0, 1, 2, 255, 254]) },
      { name: 'empty.wav', data: Buffer.alloc(0) },
    ];
    const files = readZip(buildStoredZip(entries));
    expect(files.map(f => f.name)).toEqual(entries.map(e => e.name));
    files.forEach((f, i) => {
      expect(Buffer.compare(f.data, entries[i].data)).toBe(0);
      expect(f.crc).toBe(crc32(entries[i].data));
      expect(f.flags & 0x0800).toBe(0x0800);
    });
  });
  it('entry names: no paths/reserved characters, extension kept, duplicates numbered', () => {
    expect(uniqueEntryNames([
      { name: '../../etc/passwd', ext: '.wav' },
      { name: 'Alarm', ext: '.WAV' },
      { name: 'alarm', ext: '.wav' },
      { name: 'alarm.wav', ext: '.wav' },
      { name: 'a:b*c?"<>|', ext: '.mp3' },
      { name: '', ext: '.bad ext' },
    ])).toEqual(['_.._etc_passwd.wav', 'Alarm.wav', 'alarm (2).wav', 'alarm (3).wav', 'a_b_c_____.mp3', 'audio']);
  });
});
