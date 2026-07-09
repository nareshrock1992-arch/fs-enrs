-- ============================================================
--  Migration 004 — Sprint B3: IVR Flow Engine
--
--  Idempotent upgrade-safe migration.
--  Safe to run on:
--    • A brand-new database (schema.sql was not applied)
--    • An existing database where ivr_flows/ivr_flow_versions
--      were created by old schema.sql without the Sprint B3 columns
--    • A database that already has all these columns (all ALTERs are
--      IF NOT EXISTS; all constraints are guarded; all UPDATEs are
--      WHERE <condition>, so re-runs produce 0 rows updated)
--
--  Column-rename strategy (old → new, both kept for backward compat):
--    ivr_flow_versions.version     → version_number
--    ivr_flow_versions.flow_json   → graph
--    ivr_flow_versions.created_by  → published_by
--    ivr_flow_versions.created_at  → published_at  (preserved as-is too)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1.  ivr_flows
--
--  Old schema.sql created this table without:
--    flow_uuid, tenant_id, graph, created_by, updated_by
--
--  CREATE TABLE IF NOT EXISTS — covers a completely fresh database.
--  ALTER TABLE statements — cover the common case where the table already
--  exists (existing Dabin-style databases) and add only the missing columns.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ivr_flows (
  id              BIGSERIAL    PRIMARY KEY,
  flow_uuid       UUID         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       INT          REFERENCES tenants(id)       ON DELETE SET NULL,
  organization_id INT          REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  graph           JSONB        NOT NULL DEFAULT '{}',
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_by      INT          REFERENCES users(id)         ON DELETE SET NULL,
  updated_by      INT          REFERENCES users(id)         ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Add columns that are missing on databases where the old ivr_flows exists.
-- Each ADD COLUMN IF NOT EXISTS is a no-op when the column is already present.
ALTER TABLE ivr_flows
  ADD COLUMN IF NOT EXISTS flow_uuid       UUID        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS tenant_id       INT         REFERENCES tenants(id)       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS graph           JSONB       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_by      INT         REFERENCES users(id)         ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by      INT         REFERENCES users(id)         ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organization_id INT         REFERENCES organizations(id) ON DELETE CASCADE;

-- UNIQUE constraint on flow_uuid — guarded so re-runs don't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname    = 'ivr_flows_flow_uuid_key'
      AND conrelid   = 'ivr_flows'::regclass
  ) THEN
    ALTER TABLE ivr_flows ADD CONSTRAINT ivr_flows_flow_uuid_key UNIQUE (flow_uuid);
  END IF;
END $$;

-- Backfill tenant_id from the owning organization for all existing rows.
-- WHERE tenant_id IS NULL makes this idempotent: rows already backfilled
-- are untouched on re-runs.
UPDATE ivr_flows f
SET    tenant_id = o.tenant_id
FROM   organizations o
WHERE  f.organization_id = o.id
  AND  f.tenant_id IS NULL
  AND  o.tenant_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2.  ivr_flow_versions
--
--  Old schema.sql created this table with columns:
--    id, ivr_flow_id (INT), version (INT), flow_json (JSONB),
--    created_by (INT), created_at (TIMESTAMPTZ)
--
--  Sprint B3 introduces new column names alongside the old ones
--  (old columns are not dropped — they stay for backward compat and are
--  used by migration 005's backfill pass).
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ivr_flow_versions (
  id             BIGSERIAL    PRIMARY KEY,
  version_uuid   UUID         NOT NULL DEFAULT gen_random_uuid(),
  ivr_flow_id    BIGINT       NOT NULL REFERENCES ivr_flows(id) ON DELETE CASCADE,
  version_number INT          NOT NULL DEFAULT 1,
  graph          JSONB        NOT NULL DEFAULT '{}',
  published_by   INT          REFERENCES users(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  change_notes   TEXT,
  UNIQUE (ivr_flow_id, version_number)
);

-- Add Sprint B3 columns to existing ivr_flow_versions tables.
-- The old columns (version, flow_json, created_by) are not touched.
ALTER TABLE ivr_flow_versions
  ADD COLUMN IF NOT EXISTS version_uuid   UUID        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS version_number INT,
  ADD COLUMN IF NOT EXISTS graph          JSONB,
  ADD COLUMN IF NOT EXISTS published_by   INT         REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS change_notes   TEXT;

-- UNIQUE constraint on version_uuid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'ivr_flow_versions_version_uuid_key'
      AND conrelid = 'ivr_flow_versions'::regclass
  ) THEN
    ALTER TABLE ivr_flow_versions
      ADD CONSTRAINT ivr_flow_versions_version_uuid_key UNIQUE (version_uuid);
  END IF;
END $$;

-- Backfill version_number from old 'version' column (if column exists).
-- Uses EXECUTE to avoid a parse error when 'version' column is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ivr_flow_versions'
      AND column_name  = 'version'
  ) THEN
    EXECUTE '
      UPDATE ivr_flow_versions
      SET    version_number = version
      WHERE  version IS NOT NULL
        AND  version_number IS NULL
    ';
  END IF;
  -- Fallback: use row id as a unique sequence for any remaining NULLs
  UPDATE ivr_flow_versions
  SET    version_number = id
  WHERE  version_number IS NULL;
END $$;

-- Backfill graph from old 'flow_json' column (if column exists).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ivr_flow_versions'
      AND column_name  = 'flow_json'
  ) THEN
    EXECUTE '
      UPDATE ivr_flow_versions
      SET    graph = flow_json
      WHERE  flow_json IS NOT NULL
        AND  graph IS NULL
    ';
  END IF;
  -- Ensure no NULLs remain (column was added without NOT NULL on existing rows)
  UPDATE ivr_flow_versions
  SET    graph = '{}'::jsonb
  WHERE  graph IS NULL;
END $$;

-- Backfill published_by from old 'created_by' column (if column exists).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ivr_flow_versions'
      AND column_name  = 'created_by'
  ) THEN
    EXECUTE '
      UPDATE ivr_flow_versions
      SET    published_by = created_by
      WHERE  created_by IS NOT NULL
        AND  published_by IS NULL
    ';
  END IF;
END $$;

-- Backfill published_at from created_at — ONLY on databases where the old
-- pre-Sprint-B3 table had that column. The CREATE TABLE above (used on
-- fresh/schema.sql databases) never creates created_at on this table, so
-- referencing it unconditionally breaks fresh installs (42703).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ivr_flow_versions'
      AND column_name  = 'created_at'
  ) THEN
    EXECUTE '
      UPDATE ivr_flow_versions
      SET    published_at = created_at
      WHERE  created_at   IS NOT NULL
        AND  published_at IS NULL
    ';
  END IF;
END $$;

-- Final fallback: any remaining NULLs get now()
UPDATE ivr_flow_versions SET published_at = now() WHERE published_at IS NULL;

-- UNIQUE constraint on (ivr_flow_id, version_number) — only after backfill.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'ivr_flow_versions_ivr_flow_id_version_number_key'
      AND conrelid = 'ivr_flow_versions'::regclass
  ) THEN
    -- Guard: don't add the constraint if duplicate (ivr_flow_id, version_number)
    -- pairs exist (would mean the backfill produced collisions).
    IF NOT EXISTS (
      SELECT ivr_flow_id, version_number
      FROM   ivr_flow_versions
      WHERE  version_number IS NOT NULL
      GROUP  BY ivr_flow_id, version_number
      HAVING COUNT(*) > 1
    ) THEN
      ALTER TABLE ivr_flow_versions
        ADD CONSTRAINT ivr_flow_versions_ivr_flow_id_version_number_key
        UNIQUE (ivr_flow_id, version_number);
    END IF;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3.  emergency_numbers — bind to IVR flow
--
--  Add ivr_flow_id FK only if emergency_numbers table exists.
--  (It is created by migration 003; guard protects against out-of-order runs.)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'emergency_numbers'
  ) THEN
    EXECUTE '
      ALTER TABLE emergency_numbers
        ADD COLUMN IF NOT EXISTS ivr_flow_id BIGINT
        REFERENCES ivr_flows(id) ON DELETE SET NULL
    ';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4.  Indexes
--     All use IF NOT EXISTS — safe to re-run.
--     Partial indexes on tenant_id / org require the column to exist,
--     which is guaranteed by the ADD COLUMN steps above.
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ivr_flows_tenant
  ON ivr_flows (tenant_id)       WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_org
  ON ivr_flows (organization_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_active
  ON ivr_flows (is_active)       WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_uuid
  ON ivr_flows (flow_uuid)       WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_versions_flow
  ON ivr_flow_versions (ivr_flow_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_ivr_versions_latest
  ON ivr_flow_versions (ivr_flow_id, published_at DESC);

-- emergency_numbers index — only if the column was successfully added above
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'emergency_numbers'
      AND column_name  = 'ivr_flow_id'
  ) THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_emergency_numbers_ivr_flow
        ON emergency_numbers (ivr_flow_id)
        WHERE ivr_flow_id IS NOT NULL
    ';
  END IF;
END $$;

COMMIT;
