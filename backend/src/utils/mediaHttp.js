// ── Shared HTTP helpers for audio stream / download responses ───────────────
// Used by mediaLibraryController and recordingController so both validate
// Range headers and escape filenames the same way.

import { createReadStream } from 'fs';

/**
 * RFC 6266 / RFC 5987 Content-Disposition value. The quoted `filename` is an
 * ASCII-only fallback (quotes, backslashes, control and non-ASCII characters
 * replaced), `filename*` carries the exact UTF-8 name. A name can therefore
 * never break out of the header or inject parameters.
 */
export function contentDisposition(type, filename) {
  const name = String(filename || 'download').replace(/[\r\n]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Send a file, honouring a single byte Range (RFC 7233) via Express's req.range():
 *   - no header, malformed header, non-bytes unit or multi-range → 200 full body
 *     (RFC 7233 lets a server ignore a Range it does not support)
 *   - unsatisfiable range → 416 with `Content-Range: bytes <asterisk>/size`
 *   - one satisfiable range → 206 with the clamped slice
 */
export function sendFileWithRange(req, res, { filePath, size, mime, disposition }) {
  const ranges = req.headers.range ? req.range(size, { combine: true }) : undefined;

  if (ranges === -1) {
    res.status(416).set({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }

  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
  if (disposition) headers['Content-Disposition'] = disposition;

  if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
    const { start, end } = ranges[0];
    res.status(206).set({ ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return pipeFile(createReadStream(filePath, { start, end }), res);
  }

  res.status(200).set({ ...headers, 'Content-Length': size });
  return pipeFile(createReadStream(filePath), res);
}

function pipeFile(stream, res) {
  stream.on('error', (err) => {
    console.error(`[media-http] read failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' });
    else res.destroy(err);
  });
  stream.pipe(res);
}
