/**
 * Startup schema validator.
 *
 * Checks that every column referenced by mediaLibraryController and
 * recordingController actually exists in PostgreSQL. Fails fast with a
 * clear diagnostic so "column does not exist" never surfaces at runtime.
 *
 * Add a table entry here whenever a new controller references columns that
 * a migration must have added — this catches "controller ahead of schema"
 * at boot rather than at first API call.
 */

import { query } from './pool.js';

const REQUIRED = {
  media_files: [
    'id', 'organization_id', 'uploaded_by_user_id', 'type', 'name',
    'path_or_uri', 'size_bytes', 'is_active', 'created_at', 'deleted_at',
    // Added by migration 007:
    'category', 'fs_path', 'is_deployed', 'deployed_at', 'description',
    'duration_sec', 'tenant_id',
    // Added by migration 022:
    'sample_rate', 'channels', 'codec', 'bitrate_kbps', 'checksum',
    'version', 'tags', 'notes', 'usage_count',
    // Added by migration 024:
    'updated_at',
    // Added by migration 025:
    'waveform_peaks',
  ],
  conference_recordings: [
    'id', 'conference_room', 'recording_path', 'recording_file',
    'status', 'started_at', 'ended_at', 'tenant_id', 'created_at', 'updated_at',
    'deleted_at',
  ],
};

export async function validateSchema() {
  let failed = false;

  for (const [table, cols] of Object.entries(REQUIRED)) {
    let rows;
    try {
      ({ rows } = await query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      ));
    } catch (err) {
      console.error(`[schema] Cannot query information_schema: ${err.message}`);
      failed = true;
      continue;
    }

    const existing = new Set(rows.map(r => r.column_name));

    // Table doesn't exist yet
    if (existing.size === 0) {
      console.error(`[schema] FATAL: table "${table}" does not exist.`);
      console.error('[schema] Run: cd backend && node src/db/migrate.js');
      failed = true;
      continue;
    }

    const missing = cols.filter(c => !existing.has(c));
    if (missing.length > 0) {
      console.error(
        `[schema] FATAL: table "${table}" is missing columns: ${missing.join(', ')}`
      );
      console.error('[schema] Run: cd backend && node src/db/migrate.js');
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log('[schema] Startup schema validation passed.');
}
