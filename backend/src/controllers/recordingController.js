/**
 * Recording Management Controller
 *
 * Manages conference recordings — separate from the Media Library.
 * Records are auto-inserted by ESL events (start-recording → insert,
 * stop-recording → close + extract metadata). Never imported manually.
 *
 * Provides:
 *   GET  /recordings           — paginated list with filters
 *   GET  /recordings/:id       — single recording with incident detail
 *   GET  /recordings/:id/stream  — range-request audio stream
 *   GET  /recordings/:id/download — force-download
 *   GET  /recordings/:id/waveform — PCM peak data for waveform rendering
 *   PUT  /recordings/:id       — update notes / tags
 *   POST /recordings/:id/archive — mark archived
 *   DELETE /recordings/:id     — soft delete
 */

import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import { extractAudioMetadata, extractWaveformPeaks } from './mediaLibraryController.js';
import { fsPathService } from '../services/freeSwitchPathService.js';

const MIME_MAP = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.gsm': 'audio/x-gsm',
};

// ── List recordings ───────────────────────────────────────────────────────────

export const listRecordings = asyncHandler(async (req, res) => {
  const {
    search, status, conference_room, incident_uuid,
    ers_config_id, organization_id, tag,
    date_from, date_to,
  } = req.query;
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 25);
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT
       r.id, r.conference_room, r.incident_uuid, r.ers_configuration_id,
       r.recording_path, r.recording_file,
       r.file_size_bytes, r.duration_sec, r.sample_rate, r.channels, r.codec,
       r.checksum, r.status, r.started_at, r.ended_at, r.archived_at,
       r.created_by, r.notes, r.tags, r.created_at, r.updated_at,
       -- ERS incident details
       i.caller_number,   i.group_type,       i.status AS incident_status,
       i.started_at       AS incident_started, i.ended_at AS incident_ended,
       -- ERS config + org
       e.name             AS ers_name,
       e.primary_bridge_number,
       o.name             AS organization_name
     FROM conference_recordings r
     LEFT JOIN ers_incidents      i ON i.incident_uuid = r.incident_uuid
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     LEFT JOIN organizations      o ON o.id = e.organization_id
     WHERE r.deleted_at IS NULL
       AND ($1::int IS NULL OR r.tenant_id = $1)
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.conference_room ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR r.incident_uuid = $4::uuid)
       AND ($5::int  IS NULL OR r.ers_configuration_id = $5)
       AND ($6::int  IS NULL OR e.organization_id = $6)
       AND ($7::text IS NULL OR $7 = ANY(r.tags))
       AND ($8::text IS NULL OR r.notes ILIKE '%' || $8 || '%' OR r.recording_file ILIKE '%' || $8 || '%')
       AND ($9::timestamptz  IS NULL OR r.started_at >= $9)
       AND ($10::timestamptz IS NULL OR r.started_at <= $10)
     ORDER BY r.started_at DESC
     LIMIT $11 OFFSET $12`,
    [
      req.user?.tenantId        || null,
      status                    || null,
      conference_room           || null,
      incident_uuid             || null,
      ers_config_id             || null,
      organization_id           || null,
      tag                       || null,
      search                    || null,
      date_from                 || null,
      date_to                   || null,
      limit, offset,
    ]
  );

  const { rows: [{ total }] } = await query(
    `SELECT COUNT(*)::int AS total FROM conference_recordings r
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     WHERE r.deleted_at IS NULL
       AND ($1::int IS NULL OR r.tenant_id = $1)
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.conference_room ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR r.incident_uuid = $4::uuid)
       AND ($5::int  IS NULL OR r.ers_configuration_id = $5)
       AND ($6::int  IS NULL OR e.organization_id = $6)
       AND ($7::text IS NULL OR $7 = ANY(r.tags))
       AND ($8::text IS NULL OR r.notes ILIKE '%' || $8 || '%')
       AND ($9::timestamptz  IS NULL OR r.started_at >= $9)
       AND ($10::timestamptz IS NULL OR r.started_at <= $10)`,
    [
      req.user?.tenantId || null, status || null,
      conference_room || null, incident_uuid || null,
      ers_config_id || null, organization_id || null,
      tag || null, search || null,
      date_from || null, date_to || null,
    ]
  );

  res.json({ recordings: rows, total, page, limit });
});

// ── Get single with full incident context ─────────────────────────────────────

export const getRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT
       r.*,
       i.caller_number, i.group_type, i.status AS incident_status,
       i.started_at AS incident_started, i.ended_at AS incident_ended,
       i.recording_path AS incident_recording_path,
       e.name AS ers_name, e.primary_bridge_number, e.conference_profile,
       o.name AS organization_name, o.id AS organization_id
     FROM conference_recordings r
     LEFT JOIN ers_incidents      i ON i.incident_uuid = r.incident_uuid
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     LEFT JOIN organizations      o ON o.id = e.organization_id
     WHERE r.id = $1 AND r.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Recording not found' });

  // Fetch incident participants if linked
  let participants = [];
  if (rec.incident_uuid) {
    const { rows } = await query(
      `SELECT p.*, c.name AS contact_name, c.extension_number
       FROM ers_incident_participants p
       LEFT JOIN emergency_contacts c ON c.id = p.contact_id
       WHERE p.incident_id = (
         SELECT id FROM ers_incidents WHERE incident_uuid = $1 LIMIT 1
       )
       ORDER BY p.joined_at`,
      [rec.incident_uuid]
    ).catch(() => ({ rows: [] }));
    participants = rows;
  }

  res.json({ recording: rec, participants });
});

// ── Resolve file path ─────────────────────────────────────────────────────────

async function resolveFile(rec) {
  const candidates = [rec.recording_path].filter(Boolean);
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch {}
  }
  return null;
}

// ── Stream (range-request) ────────────────────────────────────────────────────

export const streamRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT * FROM conference_recordings WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const stat = await fs.stat(filePath);
  const size = stat.size;
  const mime = MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav';

  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end   = e ? parseInt(e, 10) : size - 1;
    res.status(206).set({
      'Content-Range':  `bytes ${start}-${end}/${size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mime,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.set({
      'Content-Type':   mime,
      'Content-Length': size,
      'Accept-Ranges':  'bytes',
    });
    createReadStream(filePath).pipe(res);
  }
});

// ── Download ──────────────────────────────────────────────────────────────────

export const downloadRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT * FROM conference_recordings WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const filename = rec.recording_file || path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav');
  createReadStream(filePath).pipe(res);
});

// ── Waveform peaks ────────────────────────────────────────────────────────────

export const getRecordingWaveform = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT * FROM conference_recordings WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const numPeaks = Math.min(500, Math.max(50, Number(req.query.peaks) || 200));
  const peaks    = await extractWaveformPeaks(filePath, numPeaks);
  res.json({ peaks, duration_sec: rec.duration_sec });
});

// ── Update notes / tags ───────────────────────────────────────────────────────

export const updateRecording = asyncHandler(async (req, res) => {
  const { notes, tags } = req.body;
  const { rows: [rec] } = await query(
    `UPDATE conference_recordings
     SET notes = COALESCE($2, notes),
         tags  = COALESCE($3, tags),
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, notes ?? null, tags ?? null]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json({ recording: rec });
});

// ── Archive ───────────────────────────────────────────────────────────────────

export const archiveRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `UPDATE conference_recordings
     SET status = 'ARCHIVED', archived_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'ARCHIVED' RETURNING *`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found or already archived' });
  res.json({ recording: rec });
});

// ── Delete (soft) ─────────────────────────────────────────────────────────────

export const deleteRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `UPDATE conference_recordings SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ── Internal: upsert from ESL start-recording event ──────────────────────────
//
// Called from eslService when conference::maintenance start-recording fires.
// Creates the row immediately with status='RECORDING' so the UI can show
// "recording in progress" without waiting for the conference to end.

export async function upsertRecordingStart({ confName, recPath, tenantId, createdBy = 'system' }) {
  if (!confName || !recPath) return null;

  // Look up the most recent ACTIVE incident for this room — also grab tenant_id
  // so that recordings created by ESL events (no HTTP context) are properly scoped.
  const { rows: [incident] } = await query(
    `SELECT incident_uuid, ers_configuration_id, tenant_id
     FROM ers_incidents
     WHERE conference_room = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [confName]
  ).catch(() => ({ rows: [] }));

  // Resolve tenant_id: explicit arg → from incident → fallback to first tenant
  let resolvedTenantId = tenantId ?? incident?.tenant_id ?? null;
  if (!resolvedTenantId) {
    const { rows: [firstTenant] } = await query(
      `SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    ).catch(() => ({ rows: [] }));
    resolvedTenantId = firstTenant?.id ?? null;
  }

  const filename = path.basename(recPath);

  const { rows: [record] } = await query(
    `INSERT INTO conference_recordings
       (conference_room, incident_uuid, ers_configuration_id,
        recording_path, status, started_at, created_by, tenant_id)
     VALUES ($1,$2,$3,$4,'RECORDING',now(),$5,$6)
     ON CONFLICT ON CONSTRAINT uq_conf_recordings_room_path DO NOTHING
     RETURNING *`,
    [
      confName,
      incident?.incident_uuid         ?? null,
      incident?.ers_configuration_id  ?? null,
      recPath,
      createdBy,
      resolvedTenantId,
    ]
  ).catch(err => {
    console.error('[recordings] upsertRecordingStart failed:', err.message);
    return { rows: [] };
  });

  if (record) {
    console.log(`[recordings] upsertRecordingStart: row created — room="${confName}" file="${filename}" tenant=${resolvedTenantId}`);
  }

  return record || null;
}

// ── Internal: close recording on stop-recording ESL event ────────────────────

export async function closeRecording({ confName, recPath }) {
  if (!confName || !recPath) return;

  // Extract file metadata asynchronously — don't block the ESL event loop
  const doClose = async () => {
    let meta = {};
    try {
      await new Promise(r => setTimeout(r, 1000)); // wait 1 s for FS flush
      meta = await extractAudioMetadata(recPath);
    } catch (err) {
      console.warn('[recordings] metadata extraction failed:', err.message);
    }

    await query(
      `UPDATE conference_recordings
       SET status         = 'COMPLETED',
           ended_at       = now(),
           file_size_bytes = $3,
           duration_sec   = $4,
           sample_rate    = $5,
           channels       = $6,
           codec          = $7,
           checksum       = $8,
           updated_at     = now()
       WHERE conference_room = $1
         AND recording_path  = $2
         AND status          = 'RECORDING'
         AND deleted_at IS NULL`,
      [
        confName, recPath,
        meta.size_bytes   ?? null,
        meta.duration_sec ?? null,
        meta.sample_rate  ?? null,
        meta.channels     ?? null,
        meta.codec        ?? null,
        meta.checksum     ?? null,
      ]
    ).catch(err => console.error('[recordings] closeRecording update failed:', err.message));
  };

  doClose();  // fire-and-forget
}

// ── Startup: scan recording directory → sync files not yet in DB ─────────────
//
// Called once at boot (after ESL connects) to catch recordings that were
// created before this backend instance started — e.g. after a crash, a restart,
// or a manual `freeswitch_cli conference X record /path/file.wav`.
//
// Inserts each discovered file as status='COMPLETED' with full metadata.
// Existing rows (matched by recording_path) are not touched — never overwrites
// manually edited notes or tags.
//
// Returns { found, inserted, skipped } counts for the boot log.
export async function scanRecordingDirectory() {
  const confDir = fsPathService.getConfRecordingDir();
  const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.gsm']);

  // Resolve tenant fallback once for all inserts
  const { rows: [firstTenant] } = await query(
    `SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
  ).catch(() => ({ rows: [] }));
  const fallbackTenantId = firstTenant?.id ?? null;

  let files;
  try {
    files = await fs.readdir(confDir);
  } catch {
    console.log(`[recordings] scanRecordingDirectory: directory not accessible — "${confDir}" (will be created when first recording starts)`);
    return { found: 0, inserted: 0, skipped: 0 };
  }

  const audioFiles = files.filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  console.log(`[recordings] scanRecordingDirectory: found ${audioFiles.length} audio file(s) in "${confDir}"`);

  let inserted = 0;
  let skipped  = 0;

  for (const file of audioFiles) {
    const fullPath = path.posix.join(confDir, file);

    // Skip if already tracked
    const { rows: [existing] } = await query(
      `SELECT id FROM conference_recordings WHERE recording_path = $1 AND deleted_at IS NULL`,
      [fullPath]
    ).catch(() => ({ rows: [{}] })); // on error, skip to be safe
    if (existing) { skipped++; continue; }

    // Extract metadata
    let meta = {};
    try {
      const stat = await fs.stat(fullPath);
      meta = await extractAudioMetadata(fullPath);
      meta.size_bytes = meta.size_bytes ?? stat.size;
    } catch (err) {
      console.warn(`[recordings] scanRecordingDirectory: metadata failed for "${file}" — ${err.message}`);
    }

    // Infer conference room from filename pattern: conf_<room>_<ts>.wav
    const match = /^conf_(.+?)_\d+\.\w+$/.exec(file);
    const room  = match ? match[1] : 'unknown';

    // Try to link to a recent incident for this room
    const { rows: [incident] } = await query(
      `SELECT incident_uuid, ers_configuration_id, tenant_id
       FROM ers_incidents
       WHERE conference_room = $1 AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [room]
    ).catch(() => ({ rows: [] }));

    const tenantId = incident?.tenant_id ?? fallbackTenantId;

    await query(
      `INSERT INTO conference_recordings
         (conference_room, incident_uuid, ers_configuration_id,
          recording_path, status,
          file_size_bytes, duration_sec, sample_rate, channels, codec, checksum,
          started_at, ended_at, created_by, tenant_id)
       VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6,$7,$8,$9,$10,
               now() - interval '1 second', now(), 'scan', $11)
       ON CONFLICT ON CONSTRAINT uq_conf_recordings_room_path DO NOTHING`,
      [
        room,
        incident?.incident_uuid        ?? null,
        incident?.ers_configuration_id ?? null,
        fullPath,
        meta.size_bytes   ?? null,
        meta.duration_sec ?? null,
        meta.sample_rate  ?? null,
        meta.channels     ?? null,
        meta.codec        ?? null,
        meta.checksum     ?? null,
        tenantId,
      ]
    ).catch(err => console.warn(`[recordings] scanRecordingDirectory: insert failed for "${file}" — ${err.message}`));

    inserted++;
    console.log(`[recordings] scanRecordingDirectory: imported "${file}" (room="${room}" tenant=${tenantId})`);
  }

  console.log(`[recordings] scanRecordingDirectory: done — found=${audioFiles.length} inserted=${inserted} skipped=${skipped}`);
  return { found: audioFiles.length, inserted, skipped };
}
