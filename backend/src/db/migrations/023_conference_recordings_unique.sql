-- ============================================================
--  Migration 023 — Add UNIQUE constraint to conference_recordings
--
--  upsertRecordingStart uses ON CONFLICT DO NOTHING to prevent
--  duplicate rows when a start-recording ESL event fires more than
--  once for the same conference+path.  Without a named UNIQUE
--  constraint, ON CONFLICT DO NOTHING is a no-op and duplicates
--  accumulate silently.
-- ============================================================

BEGIN;

ALTER TABLE conference_recordings
  ADD CONSTRAINT uq_conf_recordings_room_path
    UNIQUE (conference_room, recording_path);

COMMIT;
