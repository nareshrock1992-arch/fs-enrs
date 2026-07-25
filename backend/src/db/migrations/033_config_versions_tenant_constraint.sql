-- ============================================================
--  Migration 033 — Fix config_versions unique constraint
--
--  Migration 032 added UNIQUE (provider_id, version_num) which
--  prevents two tenants from each having version_num = 1 for
--  the same provider. The correct constraint scopes uniqueness
--  per tenant so each tenant has its own independent sequence.
--
--  Idempotent: guarded by constraint name checks.
-- ============================================================

BEGIN;

DO $$ BEGIN
  -- Drop the incorrect cross-tenant constraint if it exists.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_versions_provider_version_uq'
  ) THEN
    ALTER TABLE config_versions
      DROP CONSTRAINT config_versions_provider_version_uq;
  END IF;
END $$;

-- Add the tenant-scoped unique index using COALESCE to handle NULL tenant_id
-- consistently. tenant_id is a FK to tenants(id) which uses SERIAL starting
-- from 1, so COALESCE(tenant_id, -1) safely maps single-tenant installs (NULL)
-- to -1 without colliding with any real tenant.
-- This avoids UNIQUE NULLS NOT DISTINCT which requires PostgreSQL ≥ 15.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_tenant_provider_version_uix
  ON config_versions(COALESCE(tenant_id, -1), provider_id, version_num);

COMMIT;
