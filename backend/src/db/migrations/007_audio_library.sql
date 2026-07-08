-- ============================================================
--  Migration 007 — Audio Library + Deployment Tracking
--
--  Adds:
--    1. Audio library columns to media_files (FS path + category + deploy flag)
--    2. ivr_flow_deployments table for deployment history
--    3. Deployment status cache on ivr_flows
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- A1: Enhance media_files for Audio Library
-- Root cause: media_files only tracked local ./uploads path.
--   Now we also track the deployed FreeSWITCH path.
-- ────────────────────────────────────────────────────────────

ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS category     VARCHAR(64)  NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS fs_path      VARCHAR(512),
  ADD COLUMN IF NOT EXISTS is_deployed  BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deployed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS duration_sec NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS tenant_id    INT REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_media_category
  ON media_files (category) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_tenant
  ON media_files (tenant_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- A2: IVR flow deployment history
-- Each Deploy action inserts one row here.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ivr_flow_deployments (
  id              BIGSERIAL    PRIMARY KEY,
  flow_uuid       UUID         NOT NULL,
  deployed_by     INT          REFERENCES users(id) ON DELETE SET NULL,
  deployed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status          VARCHAR(16)  NOT NULL
                    CHECK (status IN ('success','failed','partial')),
  version_number  INT,
  lua_path        VARCHAR(512),
  xml_path        VARCHAR(512),
  error_message   TEXT,
  report          JSONB,
  CONSTRAINT fk_deploy_flow
    FOREIGN KEY (flow_uuid) REFERENCES ivr_flows(flow_uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivr_deploy_flow
  ON ivr_flow_deployments (flow_uuid, deployed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ivr_deploy_status
  ON ivr_flow_deployments (status, deployed_at DESC);

-- ────────────────────────────────────────────────────────────
-- A3: Deployment status cache on ivr_flows
-- Updated after each successful Deploy so the UI can show
-- status without querying deployment history.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ivr_flows
  ADD COLUMN IF NOT EXISTS last_deployed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_deployment_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS last_deployed_version  INT;

-- ────────────────────────────────────────────────────────────
-- A4: emergency_numbers — add ivr_flow_id FK if missing
-- (migration 004 may have added it; this is idempotent)
-- ────────────────────────────────────────────────────────────

ALTER TABLE emergency_numbers
  ADD COLUMN IF NOT EXISTS ivr_flow_id INT REFERENCES ivr_flows(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_emerg_number_ivr
  ON emergency_numbers (ivr_flow_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- A5: Record this migration
-- ────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES ('007_audio_library.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
