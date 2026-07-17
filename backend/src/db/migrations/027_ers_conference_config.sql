-- =============================================================================
-- Migration 027 — ERS Conference Configuration Extension
--
-- Makes ERS Configuration the single source of truth for all conference
-- behaviour. Adds conference type (STATIC/DYNAMIC), backend-driven recording
-- control (AUTO/MANUAL), and future conference behaviour knobs.
--
-- Backward compatibility
-- ─────────────────────
-- Every new column defaults to a value that preserves the current behaviour:
--   conference_type  = STATIC  → uses existing primary/secondary_bridge_number
--   recording_mode   = MANUAL  → no automatic recording (existing behaviour)
--   recording_enabled = false  → recording only via manual operator button
--
-- The existing record_conferences column (Lua channel recording) is unchanged.
-- =============================================================================

BEGIN;

-- ── Conference type ────────────────────────────────────────────────────────────

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS conference_type VARCHAR(16) NOT NULL DEFAULT 'STATIC';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ers_conf_type_check'
  ) THEN
    ALTER TABLE ers_configurations
      ADD CONSTRAINT ers_conf_type_check
        CHECK (conference_type IN ('STATIC','DYNAMIC'));
  END IF;
END $$;

-- ── Backend-driven recording ───────────────────────────────────────────────────
-- Separate from record_conferences (which controls Lua's per-channel record_session).
-- recording_enabled + recording_mode = AUTO → backend issues ESL `conference record`
-- command automatically at the configured trigger point.

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS recording_mode VARCHAR(16) NOT NULL DEFAULT 'MANUAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ers_rec_mode_check'
  ) THEN
    ALTER TABLE ers_configurations
      ADD CONSTRAINT ers_rec_mode_check
        CHECK (recording_mode IN ('AUTO','MANUAL'));
  END IF;
END $$;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS recording_trigger VARCHAR(32) NOT NULL DEFAULT 'CONFERENCE_CREATED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ers_rec_trigger_check'
  ) THEN
    ALTER TABLE ers_configurations
      ADD CONSTRAINT ers_rec_trigger_check
        CHECK (recording_trigger IN ('CONFERENCE_CREATED','FIRST_PARTICIPANT','MODERATOR_JOIN'));
  END IF;
END $$;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS recording_format VARCHAR(8) NOT NULL DEFAULT 'wav';

-- ── Conference behaviour (Phase 4) ────────────────────────────────────────────
-- Reserved for future implementation. Stored now so the schema is stable;
-- the application currently reads but does not enforce these values.

-- Maximum simultaneous participants in any single bridge (0 = unlimited)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS max_participants INT NOT NULL DEFAULT 0;

-- Lock the conference after a moderator joins (reserved)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS conference_lock BOOLEAN NOT NULL DEFAULT false;

-- Destroy the empty conference automatically (reserved — FS default is auto-destroy)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS auto_destroy BOOLEAN NOT NULL DEFAULT true;

-- Allow participants who are not pre-configured responders (reserved)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS allow_external BOOLEAN NOT NULL DEFAULT false;

-- Allow the same responder to join more than once (reserved)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS allow_duplicate_responders BOOLEAN NOT NULL DEFAULT false;

-- Require a moderator before the conference becomes audible (reserved)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS moderator_required BOOLEAN NOT NULL DEFAULT false;

-- Seconds to wait for the first participant before tearing down (0 = disabled, reserved)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS bridge_timeout_sec INT NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version) VALUES ('027_ers_conference_config.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
