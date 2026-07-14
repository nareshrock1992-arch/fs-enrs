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
import { config } from '../config/index.js';
import { fsPathService } from '../services/freeSwitchPathService.js';

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

// ── Waveform peak extraction (WAV PCM only) ───────────────────────────────────
//
// Returns an array of { peak } objects (0-1 normalized) for waveform rendering.
// N = number of visual "bars" in the waveform (default 200).

export async function extractWaveformPeaks(filePath, numPeaks = 200) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.wav') return null;

    const fd  = await fs.open(filePath, 'r');
    const hdr = Buffer.alloc(44);
    await fd.read(hdr, 0, 44, 0);

    if (hdr.toString('ascii', 0, 4) !== 'RIFF' || hdr.toString('ascii', 8, 12) !== 'WAVE') {
      await fd.close();
      return null;
    }

    const bitsPerSample = hdr.readUInt16LE(34);
    const numChannels   = hdr.readUInt16LE(22);
    const dataSize      = hdr.readUInt32LE(40);
    const bytesPerSamp  = (bitsPerSample / 8) * numChannels;
    const totalSamples  = Math.floor(dataSize / bytesPerSamp);
    const samplesPerPeak = Math.max(1, Math.floor(totalSamples / numPeaks));

    const chunkBytes = Math.min(samplesPerPeak * bytesPerSamp * numPeaks, dataSize);
    const buf = Buffer.alloc(chunkBytes);
    await fd.read(buf, 0, chunkBytes, 44);
    await fd.close();

    const peaks = [];
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
    return null;
  }
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

function emitMediaEvent(event, data) {
  if (_io) _io.emit(event, data);
}

// ── List ──────────────────────────────────────────────────────────────────────

export const listMedia = asyncHandler(async (req, res) => {
  const { search, category, deployed, tenant_id } = req.query;
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const sort   = ['name','category','created_at','size_bytes','duration_sec'].includes(req.query.sort)
    ? req.query.sort : 'created_at';
  const dir    = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const { rows } = await query(
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
     WHERE m.deleted_at IS NULL
       AND ($1::int  IS NULL OR m.tenant_id       = $1)
       AND ($2::text IS NULL OR m.category         = $2)
       AND ($3::text IS NULL OR (
              m.name ILIKE '%' || $3 || '%'
           OR m.description ILIKE '%' || $3 || '%'
           OR $3 = ANY(m.tags)
         ))
       AND ($4::boolean IS NULL OR m.is_deployed   = $4)
     ORDER BY m.${sort} ${dir} NULLS LAST
     LIMIT $5 OFFSET $6`,
    [
      req.user?.tenantId || null,
      category || null,
      search   || null,
      deployed != null ? deployed === 'true' : null,
      limit, offset,
    ]
  );

  const { rows: [{ total }] } = await query(
    `SELECT COUNT(*)::int AS total FROM media_files
     WHERE deleted_at IS NULL
       AND ($1::int  IS NULL OR tenant_id = $1)
       AND ($2::text IS NULL OR category  = $2)
       AND ($3::text IS NULL OR (name ILIKE '%' || $3 || '%' OR description ILIKE '%' || $3 || '%' OR $3 = ANY(tags)))
       AND ($4::boolean IS NULL OR is_deployed = $4)`,
    [req.user?.tenantId || null, category || null, search || null,
     deployed != null ? deployed === 'true' : null]
  );

  res.json({ files: rows, total, page, limit });
});

// ── Categories ────────────────────────────────────────────────────────────────

export const listCategories = asyncHandler(async (_req, res) => {
  res.json({ categories: MEDIA_CATEGORIES });
});

// ── Upload ────────────────────────────────────────────────────────────────────

export const uploadMedia = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file required (field: file)' });

  const { category = 'general', description = '', name: customName } = req.body;
  const displayName = customName?.trim() || req.file.originalname;
  const srcPath     = req.file.path;

  // Step 1 — extract metadata before any DB work
  const meta = await extractAudioMetadata(srcPath);

  // Step 2 — check for duplicate by checksum
  if (meta.checksum) {
    const { rows: [dup] } = await query(
      `SELECT id, name FROM media_files WHERE checksum = $1 AND deleted_at IS NULL LIMIT 1`,
      [meta.checksum]
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
      req.user.tenantId || null,
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
    deployedPath = await deployToFs(srcPath, req.file.filename);
    await query(
      `UPDATE media_files SET fs_path=$2, is_deployed=true, deployed_at=now() WHERE id=$1`,
      [record.id, deployedPath]
    );
    record.fs_path    = deployedPath;
    record.is_deployed = true;
  } catch (err) {
    deployError = err.message;
    console.error(`[media-library] FS copy failed for id=${record.id}: ${err.message}`);
    // Leave is_deployed=false — the user sees "Pending FS deployment" in the UI
    // and can redeploy via the Deploy button once the volume issue is resolved.
  }

  // Step 5 — reload fresh record
  const { rows: [fresh] } = await query(
    `SELECT m.*, u.email AS uploaded_by_email FROM media_files m
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     WHERE m.id = $1`,
    [record.id]
  );

  // Step 6 — WebSocket push so all open Media Library tabs update instantly
  emitMediaEvent('media.uploaded', { file: fresh });

  const httpStatus = deployError ? 207 : 201;
  res.status(httpStatus).json({
    file: fresh,
    deployError,
    message: deployError
      ? `Uploaded (id=${record.id}) but FreeSWITCH copy failed: ${deployError}. File is streamable from uploads/. Use Deploy to retry.`
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
    const filePath = path.posix.join(soundDir, entry.name);
    if (knownPaths.has(filePath) || knownNames.has(entry.name)) { skipped++; continue; }

    try {
      const meta = await extractAudioMetadata(filePath);
      if (meta.checksum && knownChecksums.has(meta.checksum)) { skipped++; continue; }

      const { rows: [record] } = await query(
        `INSERT INTO media_files
           (type, name, path_or_uri, fs_path, size_bytes, category,
            description, is_deployed, deployed_at,
            duration_sec, sample_rate, channels, codec, bitrate_kbps, checksum,
            tenant_id)
         VALUES ('PROMPT',$1,$2,$2,$3,'general',
                 'Auto-imported from FreeSWITCH sound directory',
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
      );
      if (record) {
        imported.push(record);
        knownPaths.add(filePath);
        knownNames.add(entry.name);
        if (meta.checksum) knownChecksums.add(meta.checksum);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[media-scan] ${filePath}:`, err.message);
      errors++;
    }
  }

  if (imported.length > 0) {
    emitMediaEvent('media.scanned', { imported: imported.length, files: imported });
  }

  res.json({
    imported: imported.length, skipped, errors,
    files: imported, sound_dir: soundDir,
    message: `Scan complete — ${imported.length} imported, ${skipped} already known, ${errors} errors`,
  });
});

// ── Get single ────────────────────────────────────────────────────────────────

export const getMedia = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT m.*, u.email AS uploaded_by_email, o.name AS organization_name
     FROM media_files m
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     LEFT JOIN organizations o ON o.id = m.organization_id
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json({ file: record });
});

// ── Update metadata ───────────────────────────────────────────────────────────

export const updateMedia = asyncHandler(async (req, res) => {
  const { name, category, description, notes, tags } = req.body;
  const { rows: [record] } = await query(
    `UPDATE media_files SET
       name        = COALESCE($2, name),
       category    = COALESCE($3, category),
       description = COALESCE($4, description),
       notes       = COALESCE($5, notes),
       tags        = COALESCE($6, tags),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [req.params.id, name || null, category || null,
     description ?? null, notes ?? null, tags ?? null]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });
  emitMediaEvent('media.updated', { file: record });
  res.json({ file: record });
});

// ── Deploy / re-deploy to FreeSWITCH ─────────────────────────────────────────

export const deployMedia = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const srcPath = record.fs_path || record.path_or_uri;
  if (!srcPath) return res.status(400).json({ error: 'No source file on record' });

  try {
    const destPath = await deployToFs(srcPath, path.basename(srcPath));
    await query(
      `UPDATE media_files SET fs_path=$2, is_deployed=true, deployed_at=now() WHERE id=$1`,
      [record.id, destPath]
    );
    emitMediaEvent('media.deployed', { id: record.id, fs_path: destPath });
    res.json({ ok: true, fs_path: destPath });
  } catch (err) {
    res.status(502).json({ error: `Deploy failed: ${err.message}` });
  }
});

// ── Stream (authenticated preview) ───────────────────────────────────────────

export const streamMedia = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  // Prefer deployed FS path; fall back to local uploads path (always streamable)
  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    try { await fs.access(p); filePath = p; break; } catch {}
  }
  if (!filePath) return res.status(404).json({ error: 'File not found on disk' });

  const stat = await fs.stat(filePath);
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const size = stat.size;

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : size - 1;
    const chunk = end - start + 1;
    res.status(206).set({
      'Content-Range':  `bytes ${start}-${end}/${size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   mime,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.set({
      'Content-Type':        mime,
      'Content-Length':      size,
      'Accept-Ranges':       'bytes',
      'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
    });
    createReadStream(filePath).pipe(res);
  }
});

// ── Download ──────────────────────────────────────────────────────────────────

export const downloadMedia = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    try { await fs.access(p); filePath = p; break; } catch {}
  }
  if (!filePath) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Disposition', `attachment; filename="${record.name}"`);
  res.setHeader('Content-Type', MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  createReadStream(filePath).pipe(res);
});

// ── Waveform peaks ────────────────────────────────────────────────────────────

export const getWaveform = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  const candidates = [record.fs_path, record.path_or_uri].filter(Boolean);
  let filePath = null;
  for (const p of candidates) {
    try { await fs.access(p); filePath = p; break; } catch {}
  }
  if (!filePath) return res.status(404).json({ error: 'File not found on disk' });

  const numPeaks = Math.min(500, Math.max(50, Number(req.query.peaks) || 200));
  const peaks    = await extractWaveformPeaks(filePath, numPeaks);
  res.json({ peaks, file: record.name, duration_sec: record.duration_sec });
});

// ── Delete ────────────────────────────────────────────────────────────────────

export const deleteMedia = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `UPDATE media_files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  // Remove from FS (best-effort — don't fail if already gone)
  if (record.fs_path) fs.unlink(record.fs_path).catch(() => {});

  emitMediaEvent('media.deleted', { id: record.id });
  res.status(204).end();
});
