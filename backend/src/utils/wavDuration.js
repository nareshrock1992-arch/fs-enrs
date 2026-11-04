// ── Length of a WAV file from its header, for reports ─────────────────────────
//
// Walks the RIFF chunks (fmt / data) instead of assuming a 44-byte header, so WAVs with
// LIST or other chunks are measured correctly. Reads at most the first 64 KiB. Only .wav
// files inside the given directories are read (the path comes from stored records that a
// user could have influenced). Anything unreadable or unrecognised returns null, which a
// report shows as "Not recorded".
import { promises as fs } from 'fs';
import path from 'path';

const HEAD_BYTES = 64 * 1024;

/** Seconds (2 decimals) from the first bytes of a WAV file, or null. fileSize bounds the data chunk. */
export function wavDurationFromBuffer(buf, fileSize) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let p = 12;
  let byteRate = null;
  let dataSize = null;
  let dataStart = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 20 <= buf.length) byteRate = buf.readUInt32LE(p + 16);
    if (id === 'data') { dataSize = size; dataStart = p + 8; break; }
    p += 8 + size + (size % 2);
  }
  if (!byteRate || dataSize === null) return null;
  if (Number.isFinite(fileSize) && fileSize > 0) {
    const onDisk = Math.max(0, fileSize - dataStart);
    // A writer that streams leaves the size 0 or 0xFFFFFFFF until the file is closed.
    dataSize = (dataSize === 0 || dataSize === 0xFFFFFFFF) ? onDisk : Math.min(dataSize, onDisk);
  }
  return Math.round((dataSize / byteRate) * 100) / 100;
}

const inside = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** Seconds, or null when the file is not a readable .wav inside one of allowedDirs. */
export async function wavDurationSec(filePath, allowedDirs = []) {
  if (typeof filePath !== 'string' || !filePath || path.extname(filePath).toLowerCase() !== '.wav') return null;
  let real;
  try { real = await fs.realpath(filePath); } catch { return null; }
  const roots = await Promise.all(allowedDirs.filter(Boolean).map((d) => fs.realpath(d).catch(() => null)));
  if (!roots.some((r) => r && inside(real, r))) return null;
  let fd;
  try {
    fd = await fs.open(real, 'r');
    const { size } = await fd.stat();
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fd.read(buf, 0, buf.length, 0);
    return wavDurationFromBuffer(buf, size);
  } catch {
    return null;
  } finally {
    await fd?.close().catch(() => {});
  }
}
