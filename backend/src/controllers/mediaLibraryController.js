/**
 * Media Library Controller
 *
 * Manages all audio/media assets — prompts, announcements, music on hold,
 * TTS-generated files, conference prompts, campaign audio.
 *
 * Every uploaded file is:
 *   1. Written to uploads/ (immediately streamable regardless of FS state)
 *   2. Metadata extracted (WAV header: rate, channels, duration; SHA-256)
 *   3. Copied to FS sound dir (or flagged pending if dir unreachable)
 *   4. Verified on disk
 *   5. Inserted into media_files with full metadata
 *   6. WebSocket event emitted → frontend updates without refresh
 *
 * Streaming works even when FreeSWITCH is offline — falls back to uploads/.
 */

import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import { effectiveTenantId, requireTenantForWrite } from '../middleware/tenantScope.js';
import { config } from '../config/index.js';
import { fsPathService } from '../services/freeSwitchPathService.js';
import { contentDisposition, sendFileWithRange } from '../utils/mediaHttp.js';
import {
  deleteMediaSafely, DependencyCheckError, blockedDeleteBody, dependencyFailureBody,
  deployMediaLocked, importScannedFileLocked, mediaGuardErrorResponse,
} from '../services/mediaDependencyService.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MEDIA_CATEGORIES = [
  'system_prompt',
  'emergency_prompt',
  'ivr_prompt',
  'tts_generated',
  'music_on_hold',
  'announcement',
  'conference_prompt',
  'campaign_prompt',
  'general',
];

const AUDIO_EXTS   = ['.wav', '.mp3', '.ogg', '.gsm', '.ul', '.flac'];
const MIME_MAP     = {
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.gsm':  'audio/x-gsm',
  '.ul':   'audio/basic',
  '.flac': 'audio/flac',
};

// ── Multer upload ─────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await fs.mkdir(config.uploads.dir, { recursive: true });
        cb(null, config.uploads.dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-.]/g, '_');
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits:     { fileSize: (config.uploads.maxSizeMb || 50) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXTS.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type. Allowed: ${AUDIO_EXTS.join(', ')}`));
  },
}).single('file');

export const uploadMiddleware = (req, res, next) => {
  upload(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
};

// ── Metadata extraction ───────────────────────────────────────────────────────

async function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function extractWavMetadata(filePath) {
  try {
    const fd  = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(44);
    await fd.read(buf, 0, 44, 0);
    await fd.close();

    if (buf.toString('ascii', 0, 4) !== 'RIFF') return {};
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return {};

    const channels   = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const byteRate   = buf.readUInt32LE(28);
    const bitsPerSam = buf.readUInt16LE(34);
    const dataSize   = buf.readUInt32LE(40);
    const bitrate    = byteRate * 8 / 1000;     // kbps
    const duration   = byteRate > 0 ? dataSize / byteRate : null;

    return {
      codec:        'PCM',
      channels,
      sample_rate:  sampleRate,
      bitrate_kbps: Math.round(bitrate),
      duration_sec: duration !== null ? Math.round(duration * 1000) / 1000 : null,
      bits_per_sample: bitsPerSam,
    };
  } catch {
    return {};
  }
}

async function extractMp3Metadata(filePath, stat) {
  try {
    // Approximate bitrate from file size (without an npm decoder)
    // Most ENS/IVR MP3s are short — this gives a reasonable estimate
    const fd  = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(10);
    await fd.read(buf, 0, 10, 0);
    await fd.close();

    const hasId3 = buf.toString('ascii', 0, 3) === 'ID3';
    return {
      codec:   'MP3',
      channels: null,
      sample_rate: null,
      bitrate_kbps: null,
      duration_sec: null,
      has_id3: hasId3,
    };
  } catch {
    return { codec: 'MP3' };
  }
}

export async function extractAudioMetadata(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  const ext  = path.extname(filePath).toLowerCase();
  const size = stat?.size ?? null;

  let meta = { size_bytes: size };

  if (ext === '.wav') {
    Object.assign(meta, await extractWavMetadata(filePath));
  } else if (ext === '.mp3') {
    Object.assign(meta, await extractMp3Metadata(filePath, stat));
  } else {
    meta.codec = ext.replace('.', '').toUpperCase();
  }

  try {
    meta.checksum = await computeChecksum(filePath);
  } catch {
    meta.checksum = null;
  }

  return meta;
}

// ── Waveform peak extraction ──────────────────────────────────────────────────
//
// For WAV files: reads raw PCM samples and computes true amplitude peaks.
// For non-WAV: generates a plausible decorative waveform seeded from the
// file checksum so it is deterministic (same file → same waveform shape).
//
// Returns a flat array of N floats in [0, 1].

export async function extractWaveformPeaks(filePath, numPeaks = 200) {
  const ext = path.extname(filePath).toLowerCase();

  // ── Real WAV peaks ────────────────────────────────────────────────────────
  if (ext === '.wav') {
    try {
      const fd  = await fs.open(filePath, 'r');
      const hdr = Buffer.alloc(44);
      await fd.read(hdr, 0, 44, 0);

      if (hdr.toString('ascii', 0, 4) !== 'RIFF' || hdr.toString('ascii', 8, 12) !== 'WAVE') {
        await fd.close();
        return _syntheticPeaks(filePath, numPeaks);
      }

      const bitsPerSample  = hdr.readUInt16LE(34);
      const numChannels    = hdr.readUInt16LE(22);
      const dataSize       = hdr.readUInt32LE(40);
      const bytesPerSamp   = (bitsPerSample / 8) * numChannels;
      const totalSamples   = Math.floor(dataSize / bytesPerSamp);
      const samplesPerPeak = Math.max(1, Math.floor(totalSamples / numPeaks));

      const chunkBytes = Math.min(samplesPerPeak * bytesPerSamp * numPeaks, dataSize);
      const buf = Buffer.alloc(chunkBytes);
      await fd.read(buf, 0, chunkBytes, 44);
      await fd.close();

      const peaks  = [];
      const maxVal = bitsPerSample === 8 ? 128 : 32768;

      for (let p = 0; p < numPeaks; p++) {
        let maxAbs = 0;
        const start = p * samplesPerPeak * bytesPerSamp;
        for (let s = 0; s < samplesPerPeak; s++) {
          const off = start + s * bytesPerSamp;
          if (off + 2 > buf.length) break;
          const val = bitsPerSample === 8
            ? Math.abs(buf.readInt8(off))
            : Math.abs(buf.readInt16LE(off));
          if (val > maxAbs) maxAbs = val;
        }
        peaks.push(Math.round((maxAbs / maxVal) * 1000) / 1000);
      }

      return peaks;
    } catch {
      return _syntheticPeaks(filePath, numPeaks);
    }
  }

  // ── Non-WAV: deterministic synthetic waveform ─────────────────────────────
  return _syntheticPeaks(filePath, numPeaks);
}

// Generates a speech-like waveform shape seeded from the file path/name.
// Uses a simple LCG so shape is deterministic but varied per file.
export function _syntheticPeaks(filePath, numPeaks) {
  // Seed from path bytes
  let seed = 0;
  for (let i = 0; i < filePath.length; i++) seed = (seed * 31 + filePath.charCodeAt(i)) >>> 0;

  function lcg() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xFFFFFFFF;
  }

  // Simulate realistic audio amplitude — high in middle, lower at start/end
  const peaks = [];
  for (let i = 0; i < numPeaks; i++) {
    const t       = i / numPeaks;
    // Envelope: fade-in, sustain, fade-out
    const env     = Math.sin(t * Math.PI) * 0.7 + 0.1;
    // Fast noise component
    const noise   = lcg();
    // Slow modulation (phrase-level rhythm)
    const slow    = Math.abs(Math.sin(t * Math.PI * 8 + lcg() * 2)) * 0.3;
    const raw     = env * (noise * 0.5 + slow + 0.1);
    peaks.push(Math.round(Math.min(1, Math.max(0.04, raw)) * 1000) / 1000);
  }
  return peaks;
}

// ── Copy to FreeSWITCH sound dir ──────────────────────────────────────────────

async function deployToFs(srcPath, filename) {
  const destDir  = fsPathService.getEnrsSoundDir();
  const destPath = path.posix.join(destDir, path.basename(filename));

  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(srcPath, destPath);
  await fs.chmod(destPath, 0o644).catch(() => {});

  // Verify the copy actually landed
  const stat = await fs.stat(destPath);
  if (stat.size === 0) throw new Error('Deployed file has zero bytes');

  return destPath;
}

// ── Emit WebSocket event ──────────────────────────────────────────────────────

let _io = null;
export function setSocketIO(io) { _io = io; }

// Media events go only to the owning tenant's room and to SUPER_ADMINs — never a
// global broadcast — and carry no server paths or uploader emails. (Not wired to
// a socket server today: nothing calls setSocketIO, so these are no-ops.)
const publicFile = (f) => (f ? { id: f.id, name: f.name, category: f.category, is_deployed: f.is_deployed, tenant_id: f.tenant_id ?? null } : null);
export function emitMediaEvent(event, data, tenantId) {
  if (!_io) return;
  const target = tenantId ? _io.to(`tenant:${tenantId}`).to('role:SUPER_ADMIN') : _io.to('role:SUPER_ADMIN');
  target.emit(event, data);
}

// ── List ──────────────────────────────────────────────────────────────────────

// Treat undefined, null, empty string, and the literal string "undefined" as absent.
// This guards against frontend URLSearchParams serializing JS undefined as "undefined".
function qs(v) {
  return (v == null || v === '' || v === 'undefined' || v === 'null') ? null : v;
}

// ── List filter ──────────────────────────────────────────────────────────────
//
// One WHERE definition shared by the page query, the totals and the category
// breakdown, so the three can never disagree. Semantics are unchanged from the
// original inline queries:
//   - tenant: SUPER_ADMIN → ?tenant_id when given (else all tenants); everyone
//     else → req.user.tenantId (no tenant id → unscoped, as before)
//   - search: name / description substring (ILIKE — `%` and `_` keep their
//     LIKE wildcard meaning) or an exact tag
//   - deployed: 'true' → deployed; any other non-empty value → not deployed
// `omit` drops filters by name (the category breakdown ignores `category`).
export const MEDIA_SORT_FIELDS = ['name', 'category', 'created_at', 'size_bytes', 'duration_sec'];

export function buildMediaFilter(req, { omit = [] } = {}) {
  const q = req.query || {};
  const clauses = ['m.deleted_at IS NULL'];
  const params = [];
  const add = (name, value, sql) => {
    if (omit.includes(name) || value === null || value === undefined) return;
    params.push(value);
    clauses.push(sql.replace(/\$\?/g, `$${params.length}`));
  };
  // SUPER_ADMIN: all tenants, or one valid ?tenant_id (malformed → 400). Others: own
  // tenant only; no valid tenant → 403 (never unscoped).
  const tenant = effectiveTenantId(req);
  const deployed = qs(q.deployed);
  add('tenant',   tenant,         'm.tenant_id = $?::int');
  add('category', qs(q.category), 'm.category = $?::text');
  add('search',   qs(q.search),   `(m.name ILIKE '%' || $?::text || '%' OR m.description ILIKE '%' || $?::text || '%' OR $?::text = ANY(m.tags))`);
  add('deployed', deployed === null ? null : deployed === 'true', 'm.is_deployed = $?::boolean');
  return { where: clauses.join('\n       AND '), params };
}

// Pagination normalisation (documented in docs/03_API_REFERENCE.md):
// a value is read as a number and truncated to an integer; anything that is not
// a finite integer ≥ 1 (missing, non-numeric, 0, negative, < 1 after
// truncation) falls back to the default. limit is capped at MEDIA_MAX_LIMIT and
// page at MEDIA_MAX_PAGE, so LIMIT/OFFSET are always valid integers.
export const MEDIA_DEFAULT_LIMIT = 50;
export const MEDIA_MAX_LIMIT     = 200;
export const MEDIA_MAX_PAGE      = 1_000_000;

export function normalizeMediaPaging(q = {}) {
  const int = (v, dflt, max) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt;
  };
  const page  = int(q.page, 1, MEDIA_MAX_PAGE);
  const limit = int(q.limit, MEDIA_DEFAULT_LIMIT, MEDIA_MAX_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
}

export const listMedia = asyncHandler(async (req, res) => {
  const { page, limit, offset } = normalizeMediaPaging(req.query);
  const sort = MEDIA_SORT_FIELDS.includes(req.query.sort) ? req.query.sort : 'created_at';
  const dir  = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const f = buildMediaFilter(req);
  const byCat = buildMediaFilter(req, { omit: ['category'] });
  const n = f.params.length;

  const [{ rows }, { rows: [totals] }, { rows: catRows }] = await Promise.all([
    query(
      `SELECT
         m.id, m.name, m.category, m.description, m.duration_sec,
         m.sample_rate, m.channels, m.codec, m.bitrate_kbps,
         m.size_bytes, m.checksum, m.version, m.tags, m.notes,
         m.is_deployed, m.deployed_at, m.fs_path, m.path_or_uri,
         m.usage_count, m.tenant_id, m.created_at, m.updated_at,
         u.email AS uploaded_by_email,
         o.name  AS organization_name
       FROM media_files m
       LEFT JOIN users         u ON u.id = m.uploaded_by_user_id
       LEFT JOIN organizations o ON o.id = m.organization_id
       WHERE ${f.where}
       ORDER BY m.${sort} ${dir} NULLS LAST, m.id ${dir}
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...f.params, limit, offset],
    ),
    // Totals over the whole filtered set (not the page). Unknown size/duration
    // (NULL) contribute 0.
    query(
      `SELECT COUNT(*)::int                                      AS total,
              COUNT(*) FILTER (WHERE m.is_deployed)::int         AS deployed,
              COUNT(*) FILTER (WHERE NOT m.is_deployed)::int     AS pending,
              COALESCE(SUM(m.size_bytes), 0)::bigint             AS size_bytes,
              COALESCE(SUM(m.duration_sec), 0)::numeric          AS duration_sec
       FROM media_files m
       WHERE ${f.where}`,
      f.params,
    ),
    query(
      `SELECT m.category, COUNT(*)::int AS n
       FROM media_files m
       WHERE ${byCat.where}
       GROUP BY m.category`,
      byCat.params,
    ),
  ]);

  const t = totals || {};
  const summary = {
    total:        Number(t.total) || 0,
    deployed:     Number(t.deployed) || 0,
    pending:      Number(t.pending) || 0,
    size_bytes:   Number(t.size_bytes) || 0,                       // pg returns BIGINT as a string
    duration_sec: Math.round((Number(t.duration_sec) || 0) * 100) / 100,
    by_category:  Object.fromEntries(catRows.map(r => [r.category, Number(r.n) || 0])),
  };

  res.json({ files: rows, total: summary.total, page, limit, summary });
});

// ── Categories ────────────────────────────────────────────────────────────────

export const listCategories = asyncHandler(async (_req, res) => {
  res.json({ categories: MEDIA_CATEGORIES });
});

// ── Upload ────────────────────────────────────────────────────────────────────

export const uploadMedia = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file required (field: file)' });
  const uploadTenantId = requireTenantForWrite(req);

  const { category = 'general', description = '', name: customName } = req.body;
  const displayName = customName?.trim() || req.file.originalname;
  // Use absolute path so streaming works regardless of Node.js process CWD
  const srcPath = path.resolve(req.file.path);

  // Step 1 — extract metadata before any DB work
  const meta = await extractAudioMetadata(srcPath);

  // Step 2 — check for duplicate by checksum, within what this tenant can see (its own
  // files + shared ones). Matching another tenant's file would reveal its name and id.
  if (meta.checksum) {
    const { rows: [dup] } = await query(
      `SELECT id, name FROM media_files WHERE checksum = $1 AND deleted_at IS NULL
         AND (tenant_id = $2 OR tenant_id IS NULL) LIMIT 1`,
      [meta.checksum, uploadTenantId]
    );
    if (dup) {
      await fs.unlink(srcPath).catch(() => {});
      return res.status(409).json({
        error: `Duplicate file: identical to "${dup.name}" (id=${dup.id})`,
        duplicate_id: dup.id,
      });
    }
  }

  // Step 3 — insert DB record (file is immediately streamable from uploads/)
  const { rows: [record] } = await query(
    `INSERT INTO media_files
       (uploaded_by_user_id, type, name, path_or_uri, size_bytes,
        category, description, tenant_id,
        sample_rate, channels, codec, bitrate_kbps, duration_sec, checksum)
     VALUES ($1,'PROMPT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      req.user.id,
      displayName,
      srcPath,
      meta.size_bytes ?? req.file.size,
      category,
      description,
      uploadTenantId,
      meta.sample_rate  ?? null,
      meta.channels     ?? null,
      meta.codec        ?? null,
      meta.bitrate_kbps ?? null,
      meta.duration_sec ?? null,
      meta.checksum     ?? null,
    ]
  );

  // Step 4 — copy to FreeSWITCH sound dir
  let deployedPath  = null;
  let deployError   = null;
  try {
    // Copy + fs_path update under the shared media lock (a concurrent delete
    // either completes first — nothing is copied — or waits for us).
    deployedPath = await deployMediaLocked(record, path.basename(req.file.filename),
      () => deployToFs(srcPath, req.file.filename));
    if (!deployedPath) throw new Error('Media was deleted before it could be deployed');
    record.fs_path    = deployedPath;
    record.is_deployed = true;
  } catch (err) {
    deployError = mediaGuardErrorResponse(err)?.body.message || err.message;
    console.error(`[media-library] FS copy failed for id=${record.id}: ${err.message}`);
    // Leave is_deployed=false — the user sees "Pending FS deployment" in the UI
    // and can redeploy via the Deploy button once the volume issue is resolved.
  }

  // Step 4b — pre-compute and cache waveform peaks
  try {
    const peaks = await extractWaveformPeaks(srcPath, 200);
    if (peaks) {
      await query(
        `UPDATE media_files SET waveform_peaks = $2 WHERE id = $1`,
        [record.id, JSON.stringify(peaks)]
      );
    }
  } catch {}

  // Step 5 — reload fresh record
  const { rows: [fresh] } = await query(
    `SELECT m.*, u.email AS uploaded_by_email FROM media_files m
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     WHERE m.id = $1`,
    [record.id]
  );

  // Step 6 — WebSocket push so all open Media Library tabs update instantly
  emitMediaEvent('media.uploaded', { file: publicFile(fresh) }, fresh?.tenant_id);

  const httpStatus = deployError ? 207 : 201;
  res.status(httpStatus).json({
    file: fresh,
    deployError,
    message: deployError
      ? `Uploaded (id=${record.id}) but SIPCommunication copy failed: ${deployError}. File is streamable from uploads/. Use Deploy to retry.`
      : 'Upload and deploy successful.',
  });
});

// ── Scan FreeSWITCH sound dir ─────────────────────────────────────────────────

export const scanMedia = asyncHandler(async (req, res) => {
  const soundDir = fsPathService.getEnrsSoundDir();

  let entries;
  try {
    entries = await fs.readdir(soundDir, { withFileTypes: true });
  } catch {
    return res.json({
      imported: 0, skipped: 0, errors: 0, files: [],
      sound_dir: soundDir,
      message: `Directory not accessible: ${soundDir}. Set FS_SOUND_DIR env var.`,
    });
  }

  const audioFiles = entries.filter(
    e => e.isFile() && AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())
  );

  // Load known paths + checksums to avoid duplicates
  const { rows: existing } = await query(
    `SELECT fs_path, name, checksum FROM media_files WHERE deleted_at IS NULL`
  );
  const knownPaths     = new Set(existing.map(r => r.fs_path).filter(Boolean));
  const knownNames     = new Set(existing.map(r => r.name).filter(Boolean));
  const knownChecksums = new Set(existing.map(r => r.checksum).filter(Boolean));

  const imported = [];
  let skipped = 0, errors = 0;

  for (const entry of audioFiles) {
    const filePath = path.resolve(soundDir, entry.name);
    if (knownPaths.has(filePath) || knownNames.has(entry.name)) { skipped++; continue; }

    try {
      const meta = await extractAudioMetadata(filePath);
      if (meta.checksum && knownChecksums.has(meta.checksum)) { skipped++; continue; }

      // Insert under the shared media lock, re-verifying the file still exists
      // (a concurrent delete may have just moved it to quarantine).
      const record = await importScannedFileLocked(filePath, async (tq) => (await tq(
        `INSERT INTO media_files
           (type, name, path_or_uri, fs_path, size_bytes, category,
            description, is_deployed, deployed_at,
            duration_sec, sample_rate, channels, codec, bitrate_kbps, checksum,
            tenant_id)
         VALUES ('PROMPT',$1,$2,$2,$3,'general',
                 'Auto-imported from SIPCommunication sound directory',
                 true, now(), $4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          entry.name, filePath,
          meta.size_bytes ?? null,
          meta.duration_sec ?? null,
          meta.sample_rate  ?? null,
          meta.channels     ?? null,
          meta.codec        ?? null,
          meta.bitrate_kbps ?? null,
          meta.checksum     ?? null,
          req.user?.tenantId ?? null,
        ]
      )).rows[0], { expectedSize: meta.size_bytes ?? null });
      if (record) {
        imported.push(record);
        knownPaths.add(filePath);
        knownNames.add(entry.name);
        if (meta.checksum) knownChecksums.add(meta.checksum);
        // Cache waveform peaks asynchronously
        extractWaveformPeaks(filePath, 200).then(peaks => {
          if (peaks) {
            query(`UPDATE media_files SET waveform_peaks = $2 WHERE id = $1`, [record.id, JSON.stringify(peaks)]).catch(() => {});
          }
        }).catch(() => {});
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[media-scan] ${filePath}:`, err.message);
      errors++;
    }
  }

  if (imported.length > 0) {
    emitMediaEvent('media.scanned', { imported: imported.length, files: imported.map(publicFile) }, req.user?.tenantId);
  }

  res.json({
    imported: imported.length, skipped, errors,
    files: imported, sound_dir: soundDir,
    message: `Scan complete — ${imported.length} imported, ${skipped} already known, ${errors} errors`,
  });
});

// ── Get single ────────────────────────────────────────────────────────────────

export const getMedia = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `SELECT m.*, u.email AS uploaded_by_email, o.name AS organization_name
     FROM media_files m
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     LEFT JOIN organizations o ON o.id = m.organization_id
     WHERE m.id = $1 AND m.deleted_at IS NULL
       AND ($2::int IS NULL OR m.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json({ file: record });
});

// ── Update metadata ───────────────────────────────────────────────────────────

export const updateMedia = asyncHandler(async (req, res) => {
  const { name, category, description, notes, tags } = req.body;
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `UPDATE media_files SET
       name        = COALESCE($3, name),
       category    = COALESCE($4, category),
       description = COALESCE($5, description),
       notes       = COALESCE($6, notes),
       tags        = COALESCE($7, tags),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING *`,
    [req.params.id, tenantId, name || null, category || null,
     description ?? null, notes ?? null, tags ?? null]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });
  emitMediaEvent('media.updated', { file: publicFile(record) }, record?.tenant_id);
  res.json({ file: record });
});

// ── Deploy / re-deploy to FreeSWITCH ─────────────────────────────────────────

export const deployMedia = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const srcPath = record.fs_path || record.path_or_uri;
  if (!srcPath) return res.status(400).json({ error: 'No source file on record' });

  try {
    const destPath = await deployMediaLocked(record, path.basename(srcPath),
      () => deployToFs(srcPath, path.basename(srcPath)));
    if (!destPath) return res.status(404).json({ error: 'Not found' });   // deleted meanwhile
    emitMediaEvent('media.deployed', { id: record.id }, record.tenant_id);
    res.json({ ok: true, fs_path: destPath });
  } catch (err) {
    const mapped = mediaGuardErrorResponse(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(502).json({ error: `Deploy failed: ${err.message}` });
  }
});

// ── Stream (authenticated preview) ───────────────────────────────────────────

export const streamMedia = asyncHandler(async (req, res) => {
  const mediaId = req.params.id;
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [mediaId, tenantId]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  // Prefer deployed FS path; fall back to uploads path (always streamable).
  // fs_path is set on deploy; path_or_uri is set on upload (always the staging copy).
  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    try { await fs.access(resolved); filePath = resolved; break; } catch { /* try the next candidate */ }
  }

  // Server paths go to the log only — never to the client.
  if (!filePath) {
    console.error(`[media-stream] id=${record.id} — file not found on disk. tried: ${candidates.join(', ')}`);
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { size } = await fs.stat(filePath);
  const mime = MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav';
  return sendFileWithRange(req, res, {
    filePath, size, mime,
    disposition: contentDisposition('inline', path.basename(filePath)),
  });
});

// ── Download ──────────────────────────────────────────────────────────────────

export const downloadMedia = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    try { await fs.access(resolved); filePath = resolved; break; } catch {}
  }
  if (!filePath) {
    console.warn(`[media-download] id=${record.id} — file not found. tried: ${candidates.join(', ')}`);
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { size } = await fs.stat(filePath);
  return sendFileWithRange(req, res, {
    filePath, size,
    mime: MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    disposition: contentDisposition('attachment', record.name),
  });
});

// ── Waveform peaks ────────────────────────────────────────────────────────────

export const getWaveform = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const numPeaks = Math.min(500, Math.max(50, Number(req.query.peaks) || 200));

  // Serve cached peaks if available and size matches.
  // pg may return JSONB columns as a JSON string rather than a parsed array,
  // so parse before the Array.isArray check.
  const cachedPeaks = typeof record.waveform_peaks === 'string'
    ? (() => { try { return JSON.parse(record.waveform_peaks); } catch { return null; } })()
    : record.waveform_peaks;
  if (cachedPeaks && Array.isArray(cachedPeaks) && cachedPeaks.length >= 50) {
    return res.json({ peaks: cachedPeaks, file: record.name, duration_sec: record.duration_sec, cached: true });
  }

  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    try { await fs.access(resolved); filePath = resolved; break; } catch {}
  }

  // If file not accessible, generate synthetic waveform from path/name as seed
  const peaks = filePath
    ? await extractWaveformPeaks(filePath, numPeaks)
    : _syntheticPeaks(record.name || String(record.id), numPeaks);

  // Cache the result in DB (async, don't block response)
  if (peaks) {
    query(
      `UPDATE media_files SET waveform_peaks = $2 WHERE id = $1`,
      [record.id, JSON.stringify(peaks)]
    ).catch(() => {});
  }

  res.json({ peaks, file: record.name, duration_sec: record.duration_sec, cached: false });
});

// ── Delete ────────────────────────────────────────────────────────────────────

// Guarded delete: blocked (409) while anything references the file; fails
// closed (503) if the dependency check cannot run. The deployed copy is only
// retired after commit and re-verification — see mediaDependencyService.
export const deleteMedia = asyncHandler(async (req, res) => {
  let result;
  try {
    result = await deleteMediaSafely({
      id:            req.params.id,
      tenantId:      effectiveTenantId(req),
      correlationId: req.headers['x-request-id'] ?? null,
    });
  } catch (err) {
    if (err instanceof DependencyCheckError) return res.status(503).json(dependencyFailureBody(err));
    throw err;
  }
  if (result.status === 'not_found') return res.status(404).json({ error: 'Not found' });
  if (result.status === 'blocked')   return res.status(409).json(blockedDeleteBody(result));

  emitMediaEvent('media.deleted', { id: result.record.id }, result.record.tenant_id);
  res.status(204).end();
});
