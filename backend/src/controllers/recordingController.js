/**
 * Recording Management Controller
 *
 * Enterprise recording subsystem — business modules own their recordings.
 * ERS recordings belong to ERS incidents, ENS recordings to campaigns,
 * IVR recordings to IVR sessions, MANUAL to operator-initiated captures.
 *
 * Records auto-inserted by ESL events (start-recording → insert,
 * stop-recording → close + extract metadata). Lua recordings registered
 * on incident/campaign completion. Boot-time scan picks up any orphans.
 *
 * Provides:
 *   GET  /recordings              — paginated list with module type filter
 *   GET  /recordings/:id          — single recording with module context
 *   GET  /recordings/:id/stream   — range-request audio stream
 *   GET  /recordings/:id/download — force-download
 *   GET  /recordings/:id/waveform — PCM peak data for waveform rendering
 *   PUT  /recordings/:id          — update notes / tags
 *   POST /recordings/:id/archive  — mark archived
 *   DELETE /recordings/:id        — soft delete
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
    date_from, date_to, recording_type,
  } = req.query;
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 25);
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT
       r.id, r.recording_type, r.conference_room, r.conference_name,
       r.incident_uuid, r.campaign_id, r.ers_configuration_id,
       r.recording_path, r.recording_file, r.relative_path,
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
     FROM recordings r
     LEFT JOIN ers_incidents      i ON i.incident_uuid = r.incident_uuid
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     LEFT JOIN organizations      o ON o.id = e.organization_id
     WHERE r.deleted_at IS NULL
       AND ($1::int  IS NULL OR r.tenant_id = $1)
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.conference_room ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR r.incident_uuid = $4::uuid)
       AND ($5::int  IS NULL OR r.ers_configuration_id = $5)
       AND ($6::int  IS NULL OR e.organization_id = $6)
       AND ($7::text IS NULL OR $7 = ANY(r.tags))
       AND ($8::text IS NULL OR r.notes ILIKE '%' || $8 || '%' OR r.recording_file ILIKE '%' || $8 || '%')
       AND ($9::timestamptz  IS NULL OR r.started_at >= $9)
       AND ($10::timestamptz IS NULL OR r.started_at <= $10)
       AND ($11::text IS NULL OR r.recording_type = $11)
     ORDER BY r.started_at DESC
     LIMIT $12 OFFSET $13`,
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
      recording_type            || null,
      limit, offset,
    ]
  );

  const { rows: [{ total }] } = await query(
    `SELECT COUNT(*)::int AS total FROM recordings r
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     WHERE r.deleted_at IS NULL
       AND ($1::int  IS NULL OR r.tenant_id = $1)
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.conference_room ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR r.incident_uuid = $4::uuid)
       AND ($5::int  IS NULL OR r.ers_configuration_id = $5)
       AND ($6::int  IS NULL OR e.organization_id = $6)
       AND ($7::text IS NULL OR $7 = ANY(r.tags))
       AND ($8::text IS NULL OR r.notes ILIKE '%' || $8 || '%')
       AND ($9::timestamptz  IS NULL OR r.started_at >= $9)
       AND ($10::timestamptz IS NULL OR r.started_at <= $10)
       AND ($11::text IS NULL OR r.recording_type = $11)`,
    [
      req.user?.tenantId || null, status || null,
      conference_room || null, incident_uuid || null,
      ers_config_id || null, organization_id || null,
      tag || null, search || null,
      date_from || null, date_to || null,
      recording_type || null,
    ]
  );

  res.json({ recordings: rows, total, page, limit });
});

// ── Get single with full module context ───────────────────────────────────────

export const getRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT
       r.*,
       i.caller_number, i.group_type, i.status AS incident_status,
       i.started_at AS incident_started, i.ended_at AS incident_ended,
       i.recording_path AS incident_recording_path,
       e.name AS ers_name, e.primary_bridge_number, e.conference_profile,
       o.name AS organization_name, o.id AS organization_id
     FROM recordings r
     LEFT JOIN ers_incidents      i ON i.incident_uuid = r.incident_uuid
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id
     LEFT JOIN organizations      o ON o.id = e.organization_id
     WHERE r.id = $1 AND r.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Recording not found' });

  // Return waveform peaks inline if already cached
  if (rec.waveform_peaks) {
    rec._waveform_cached = true;
  }

  // Fetch incident participants if linked
  let participants = rec.participants || [];
  if (!participants.length && rec.incident_uuid) {
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
  const candidates = [rec.recording_path, rec.original_path].filter(Boolean);
  for (const p of candidates) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    try { await fs.access(resolved); return resolved; } catch {}
  }
  console.warn(`[recording-stream] id=${rec.id} — file not found. recording_path=${rec.recording_path || '(null)'} CWD=${process.cwd()}`);
  return null;
}

// ── Stream (range-request) ────────────────────────────────────────────────────

export const streamRecording = asyncHandler(async (req, res) => {
  const { rows: [rec] } = await query(
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk', recording_path: rec.recording_path });

  const stat = await fs.stat(filePath);
  const size = stat.size;
  const mime = MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav';

  console.log(`[recording-stream] id=${rec.id} type=${rec.recording_type} room=${rec.conference_room} path="${filePath}" mime=${mime} bytes=${size}`);

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
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL`,
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
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  // Return cached peaks if available (written during closeRecording)
  if (rec.waveform_peaks) {
    return res.json({ peaks: rec.waveform_peaks, duration_sec: rec.duration_sec, cached: true });
  }

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const numPeaks = Math.min(500, Math.max(50, Number(req.query.peaks) || 200));
  const peaks    = await extractWaveformPeaks(filePath, numPeaks);

  // Cache for next request
  query(
    `UPDATE recordings SET waveform_peaks = $2, updated_at = now() WHERE id = $1`,
    [rec.id, JSON.stringify(peaks)]
  ).catch(() => {});

  res.json({ peaks, duration_sec: rec.duration_sec, cached: false });
});

// ── Update notes / tags ───────────────────────────────────────────────────────

export const updateRecording = asyncHandler(async (req, res) => {
  const { notes, tags } = req.body;
  const { rows: [rec] } = await query(
    `UPDATE recordings
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
    `UPDATE recordings
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
    `UPDATE recordings SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ── Internal: upsert from ESL start-recording event OR module registration ────
//
// Called from:
//   • eslService when conference::maintenance start-recording fires
//     (monitoring UI recordings — `conference record` ESL command)
//   • ersController when Lua posts /ers/incidents/{uuid}/complete
//     (ERS Lua record_session recordings — already written to recordings/ers/)
//   • ensInternalController when Lua posts /ens/campaign/start
//     (ENS blast recordings — already written to recordings/ens/)
//
// type: 'ERS' | 'ENS' | 'IVR' | 'MANUAL'

export async function upsertRecordingStart({
  type = 'ERS',
  confName,
  recPath,
  incidentUuid,
  campaignId,
  tenantId,
  createdBy = 'system',
}) {
  if (!recPath) return null;

  // Look up active incident for this room if not provided
  let resolvedIncidentUuid = incidentUuid ?? null;
  let resolvedConfigId     = null;
  let resolvedTenantId     = tenantId ?? null;

  if (confName && !resolvedIncidentUuid && type === 'ERS') {
    const { rows: [incident] } = await query(
      `SELECT incident_uuid, ers_configuration_id, tenant_id
       FROM ers_incidents
       WHERE conference_room = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [confName]
    ).catch(() => ({ rows: [] }));
    if (incident) {
      resolvedIncidentUuid = incident.incident_uuid;
      resolvedConfigId     = incident.ers_configuration_id;
      resolvedTenantId   ??= incident.tenant_id;
    }
  }

  if (!resolvedTenantId) {
    const { rows: [firstTenant] } = await query(
      `SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    ).catch(() => ({ rows: [] }));
    resolvedTenantId = firstTenant?.id ?? null;
  }

  const base         = fsPathService.getRecordingDir();
  const relativePath = recPath.startsWith(base)
    ? recPath.slice(base.length).replace(/^\//, '')
    : null;

  const { rows: [record] } = await query(
    `INSERT INTO recordings
       (recording_type, conference_room, incident_uuid, ers_configuration_id,
        campaign_id, recording_path, relative_path, original_path,
        status, started_at, created_by, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'RECORDING',now(),$8,$9)
     ON CONFLICT ON CONSTRAINT uq_recordings_storage_path DO NOTHING
     RETURNING *`,
    [
      type,
      confName                  ?? null,
      resolvedIncidentUuid      ?? null,
      resolvedConfigId          ?? null,
      campaignId                ?? null,
      recPath,
      relativePath,
      createdBy,
      resolvedTenantId,
    ]
  ).catch(err => {
    console.error('[recordings] upsertRecordingStart failed:', err.message);
    return { rows: [] };
  });

  if (record) {
    console.log(`[recordings] upsertRecordingStart: row created — type=${type} room="${confName}" file="${path.basename(recPath)}" tenant=${resolvedTenantId}`);
  }

  return record || null;
}

// ── Internal: close recording on stop-recording ESL event ────────────────────

export async function closeRecording({ confName, recPath }) {
  if (!recPath) return;

  const doClose = async () => {
    let meta = {};
    let waveformPeaks = null;
    try {
      await new Promise(r => setTimeout(r, 1000)); // wait 1 s for FS flush
      meta = await extractAudioMetadata(recPath);
      try {
        waveformPeaks = await extractWaveformPeaks(recPath, 200);
      } catch {
        // waveform is optional — don't block the close
      }
    } catch (err) {
      console.warn('[recordings] metadata extraction failed:', err.message);
    }

    await query(
      `UPDATE recordings
       SET status          = 'COMPLETED',
           ended_at        = now(),
           file_size_bytes = $3,
           duration_sec    = $4,
           sample_rate     = $5,
           channels        = $6,
           codec           = $7,
           checksum        = $8,
           waveform_peaks  = $9,
           updated_at      = now()
       WHERE recording_path = $1
         AND (conference_room = $2 OR $2 IS NULL)
         AND status          = 'RECORDING'
         AND deleted_at IS NULL`,
      [
        recPath, confName ?? null,
        meta.size_bytes   ?? null,
        meta.duration_sec ?? null,
        meta.sample_rate  ?? null,
        meta.channels     ?? null,
        meta.codec        ?? null,
        meta.checksum     ?? null,
        waveformPeaks ? JSON.stringify(waveformPeaks) : null,
      ]
    ).catch(err => console.error('[recordings] closeRecording update failed:', err.message));
  };

  doClose();  // fire-and-forget
}

// ── Startup: scan all module recording directories ────────────────────────────
//
// Scans ERS, ENS, IVR, MANUAL, and legacy CONF directories.
// Inserts any audio file not yet in the recordings table as status='COMPLETED'.
// Existing rows (matched by recording_path) are not touched.
//
// Returns { found, inserted, skipped } for the boot log.
export async function scanRecordingDirectory() {
  const base = fsPathService.getRecordingDir();
  const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.gsm']);

  const MODULE_DIRS = [
    { dir: path.posix.join(base, 'ers'),    type: 'ERS'    },
    { dir: path.posix.join(base, 'ens'),    type: 'ENS'    },
    { dir: path.posix.join(base, 'ivr'),    type: 'IVR'    },
    { dir: path.posix.join(base, 'manual'), type: 'MANUAL' },
    // Legacy directory — operator recordings before the refactor
    { dir: path.posix.join(base, 'conf'),   type: 'MANUAL' },
  ];

  const { rows: [firstTenant] } = await query(
    `SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
  ).catch(() => ({ rows: [] }));
  const fallbackTenantId = firstTenant?.id ?? null;

  let totalFound = 0, totalInserted = 0, totalSkipped = 0;

  for (const { dir, type } of MODULE_DIRS) {
    let files;
    try {
      files = await readdirRecursive(dir, AUDIO_EXTS);
    } catch {
      continue;
    }

    console.log(`[recordings] scan: ${files.length} file(s) in "${dir}" (type=${type})`);
    totalFound += files.length;

    for (const fullPath of files) {
      const { rows: [existing] } = await query(
        `SELECT id FROM recordings WHERE recording_path = $1 AND deleted_at IS NULL`,
        [fullPath]
      ).catch(() => ({ rows: [{}] }));
      if (existing) { totalSkipped++; continue; }

      let meta = {};
      try {
        const stat = await fs.stat(fullPath);
        meta = await extractAudioMetadata(fullPath);
        meta.size_bytes = meta.size_bytes ?? stat.size;
      } catch (err) {
        console.warn(`[recordings] scan: metadata failed for "${fullPath}" — ${err.message}`);
      }

      const filename = path.basename(fullPath);
      const relativePath = fullPath.startsWith(base)
        ? fullPath.slice(base.length).replace(/^\//, '')
        : null;

      // Infer conference room from filename
      let room = null;
      let incidentUuid = null;
      let configId = null;

      if (type === 'ERS') {
        // Pattern: ers_{confRoom}_{date|ts}
        const m = /^ers_(.+?)_[\d-]{8,}/.exec(filename);
        if (m) room = m[1];
      } else if (type === 'MANUAL') {
        // Pattern: conf_{room}_{ts}
        const m = /^conf_(.+?)_\d+/.exec(filename);
        if (m) room = m[1];
      }

      if (room) {
        const { rows: [incident] } = await query(
          `SELECT incident_uuid, ers_configuration_id, tenant_id
           FROM ers_incidents
           WHERE conference_room = $1 AND deleted_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
          [room]
        ).catch(() => ({ rows: [] }));
        if (incident) {
          incidentUuid = incident.incident_uuid;
          configId     = incident.ers_configuration_id;
        }
      }

      const tenantId = fallbackTenantId;

      await query(
        `INSERT INTO recordings
           (recording_type, conference_room, incident_uuid, ers_configuration_id,
            recording_path, relative_path, original_path, status,
            file_size_bytes, duration_sec, sample_rate, channels, codec, checksum,
            started_at, ended_at, created_by, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$5,'COMPLETED',$7,$8,$9,$10,$11,$12,
                 now() - interval '1 second', now(), 'scan', $13)
         ON CONFLICT ON CONSTRAINT uq_recordings_storage_path DO NOTHING`,
        [
          type, room, incidentUuid, configId,
          fullPath, relativePath,
          meta.size_bytes   ?? null,
          meta.duration_sec ?? null,
          meta.sample_rate  ?? null,
          meta.channels     ?? null,
          meta.codec        ?? null,
          meta.checksum     ?? null,
          tenantId,
        ]
      ).catch(err => console.warn(`[recordings] scan: insert failed for "${filename}" — ${err.message}`));

      totalInserted++;
      console.log(`[recordings] scan: imported "${filename}" (type=${type} room="${room}" tenant=${tenantId})`);
    }
  }

  console.log(`[recordings] scan complete — found=${totalFound} inserted=${totalInserted} skipped=${totalSkipped}`);
  return { found: totalFound, inserted: totalInserted, skipped: totalSkipped };
}

async function readdirRecursive(dir, exts) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await readdirRecursive(full, exts));
    } else if (exts.has(path.extname(e.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}
