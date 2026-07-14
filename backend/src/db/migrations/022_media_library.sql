-- ============================================================
--  Migration 022 — Media Library enhancement + Conference Recordings
--
--  1. Enriches media_files with audio metadata, checksum, tags
--  2. Creates conference_recordings — authoritative record of every
--     conference recording, populated automatically by ESL events
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Enrich media_files with full audio metadata
-- ────────────────────────────────────────────────────────────

ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS sample_rate   INT,
  ADD COLUMN IF NOT EXISTS channels      INT,
  ADD COLUMN IF NOT EXISTS codec         VARCHAR(32),
  ADD COLUMN IF NOT EXISTS bitrate_kbps  INT,
  ADD COLUMN IF NOT EXISTS checksum      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS version       INT         NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tags          TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS usage_count   INT         NOT NULL DEFAULT 0;

-- Fast lookups for the Media Library list queries
CREATE INDEX IF NOT EXISTS idx_media_checksum
  ON media_files (checksum) WHERE deleted_at IS NULL AND checksum IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_tags
  ON media_files USING GIN (tags) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- 2. Conference Recordings — one row per recording file
--
--    Populated automatically by the backend when FreeSWITCH fires
--    start-recording / stop-recording conference::maintenance events.
--    Never populated by manual import.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conference_recordings (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_room       TEXT          NOT NULL,

  -- Link to the ERS incident this conference belongs to (nullable — a
  -- monitoring-initiated recording has no incident)
  incident_uuid         UUID          REFERENCES ers_incidents(incident_uuid) ON DELETE SET NULL,
  ers_configuration_id  INT           REFERENCES ers_configurations(id) ON DELETE SET NULL,

  -- File details — path on the FreeSWITCH/shared volume
  recording_path        TEXT,
  recording_file        TEXT          GENERATED ALWAYS AS (
                          CASE WHEN recording_path IS NOT NULL
                               THEN regexp_replace(recording_path, '^.*/([^/]+)$', '\1')
                               ELSE NULL
                          END
                        ) STORED,

  -- Audio metadata (populated after the recording closes)
  file_size_bytes       BIGINT,
  duration_sec          NUMERIC(10,3),
  sample_rate           INT,
  channels              INT,
  codec                 VARCHAR(32),
  checksum              VARCHAR(64),

  -- Lifecycle
  status        VARCHAR(16) NOT NULL DEFAULT 'RECORDING'
                  CHECK (status IN ('RECORDING','COMPLETED','FAILED','ARCHIVED')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  archived_at   TIMESTAMPTZ,

  -- Who started the recording (system=ESL-event, or user email)
  created_by    TEXT,

  -- Scoping
  tenant_id     INT         REFERENCES tenants(id) ON DELETE SET NULL,

  -- Annotations
  notes         TEXT,
  tags          TEXT[]      NOT NULL DEFAULT '{}',

  -- Soft delete + audit
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crec_room
  ON conference_recordings (conference_room, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crec_incident
  ON conference_recordings (incident_uuid)
  WHERE deleted_at IS NULL AND incident_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crec_status
  ON conference_recordings (status, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crec_tenant
  ON conference_recordings (tenant_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crec_tags
  ON conference_recordings USING GIN (tags)
  WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- 3. Trigger: keep updated_at current
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_conference_recordings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_crec_updated ON conference_recordings;
CREATE TRIGGER trg_crec_updated
  BEFORE UPDATE ON conference_recordings
  FOR EACH ROW EXECUTE FUNCTION touch_conference_recordings();

-- ────────────────────────────────────────────────────────────
-- 4. Mark migration
-- ────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES ('022_media_library.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
