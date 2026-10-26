// ── /uploads — authenticated, tenant-checked file access ──────────────────────
//
// Previously `express.static('./uploads')`: any uploaded audio of any tenant was
// served to anyone, with no login. The URL keeps working for authorised callers
// (Bearer, or the deprecated ?token= for browser links), but a file is served
// only when it belongs to a live media_files row the caller may see:
//   - SUPER_ADMIN: any row
//   - everyone else: rows of their own tenant, or shared rows (tenant_id NULL,
//     legacy/system audio — same rule as the legacy /deployment/audio list)
// Anything else — unknown, deleted, other tenant, traversal, dotfile — is a 404,
// so the response never reveals whether another tenant's file exists.

import path from 'path';
import { promises as fs } from 'fs';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { effectiveTenantId } from './tenantScope.js';

const notFound = (res) => res.status(404).json({ error: 'Not found' });

export async function serveUpload(req, res, next) {
  try {
    const root = path.resolve(config.uploads.dir);
    let rel;
    try { rel = decodeURIComponent(req.path || ''); } catch { return notFound(res); }
    rel = rel.replace(/^\/+/, '');
    const segments = rel.split(/[\\/]/);
    if (!rel || rel.includes('\0') || segments.some(s => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
      return notFound(res);
    }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return notFound(res);

    const tenantId = effectiveTenantId(req);          // SUPER_ADMIN → null (all); others → own tenant or 403
    const base = path.basename(abs);
    const { rows } = await query(
      `SELECT path_or_uri FROM media_files
        WHERE deleted_at IS NULL
          AND right(path_or_uri, $1) = $2
          AND ($3::int IS NULL OR tenant_id = $3 OR tenant_id IS NULL)`,
      [base.length + 1, `/${base}`, tenantId],
    );
    if (!rows.some(r => path.resolve(r.path_or_uri) === abs)) return notFound(res);

    // Symlink-safe: the REAL path must still be inside the REAL upload root, and it
    // must be a regular file (path.resolve above only normalises the text).
    let real;
    try {
      const [realRoot, realFile, st] = await Promise.all([fs.realpath(root), fs.realpath(abs), fs.lstat(abs)]);
      if (!st.isFile() || !realFile.startsWith(realRoot + path.sep)) return notFound(res);
      real = realFile;
    } catch { return notFound(res); }

    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(real, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) notFound(res);
    });
  } catch (err) {
    return next(err);
  }
}
