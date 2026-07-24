-- ============================================================
--  Migration 032 — Platform Configuration Framework
--
--  Tables:
--    config_versions   — full XML snapshots of every deployed config
--    config_audit_log  — per-action audit trail (read, preview, deploy, rollback)
--
--  Idempotent: all statements use IF NOT EXISTS / DO $$.
-- ============================================================

BEGIN;

-- ── Version snapshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_versions (
  id              SERIAL          PRIMARY KEY,
  tenant_id       INT             REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id     VARCHAR(64)     NOT NULL,
  file_path       TEXT            NOT NULL,
  version_num     INT             NOT NULL,
  xml_content     TEXT            NOT NULL,
  checksum        VARCHAR(64)     NOT NULL,
  deployed_by     INT             REFERENCES users(id) ON DELETE SET NULL,
  deployed_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  reason          TEXT,
  is_active       BOOLEAN         NOT NULL DEFAULT false,
  backup_path     TEXT,
  diff_summary    TEXT,
  changed_keys    JSONB,
  deploy_meta     JSONB
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_versions_provider_version_uq'
  ) THEN
    ALTER TABLE config_versions
      ADD CONSTRAINT config_versions_provider_version_uq
      UNIQUE (provider_id, version_num);
  END IF;
END $$;

-- ── Audit log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_audit_log (
  id              SERIAL          PRIMARY KEY,
  tenant_id       INT             REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         INT             REFERENCES users(id) ON DELETE SET NULL,
  provider_id     VARCHAR(64)     NOT NULL,
  action          VARCHAR(32)     NOT NULL
                  CHECK (action IN ('read','preview','deploy','rollback')),
  file_path       TEXT            NOT NULL,
  version_id      INT             REFERENCES config_versions(id) ON DELETE SET NULL,
  old_value       JSONB,
  new_value       JSONB,
  status          VARCHAR(16)     NOT NULL
                  CHECK (status IN ('success','failed')),
  error           TEXT,
  duration_ms     INT,
  backup_path     TEXT,
  deploy_meta     JSONB,
  performed_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_config_versions_provider
  ON config_versions(provider_id, deployed_at DESC);

CREATE INDEX IF NOT EXISTS idx_config_versions_active
  ON config_versions(provider_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_config_audit_provider
  ON config_audit_log(provider_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_config_audit_user
  ON config_audit_log(user_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_config_audit_tenant
  ON config_audit_log(tenant_id, performed_at DESC);

COMMIT;
