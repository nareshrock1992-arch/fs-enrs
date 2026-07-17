-- =============================================================================
-- Migration 026 — Recording Ownership Refactor
--
-- Renames conference_recordings → recordings and adds module-ownership columns.
-- Business modules (ERS, ENS, IVR) own their recordings rather than the
-- generic conference bridge transport.
--
-- Recording type taxonomy:
--   ERS    — Emergency Response System conference recording (Lua record_session
--             OR operator-initiated conference record command)
--   ENS    — Emergency Notification System blast message recording
--   IVR    — IVR session recording (future; record_message node)
--   MANUAL — Operator-initiated recording for a non-incident conference
--
-- Path conventions after this migration:
--   recordings/ers/{YYYY}/{MM}/ers_{room}_{ts}.wav
--   recordings/ens/{YYYY}/{MM}/ens_{id}_{ts}.wav
--   recordings/ivr/{YYYY}/{MM}/ivr_{id}_{ts}.wav
--   recordings/manual/{YYYY}/{MM}/conf_{room}_{ts}.wav
--   recordings/conf/...   (legacy; still accepted by file scanner)
-- =============================================================================

BEGIN;

-- 1. Rename table
ALTER TABLE IF EXISTS conference_recordings RENAME TO recordings;

-- 2. Replace UNIQUE constraint (old: conference_room+recording_path; new: recording_path only)
--    recording_path alone is the canonical dedup key. The old two-column constraint excludes
--    Lua recordings that have no conference_room (NULL != NULL in SQL), allowing duplicates.
DO $$
BEGIN
  -- Drop old compound constraint
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_conf_recordings_room_path'
  ) THEN
    ALTER TABLE recordings DROP CONSTRAINT uq_conf_recordings_room_path;
  END IF;
  -- Add path-only constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_recordings_storage_path'
  ) THEN
    ALTER TABLE recordings ADD CONSTRAINT uq_recordings_storage_path
      UNIQUE (recording_path);
  END IF;
END $$;

-- 3a. Relax conference_room NOT NULL — Lua record_session recordings have no conference
ALTER TABLE recordings ALTER COLUMN conference_room DROP NOT NULL;

-- 3. Add recording_type column
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recording_type VARCHAR(16) NOT NULL DEFAULT 'ERS';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recordings_type_check'
  ) THEN
    ALTER TABLE recordings ADD CONSTRAINT recordings_type_check
      CHECK (recording_type IN ('ERS','ENS','IVR','MANUAL'));
  END IF;
END $$;

-- 4. Add module link columns
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS campaign_id UUID;        -- ENS: ens_notifications.notification_uuid
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS ivr_session_id TEXT;     -- IVR: future

-- 5. Add storage organisation columns
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS relative_path   TEXT;    -- path relative to RECORDINGS_BASE
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS original_path   TEXT;    -- FS path as written by FreeSWITCH (may differ after move)

-- 6. Add waveform cache and participant snapshot
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS waveform_peaks  JSONB;   -- pre-computed peaks for waveform UI
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS participants     JSONB;   -- snapshot: [{id, callerNum, callerName, joinedAt, leftAt}]

-- 7. Add storage_path alias (canonical name for the file location)
--    recording_path keeps its name so ESL/scan code keeps working;
--    storage_path is a generated alias pointing to the same value.
--    We use a view-level alias in queries rather than a generated column
--    so that UPDATE recording_path also works. Callers use recording_path.
--    (The API layer exposes this as storage_path in the JSON response.)

-- 8. Backfill recording_type from existing rows
UPDATE recordings
SET recording_type = CASE
  WHEN incident_uuid IS NOT NULL THEN 'ERS'
  ELSE 'MANUAL'
END
WHERE recording_type = 'ERS';  -- DEFAULT was 'ERS', so all rows need re-evaluation

-- 9. Backfill relative_path for existing rows
UPDATE recordings
SET relative_path = regexp_replace(recording_path, '^.*/recordings/', '', 'i')
WHERE relative_path IS NULL
  AND recording_path IS NOT NULL
  AND recording_path LIKE '%recordings%';

-- 10. Set original_path = recording_path for existing rows (they were never moved)
UPDATE recordings
SET original_path = recording_path
WHERE original_path IS NULL
  AND recording_path IS NOT NULL;

-- 11. Add conference_name as alias column for conference_room
--     (future: when we want to free conference_room from the schema, we can migrate here)
--     For now, add a generated column so both names work in queries.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS conference_name TEXT
  GENERATED ALWAYS AS (conference_room) STORED;

-- 12. Index for module lookups
CREATE INDEX IF NOT EXISTS idx_recordings_type       ON recordings (recording_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recordings_incident   ON recordings (incident_uuid)  WHERE incident_uuid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recordings_campaign   ON recordings (campaign_id)    WHERE campaign_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recordings_tenant_ts  ON recordings (tenant_id, started_at DESC) WHERE deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('026_recordings_refactor.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
