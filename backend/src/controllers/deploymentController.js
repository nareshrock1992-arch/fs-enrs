/**
 * Deployment Controller
 *
 * Handles all IVR deployment, diagnostics, and audio-library
 * endpoints exposed to the frontend.
 */

import { promises as fs } from 'fs';
import path from 'path';
import multer from 'multer';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query }        from '../db/pool.js';
import { config }       from '../config/index.js';
import { fsPathService }         from '../services/freeSwitchPathService.js';
import { deployFlow, redeployAll, getDeploymentHistory, previewDeployment }
                                 from '../services/deploymentEngine.js';
import { runDiagnostics, pingEsl, reloadXml, disableLegacyExtension }
                                 from '../services/diagnosticsService.js';

// ── Audio upload config ───────────────────────────────────────────────────────

const AUDIO_EXTS = ['.wav', '.mp3', '.ogg', '.gsm', '.ul'];

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdir(config.uploads.dir, { recursive: true })
        .then(() => cb(null, config.uploads.dir))
        .catch(cb);
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-.]/g, '_');
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits:     { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_EXTS.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error(`Only audio files allowed: ${AUDIO_EXTS.join(', ')}`));
    }
  },
}).single('file');

export const audioUploadMiddleware = (req, res, next) => {
  audioUpload(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
};

// ── Audio Library ─────────────────────────────────────────────────────────────

/** GET /deployment/audio */
export const listAudio = asyncHandler(async (req, res) => {
  const { search, category, organization_id, deployed } = req.query;
  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT m.*, o.name AS organization_name, u.email AS uploaded_by_email
     FROM media_files m
     LEFT JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     WHERE m.deleted_at IS NULL
       AND ($1::int IS NULL OR m.organization_id = $1)
       AND ($2::text IS NULL OR m.category = $2)
       AND ($3::text IS NULL OR m.name ILIKE '%' || $3 || '%')
       AND ($4::boolean IS NULL OR m.is_deployed = $4)
     ORDER BY m.created_at DESC
     LIMIT $5 OFFSET $6`,
    [
      organization_id || null,
      category || null,
      search    || null,
      deployed != null ? (deployed === 'true') : null,
      limit, offset,
    ]
  );

  const { rows: [{ total }] } = await query(
    `SELECT COUNT(*)::int AS total FROM media_files
     WHERE deleted_at IS NULL
       AND ($1::int IS NULL OR organization_id = $1)
       AND ($2::text IS NULL OR category = $2)
       AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
       AND ($4::boolean IS NULL OR is_deployed = $4)`,
    [organization_id || null, category || null, search || null,
     deployed != null ? (deployed === 'true') : null]
  );

  res.json({ files: rows, total, page, limit });
});

/** POST /deployment/audio/scan
 *  Scans $FS_SOUND_DIR/enrs/ for audio files not yet in the database and
 *  imports them. Safe to call repeatedly — already-known files are skipped.
 *  Returns { imported, skipped, errors } counts + the newly-imported records.
 */
export const scanAudio = asyncHandler(async (req, res) => {
  const soundDir = fsPathService.getEnrsSoundDir();

  // Ensure the directory exists before scanning
  let dirEntries;
  try {
    dirEntries = await fs.readdir(soundDir, { withFileTypes: true });
  } catch {
    return res.json({
      imported:  0,
      skipped:   0,
      errors:    0,
      files:     [],
      sound_dir: soundDir,
      message:   `Sound directory not found: ${soundDir}`,
    });
  }

  const audioFiles = dirEntries.filter(
    e => e.isFile() && AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())
  );

  // Load existing fs_path records to avoid duplicate imports
  const { rows: existing } = await query(
    `SELECT fs_path, name FROM media_files WHERE deleted_at IS NULL AND fs_path IS NOT NULL`
  );
  const knownPaths = new Set(existing.map(r => r.fs_path));
  const knownNames = new Set(existing.map(r => r.name));

  const imported = [];
  let skipped = 0;
  let errors  = 0;

  for (const entry of audioFiles) {
    const filePath = path.join(soundDir, entry.name);
    const baseName = entry.name;

    // Skip if already tracked by path or name
    if (knownPaths.has(filePath) || knownNames.has(baseName)) {
      skipped++;
      continue;
    }

    try {
      const stat = await fs.stat(filePath);
      const meta = await parseWavMetadata(filePath);

      const { rows: [record] } = await query(
        `INSERT INTO media_files
           (type, name, path_or_uri, fs_path, size_bytes, category,
            description, is_deployed, deployed_at, duration_sec, tenant_id)
         VALUES ('PROMPT', $1, $2, $2, $3, 'general',
                 'Auto-imported from FreeSWITCH sound directory',
                 true, now(), $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          baseName,
          filePath,
          stat.size,
          meta.duration_sec,
          req.user?.tenantId || null,
        ]
      );

      if (record) {
        imported.push(record);
        knownPaths.add(filePath);
        knownNames.add(baseName);
      } else {
        skipped++; // ON CONFLICT DO NOTHING fired — race with another request
      }
    } catch (err) {
      console.error('[audio-scan] Failed to import', filePath, err.message);
      errors++;
    }
  }

  res.json({
    imported:  imported.length,
    skipped,
    errors,
    files:     imported,
    sound_dir: soundDir,
    message:   `Scan complete — ${imported.length} imported, ${skipped} already known, ${errors} errors`,
  });
});

/** GET /deployment/audio/categories */
export const listCategories = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT category FROM media_files
     WHERE deleted_at IS NULL AND category IS NOT NULL
     ORDER BY category`
  );
  res.json({ categories: rows.map(r => r.category) });
});

/** POST /deployment/audio/upload */
export const uploadAudio = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file required (field: file)' });

  const {
    organization_id,
    category    = 'general',
    description = '',
    name,
  } = req.body;

  const displayName = name || req.file.originalname;

  // Insert to DB first so the record exists even if FS copy fails
  const { rows: [record] } = await query(
    `INSERT INTO media_files
       (organization_id, uploaded_by_user_id, type, name, path_or_uri,
        size_bytes, category, description, tenant_id)
     VALUES ($1,$2,'PROMPT',$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      organization_id || null,
      req.user.id,
      displayName,
      req.file.path,
      req.file.size,
      category,
      description,
      req.user.tenantId || null,
    ]
  );

  // Copy to FreeSWITCH sound dir — awaited so the response reflects real outcome.
  // Failure is non-fatal to the DB record; the user can re-deploy via the Deploy button.
  let deployResult = null;
  let deployError  = null;
  try {
    deployResult = await copyToFreeSwitch(record.id, req.file.path, req.file.filename);
  } catch (err) {
    deployError = err.message;
    console.error(`[audio-upload] FS copy failed for media_file ${record.id}: ${err.message}`);
    // Persist error so the UI can surface it without requiring a re-upload
    await query(
      `UPDATE media_files SET description = CASE WHEN description = '' OR description IS NULL
         THEN $2 ELSE description || ' | Deploy error: ' || $2 END WHERE id = $1`,
      [record.id, `Deploy error: ${err.message}`]
    ).catch(() => {});
  }

  // Reload the record to reflect is_deployed / fs_path after copy attempt
  const { rows: [fresh] } = await query(
    `SELECT * FROM media_files WHERE id = $1`, [record.id]
  );

  const status  = deployError ? 207 : 201; // 207 = partial success
  const message = deployError
    ? `File saved to database but FreeSWITCH copy failed: ${deployError}. Use "Deploy" button to retry.`
    : 'Upload and deploy successful';

  res.status(status).json({ file: fresh || record, deploy: deployResult, deployError, message });
});

/** POST /deployment/audio/:id/deploy  — manually deploy/re-deploy a file */
export const deployAudio = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Audio file not found' });
  if (!record.path_or_uri) return res.status(400).json({ error: 'No source file path on record' });

  const result = await copyToFreeSwitch(record.id, record.path_or_uri, path.basename(record.path_or_uri));
  res.json(result);
});

/** GET /deployment/audio/:id/stream  — authenticated audio preview */
export const streamAudio = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  // Try FS path first, fall back to local uploads
  const filePath = record.fs_path || record.path_or_uri;
  if (!filePath) return res.status(404).json({ error: 'File path not set' });

  try {
    await fs.access(filePath);
    res.setHeader('Content-Type', mimeForExt(path.extname(filePath)));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    const stream = (await import('fs')).createReadStream(filePath);
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: 'File not found on disk' });
  }
});

/** DELETE /deployment/audio/:id */
export const deleteAudio = asyncHandler(async (req, res) => {
  const { rows: [record] } = await query(
    `UPDATE media_files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Not found' });

  // Clean up FS copy (best-effort, don't fail the response)
  if (record.fs_path) {
    fs.unlink(record.fs_path).catch(() => {});
  }

  res.status(204).end();
});

// ── IVR Flow Deployment ───────────────────────────────────────────────────────

/** GET /deployment/flows */
export const listFlowStatus = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT f.flow_uuid, f.name, f.last_deployed_at,
            f.last_deployment_status, f.last_deployed_version,
            v.version_number AS latest_version,
            COUNT(en.id)::int AS bound_number_count,
            ARRAY_AGG(en.number) FILTER (WHERE en.id IS NOT NULL) AS bound_numbers
     FROM ivr_flows f
     LEFT JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
       AND v.version_number = (
         SELECT MAX(v2.version_number) FROM ivr_flow_versions v2
         WHERE v2.ivr_flow_id = f.id
       )
     LEFT JOIN emergency_numbers en ON en.ivr_flow_id = f.id
       AND en.deleted_at IS NULL AND en.is_active = true
     WHERE f.deleted_at IS NULL
       AND ($1::int IS NULL OR f.tenant_id = $1)
     GROUP BY f.flow_uuid, f.name, f.last_deployed_at,
              f.last_deployment_status, f.last_deployed_version, v.version_number
     ORDER BY f.name`,
    [req.user.tenantId || null]
  );
  res.json({ flows: rows });
});

/** GET /deployment/flows/:uuid/preview */
export const previewDeploy = asyncHandler(async (req, res) => {
  const preview = await previewDeployment(req.params.uuid, req.user.tenantId);
  if (!preview) return res.status(404).json({ error: 'Flow not found or not published' });
  res.json(preview);
});

/** POST /deployment/flows/:uuid/deploy */
export const triggerDeploy = asyncHandler(async (req, res) => {
  const report = await deployFlow(req.params.uuid, {
    deployedBy: req.user.id,
    tenantId:   req.user.tenantId,
  });
  const status = report.status === 'success' ? 200 : 422;
  res.status(status).json(report);
});

/** GET /deployment/flows/:uuid/history */
export const deployHistory = asyncHandler(async (req, res) => {
  const history = await getDeploymentHistory(req.params.uuid, Number(req.query.limit) || 10);
  res.json({ history });
});

/** POST /deployment/redeploy-all */
export const triggerRedeployAll = asyncHandler(async (req, res) => {
  const result = await redeployAll();
  res.json(result);
});

// ── Diagnostics ───────────────────────────────────────────────────────────────

/** GET /deployment/diagnostics */
export const getDiagnostics = asyncHandler(async (req, res) => {
  const result = await runDiagnostics();
  res.json(result);
});

/** POST /deployment/diagnostics/reloadxml */
export const triggerReloadXml = asyncHandler(async (req, res) => {
  const result = await reloadXml();
  res.json({ ok: true, result });
});

/** GET /deployment/diagnostics/paths */
export const getPaths = asyncHandler(async (req, res) => {
  res.json(fsPathService.getSummary());
});

/** GET /deployment/diagnostics/esl */
export const getEslStatus = asyncHandler(async (req, res) => {
  const result = await pingEsl();
  res.json(result);
});

/**
 * POST /deployment/diagnostics/disable-legacy-extension
 * body: { file, extension_name }
 *
 * Safely comments out (never deletes) a conflicting legacy <extension>
 * block flagged by the Dialplan Conflict Scan, in the currently-detected
 * dialplan target directory. Reversible — the block stays in the file,
 * just wrapped in an XML comment.
 */
export const disableLegacyExtensionRoute = asyncHandler(async (req, res) => {
  const { file, extension_name } = req.body;
  if (!file || !extension_name) {
    return res.status(400).json({ error: 'file and extension_name are required' });
  }
  const { dir } = await fsPathService.detectDialplanTargetDir();
  const result = await disableLegacyExtension(dir, file, extension_name);
  res.json(result);
});

// ── Internal helpers ──────────────────────────────────────────────────────────

async function copyToFreeSwitch(mediaId, srcPath, filename) {
  const destDir  = fsPathService.getEnrsSoundDir();
  const destPath = path.join(destDir, path.basename(filename));

  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(srcPath, destPath);
  await fs.chmod(destPath, 0o644).catch(() => {});

  // Update DB
  await query(
    `UPDATE media_files
     SET fs_path = $2, is_deployed = true, deployed_at = now()
     WHERE id = $1`,
    [mediaId, destPath]
  );

  return {
    ok:       true,
    dest:     destPath,
    media_uri: '/media/' + path.basename(filename),
  };
}

/** Parse WAV header for duration. Falls back gracefully for non-WAV files. */
async function parseWavMetadata(filePath) {
  try {
    const fd = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(44);
    await fd.read(buf, 0, 44, 0);
    await fd.close();

    if (buf.toString('ascii', 0, 4) !== 'RIFF') return { duration_sec: null };
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return { duration_sec: null };

    const sampleRate   = buf.readUInt32LE(24);
    const byteRate     = buf.readUInt32LE(28);
    const dataSize     = buf.readUInt32LE(40);

    if (!byteRate || byteRate === 0) return { duration_sec: null };
    const duration_sec = Math.round((dataSize / byteRate) * 10) / 10;
    return { duration_sec, sample_rate: sampleRate };
  } catch {
    return { duration_sec: null };
  }
}

function mimeForExt(ext) {
  const map = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.gsm': 'audio/x-gsm',
    '.ul':  'audio/basic',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}
