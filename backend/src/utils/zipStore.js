// ── Minimal STORE-only ZIP writer (no compression, no dependency) ─────────────
//
// Audio (WAV/MP3) barely compresses, so entries are stored. CRC-32 uses a bundled
// table: zlib.crc32 only exists from Node 20.15 / 22.2 and package.json allows
// Node >= 20. Classic ZIP limits apply (no ZIP64): < 65 535 entries and every
// size/offset < 4 GiB — callers enforce far smaller caps. Names are UTF-8 (flag 11).

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

/**
 * Safe, unique entry names: no directories, no control or reserved characters,
 * keeps the extension, and "name (2).wav" for duplicates.
 */
export function uniqueEntryNames(items) {
  const used = new Set();
  return items.map(({ name, ext }) => {
    let base = String(name || 'audio')
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
