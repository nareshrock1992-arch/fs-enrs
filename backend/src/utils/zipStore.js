// ── Minimal ZIP support (no dependency) ───────────────────────────────────────
//
// Writer: STORE-only (no compression). Audio (WAV/MP3) barely compresses, so entries
// are stored. CRC-32 uses a bundled table: zlib.crc32 only exists from Node 20.15 /
// 22.2 and package.json allows Node >= 20. Classic ZIP limits apply (no ZIP64):
// < 65 535 entries and every size/offset < 4 GiB — callers enforce far smaller caps.
// Names are UTF-8 (flag 11).
//
// Reader (readZip, below): bounded reader for uploaded archives (stored and deflated
// entries), used for .xlsx imports. Every limit is checked before data is inflated.

import { inflateRawSync } from 'zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date/time of `d` (local time, 2-second resolution; 1980 is the floor).
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX = 0xFFFFFFFF;

/**
 * Build a ZIP from in-memory entries.
 * @param entries [{ name: string, data: Buffer, mtime?: Date }]
 * @returns Buffer
 */
export function buildStoredZip(entries) {
  if (entries.length >= 0xFFFF) throw new Error('too many zip entries');
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    if (data.length >= MAX || offset >= MAX) throw new Error('zip too large (no ZIP64)');
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime || new Date());

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header
    lh.writeUInt16LE(20, 4);           // version needed (2.0)
    lh.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    lh.writeUInt16LE(0, 8);            // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);           // extra length
    local.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory header
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attrs = 0; external attrs = 0
    ch.writeUInt32LE(offset, 42);      // offset of the local header
    central.push(ch, name);

    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);    // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ── Bounded ZIP reader ────────────────────────────────────────────────────────

export class ZipReadError extends Error {
  /** code: 'ZIP_INVALID' (not a usable archive) or 'ZIP_LIMIT' (a size / count limit) */
  constructor(message, code = 'ZIP_INVALID') {
    super(message);
    this.name = 'ZipReadError';
    this.code = code;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MB = 1024 * 1024;

// Relative, normalised names only: no absolute paths, drive letters, backslashes,
// control characters or "." / ".." segments (path traversal).
function safeEntryName(name) {
  if (!name || name.length > 1024 || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[\\\u0000-\u001f]/.test(name)) return false;
  return name.split('/').every((seg, i, all) => seg !== '.' && seg !== '..' && (seg !== '' || i === all.length - 1));
}

/**
 * Read the directory of a ZIP archive held in memory. Nothing is inflated until
 * `read(name)` is called, and every limit is checked first:
 *   - at most `maxEntries` entries;
 *   - each entry at most `maxEntryBytes` uncompressed (declared and actual size);
 *   - declared total and actually inflated total at most `maxTotalBytes`;
 *   - stored or deflated entries only; no encryption, ZIP64, multi-disk archives,
 *     duplicate or unsafe names, overlapping data or checksum mismatches.
 * @returns {{ names: string[], has(name): boolean, read(name): Buffer|null }}
 */
export function readZip(buf, { maxEntries = 200, maxEntryBytes = 64 * MB, maxTotalBytes = 128 * MB } = {}) {
  const invalid = (msg = 'The file is not a valid ZIP archive') => new ZipReadError(msg, 'ZIP_INVALID');
  const limit = (msg) => new ZipReadError(msg, 'ZIP_LIMIT');
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw invalid();

  let eocd = -1;
  for (let i = buf.length - 22, stop = Math.max(0, buf.length - 22 - 0xFFFF); i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw invalid();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) {
    throw invalid('Multi-part ZIP archives are not supported');
  }
  if (count === 0xFFFF || cdSize === MAX || cdOffset === MAX) throw invalid('ZIP64 archives are not supported');
  if (count > maxEntries) throw limit(`The archive has more than ${maxEntries} parts`);
  if (cdOffset + cdSize > eocd) throw invalid();

  const entries = new Map();
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== SIG_CENTRAL) throw invalid();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const end = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (end > cdOffset + cdSize) throw invalid();
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p = end;
    if (flags & 0x0001) throw invalid('Encrypted (password-protected) archives are not supported');
    if (method !== 0 && method !== 8) throw invalid('The archive uses an unsupported compression method');
    if (csize === MAX || usize === MAX || local === MAX) throw invalid('ZIP64 archives are not supported');
    if (!safeEntryName(name)) throw invalid('The archive contains an unsafe file path');
    if (entries.has(name)) throw invalid('The archive contains the same part twice');
    if (method === 0 && csize !== usize) throw invalid();
    if (usize > maxEntryBytes) throw limit(`A part of the archive is larger than ${maxEntryBytes / MB} MB uncompressed`);
    declaredTotal += usize;
    if (declaredTotal > maxTotalBytes) throw limit(`The archive is larger than ${maxTotalBytes / MB} MB uncompressed`);
    entries.set(name, { method, crc, csize, usize, local });
  }

  let inflatedTotal = 0;
  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (e.local + 30 > cdOffset || buf.readUInt32LE(e.local) !== SIG_LOCAL) throw invalid();
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    if (start + e.csize > cdOffset) throw invalid();
    const raw = buf.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else {
      // maxOutputLength stops a part that inflates beyond its declared size (zip bomb).
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) }); } catch { throw invalid('A part of the archive is corrupt or larger than declared'); }
    }
    if (data.length !== e.usize || crc32(data) !== e.crc) throw invalid('A part of the archive is corrupt');
    inflatedTotal += data.length;
    if (inflatedTotal > maxTotalBytes) throw limit(`The archive is larger than ${maxTotalBytes / MB} MB uncompressed`);
    return data;
  }

  return { names: [...entries.keys()], has: (name) => entries.has(name), read };
}

/**
 * Safe, unique entry names: no directories, no control or reserved characters,
 * keeps the extension, and "name (2).wav" for duplicates.
 */
export function uniqueEntryNames(items) {
  const used = new Set();
  return items.map(({ name, ext }) => {
    let base = String(name || 'audio')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 120) || 'audio';
    const e = /^\.[A-Za-z0-9]{1,8}$/.test(ext || '') ? ext.toLowerCase() : '';
    if (e && base.toLowerCase().endsWith(e)) base = base.slice(0, -e.length);
    let candidate = `${base}${e}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${e}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
