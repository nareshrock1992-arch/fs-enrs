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

import { promises as fs } from 'fs';
import { contentDisposition, sendFileWithRange } from '../utils/mediaHttp.js';
import path from 'path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { query } from '../db/pool.js';
import { extractAudioMetadata, extractWaveformPeaks } from './mediaLibraryController.js';
import { fsPathService } from '../services/freeSwitchPathService.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';

const MIME_MAP = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.gsm': 'audio/x-gsm',
};

// ── List recordings ───────────────────────────────────────────────────────────

// One filter definition for the list, its total and its summary counts, so the
// three can never disagree (they previously drifted: the list searched
// recording_file but the count did not). `omit` drops filters by name — the
// type tabs are counted across all types for the other active filters.
export function buildRecordingFilter(req, { omit = [] } = {}) {
  const q = req.query;
  const clauses = ['r.deleted_at IS NULL'];
  const params = [];
  const add = (name, value, sql) => {
    if (omit.includes(name) || value === undefined || value === null || value === '') return;
    params.push(value);
    clauses.push(sql.replace(/\$\?/g, `$${params.length}`));
  };
  const tenant = req.user?.role === 'SUPER_ADMIN'
    ? (q.tenant_id ? Number(q.tenant_id) : null)
    : req.user?.tenantId;
  if (tenant !== null && tenant !== undefined) add('tenant', tenant, 'r.tenant_id = $?::int');
  add('status',          q.status,          'r.status = $?::text');
  add('conference_room', q.conference_room, `r.conference_room ILIKE '%' || $?::text || '%'`);
  add('incident_uuid',   q.incident_uuid,   'r.incident_uuid = $?::uuid');
  add('ers_config_id',   q.ers_config_id,   'r.ers_configuration_id = $?::int');
  add('organization_id', q.organization_id, 'e.organization_id = $?::int');
  add('tag',             q.tag,             '$?::text = ANY(r.tags)');
  add('search',          q.search,          `(r.notes ILIKE '%' || $?::text || '%' OR r.recording_file ILIKE '%' || $?::text || '%')`);
  add('date_from',       q.date_from,       'r.started_at >= $?::timestamptz');
  add('date_to',         q.date_to,         'r.started_at <= $?::timestamptz');
  add('recording_type',  q.recording_type,  'r.recording_type = $?::text');
  return { where: clauses.join('\n       AND '), params };
}

const RECORDING_FROM = `FROM recordings r
     LEFT JOIN ers_configurations e ON e.id = r.ers_configuration_id`;

export const listRecordings = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 25);
  const offset = (page - 1) * limit;

  const f = buildRecordingFilter(req);
  const { rows } = await query(
    `SELECT
       r.id, r.recording_type, r.conference_room, r.conference_name,
       r.incident_uuid, r.campaign_id, r.ers_configuration_id,
       r.recording_path, r.recording_file, r.relative_path,
       r.file_size_bytes, r.duration_sec, r.sample_rate, r.channels, r.codec,
       r.checksum, r.status, r.started_at, r.ended_at, r.archived_at,
       r.created_by, r.notes, r.tags, r.created_at, r.updated_at,
       i.caller_number,   i.group_type,       i.status AS incident_status,
       i.started_at       AS incident_started, i.ended_at AS incident_ended,
       e.name             AS ers_name,
       e.primary_bridge_number,
       o.name             AS organization_name
     ${RECORDING_FROM}
     LEFT JOIN ers_incidents  i ON i.incident_uuid = r.incident_uuid
     LEFT JOIN organizations  o ON o.id = e.organization_id
     WHERE ${f.where}
     ORDER BY r.started_at DESC
     LIMIT $${f.params.length + 1} OFFSET $${f.params.length + 2}`,
    [...f.params, limit, offset]
  );

  const { rows: [{ total }] } = await query(
    `SELECT COUNT(*)::int AS total ${RECORDING_FROM} WHERE ${f.where}`, f.params);

  // Summary across the WHOLE filtered result set (not the current page):
  // per-status counts honour every filter; per-type counts drop only the type
  // filter, so every tab shows how many it would contain.
  const { rows: statusRows } = await query(
    `SELECT r.status, COUNT(*)::int AS n ${RECORDING_FROM} WHERE ${f.where} GROUP BY r.status`, f.params);
  const ft = buildRecordingFilter(req, { omit: ['recording_type'] });
  const { rows: typeRows } = await query(
    `SELECT r.recording_type, COUNT(*)::int AS n ${RECORDING_FROM} WHERE ${ft.where} GROUP BY r.recording_type`, ft.params);
  const by_type = Object.fromEntries(typeRows.map((x) => [x.recording_type, x.n]));
  const summary = {
    by_status: Object.fromEntries(statusRows.map((x) => [x.status, x.n])),
    by_type,
    all_types_total: typeRows.reduce((s, x) => s + x.n, 0),
  };

  res.json({ recordings: rows, total, page, limit, summary });
});

// ── Get single with full module context ───────────────────────────────────────

export const getRecording = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
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
     WHERE r.id = $1 AND r.deleted_at IS NULL
       AND ($2::int IS NULL OR r.tenant_id = $2)`,
    [req.params.id, tenantId]
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
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const { size } = await fs.stat(filePath);
  const mime = MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav';
  return sendFileWithRange(req, res, { filePath, size, mime });
});

// ── Download ──────────────────────────────────────────────────────────────────

export const downloadRecording = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });

  const filePath = await resolveFile(rec);
  if (!filePath) return res.status(404).json({ error: 'Recording file not found on disk' });

  const { size } = await fs.stat(filePath);
  return sendFileWithRange(req, res, {
    filePath, size,
    mime: MIME_MAP[path.extname(filePath).toLowerCase()] || 'audio/wav',
    disposition: contentDisposition('attachment', rec.recording_file || path.basename(filePath)),
  });
});

// ── Waveform peaks ────────────────────────────────────────────────────────────

export const getRecordingWaveform = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `SELECT * FROM recordings WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
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
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `UPDATE recordings
     SET notes = COALESCE($3, notes),
         tags  = COALESCE($4, tags),
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING *`,
    [req.params.id, tenantId, notes ?? null, tags ?? null]
  );
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json({ recording: rec });
});

// ── Archive ───────────────────────────────────────────────────────────────────

export const archiveRecording = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `UPDATE recordings
     SET status = 'ARCHIVED', archived_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'ARCHIVED'
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING *`,
    [req.params.id, tenantId]
  );
  if (!rec) return res.status(404).json({ error: 'Not found or already archived' });
  res.json({ recording: rec });
});

// ── Delete (soft) ─────────────────────────────────────────────────────────────

export const deleteRecording = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [rec] } = await query(
    `UPDATE recordings SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING *`,
    [req.params.id, tenantId]
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
  allowFallback = true,
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

  if (!resolvedTenantId && allowFallback) {
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
    console.log(`[recordings] closeRecording started — room="${confName}" path="${recPath}"`);
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

    const { rowCount } = await query(
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
    ).catch(err => { console.error('[recordings] closeRecording update failed:', err.message); return { rowCount: 0 }; });
    if (rowCount > 0) {
      console.log(`[recordings] closeRecording COMPLETED — room="${confName}" file="${path.basename(recPath)}" size=${meta.size_bytes} duration=${meta.duration_sec}s`);
    } else {
      console.warn(`[recordings] closeRecording: no RECORDING row matched path="${recPath}" room="${confName}" — row may have been inserted by boot scan or already completed`);
    }
  };

  doClose().catch(err => console.error('[recordings] closeRecording doClose failed:', err.message));
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
        `SELECT id, status FROM recordings WHERE recording_path = $1 AND deleted_at IS NULL`,
        [fullPath]
      ).catch(() => ({ rows: [{}] }));
      if (existing) {
        // Heal rows stuck in RECORDING state — the file exists on disk but
        // the stop-recording event never finalised it (e.g. conference-destroy race).
        if (existing.status === 'RECORDING') {
          let healMeta = {};
          try { healMeta = await extractAudioMetadata(fullPath); } catch { /* optional */ }
          await query(
            `UPDATE recordings
             SET status = 'COMPLETED', ended_at = now(),
                 file_size_bytes = COALESCE($2, file_size_bytes),
                 duration_sec    = COALESCE($3, duration_sec),
                 updated_at      = now()
             WHERE id = $1 AND status = 'RECORDING' AND deleted_at IS NULL`,
            [existing.id, healMeta.size_bytes ?? null, healMeta.duration_sec ?? null]
          ).catch(err => console.warn(`[recordings] scan: heal failed for id=${existing.id} — ${err.message}`));
          console.log(`[recordings] scan: healed stuck RECORDING row id=${existing.id} for "${path.basename(fullPath)}"`);
        }
        totalSkipped++;
        continue;
      }

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

      let incidentTenantId = null;
      if (room) {
        const { rows: [incident] } = await query(
          `SELECT incident_uuid, ers_configuration_id, tenant_id
           FROM ers_incidents
           WHERE conference_room = $1 AND deleted_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
          [room]
        ).catch(() => ({ rows: [] }));
        if (incident) {
          incidentUuid    = incident.incident_uuid;
          configId        = incident.ers_configuration_id;
          incidentTenantId = incident.tenant_id ?? null;
        }
      }

      // IVR recordings are registered at runtime via POST /internal/ivr/recording/register
      // with the correct tenant derived from emergency_numbers. Boot-scan should not
      // override an already-registered row (ON CONFLICT DO NOTHING handles that), and
      // for any truly orphaned IVR file the canonical owner cannot be inferred from
      // the filename alone — assign NULL so they are visibly unresolved, not silently
      // claimed by the first tenant in the database.
      const tenantId = type === 'IVR'
        ? null
        : (incidentTenantId ?? fallbackTenantId);

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
