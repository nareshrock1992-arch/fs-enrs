-- ============================================================
--  Migration 025 — Waveform peaks cache on media_files
--
--  Stores pre-computed waveform peak data as JSONB so the
--  /waveform endpoint can serve instantly without re-reading
--  the audio file on every request.
-- ============================================================

BEGIN;

ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS waveform_peaks JSONB;

-- When waveform_peaks is populated, mark the file as having waveform data
CREATE INDEX IF NOT EXISTS idx_media_waveform
  ON media_files (id) WHERE waveform_peaks IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('025_waveform_cache.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
