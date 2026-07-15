-- ============================================================
--  Migration 023 — Add UNIQUE constraint to conference_recordings
--
--  upsertRecordingStart uses ON CONFLICT DO NOTHING to prevent
--  duplicate rows when a start-recording ESL event fires more than
--  once for the same conference+path.  Without a named UNIQUE
--  constraint, ON CONFLICT DO NOTHING is a no-op and duplicates
--  accumulate silently.
--
--  Uses a DO block so this is fully idempotent — safe to run
--  against a DB where the constraint already exists.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_conf_recordings_room_path'
  ) THEN
    ALTER TABLE conference_recordings
      ADD CONSTRAINT uq_conf_recordings_room_path
        UNIQUE (conference_room, recording_path);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('023_conference_recordings_unique.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
