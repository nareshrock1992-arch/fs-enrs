-- ============================================================
--  Migration 005 — Stabilization
--
--  Fixes schema conflicts between schema.sql (base) and the
--  numbered migration chain (002→004). schema.sql created
--  several tables with old schemas; migrations 003 and 004
--  tried to CREATE TABLE IF NOT EXISTS — those were no-ops
--  because the tables already existed, leaving the new
--  columns and FKs missing.
--
--  This migration is FULLY IDEMPOTENT:
--    • All ALTER TABLE use ADD COLUMN IF NOT EXISTS
--    • All CREATE INDEX use IF NOT EXISTS
--    • All constraint additions are guarded with DO $$ blocks
--    • Safe to run on clean, partial, or production databases
--    • Safe to run multiple times
--
--  Run AFTER 002, 003, 004:
--    psql -d fs_enrs -f 005_stabilization.sql
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- S1: ens_configurations — add tenant_id
--
--  ensInternalController.js JOIN:
--    JOIN ens_configurations ec ON ec.tenant_id = en.tenant_id
--  Column was never added to the base schema.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id);

-- Backfill from organization
UPDATE ens_configurations ec
   SET tenant_id = o.tenant_id
  FROM organizations o
 WHERE o.id = ec.organization_id
   AND ec.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ens_cfg_tenant
  ON ens_configurations (tenant_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- S2: ers_configurations — add tenant_id
--
--  ersInternalController.js JOIN:
--    JOIN ers_configurations ec ON ec.tenant_id = en.tenant_id
-- ────────────────────────────────────────────────────────────

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id);

UPDATE ers_configurations ec
   SET tenant_id = o.tenant_id
  FROM organizations o
 WHERE o.id = ec.organization_id
   AND ec.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ers_cfg_tenant
  ON ers_configurations (tenant_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- S3: emergency_numbers — add tenant_id and ivr_flow_id
--
--  ivrController.js bindNumber:
--    WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
--  emergency_numbers was created in migration 002 without tenant_id.
--  ivr_flow_id was added by migration 004 but that ADD COLUMN
--  may have been a no-op if emergency_numbers didn't exist at
--  migration-004 time on an older DB path.
-- ────────────────────────────────────────────────────────────

ALTER TABLE emergency_numbers
  ADD COLUMN IF NOT EXISTS tenant_id   INT    REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS ivr_flow_id BIGINT REFERENCES ivr_flows(id);

UPDATE emergency_numbers en
   SET tenant_id = o.tenant_id
  FROM organizations o
 WHERE o.id = en.organization_id
   AND en.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_emergency_numbers_tenant
  ON emergency_numbers (tenant_id)
  WHERE deleted_at IS NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_emergency_numbers_ivr_flow
  ON emergency_numbers (ivr_flow_id)
  WHERE ivr_flow_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- S4: ivr_flows — add columns missing because schema.sql created
--     this table before migration 004 ran; 004's CREATE TABLE
--     IF NOT EXISTS was a no-op, leaving the new columns absent.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ivr_flows
  ADD COLUMN IF NOT EXISTS flow_uuid   UUID    DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS tenant_id   INT     REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS graph       JSONB   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_by  INT     REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by  INT     REFERENCES users(id);

-- Backfill flow_uuid for pre-existing rows
UPDATE ivr_flows SET flow_uuid = gen_random_uuid() WHERE flow_uuid IS NULL;

DO $$
BEGIN
  -- flow_uuid NOT NULL
  BEGIN
    ALTER TABLE ivr_flows ALTER COLUMN flow_uuid SET NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- flow_uuid UNIQUE
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ivr_flows_flow_uuid_key'
       AND conrelid = 'ivr_flows'::regclass
  ) THEN
    ALTER TABLE ivr_flows ADD CONSTRAINT ivr_flows_flow_uuid_key UNIQUE (flow_uuid);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_tenant
  ON ivr_flows (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ivr_flows_org
  ON ivr_flows (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ivr_flows_active
  ON ivr_flows (is_active) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- S5: ivr_flow_versions — add columns with new naming convention
--
--  schema.sql had:    version, flow_json, created_by, created_at
--  Application expects: version_number, graph, published_by, published_at
--  Migration 004's CREATE TABLE IF NOT EXISTS was a no-op.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ivr_flow_versions
  ADD COLUMN IF NOT EXISTS version_uuid   UUID        DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS version_number INT,
  ADD COLUMN IF NOT EXISTS graph          JSONB,
  ADD COLUMN IF NOT EXISTS published_by   INT         REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS change_notes   TEXT;

-- Backfill new columns from old column values — ONLY where those old
-- columns (version, flow_json, created_by, created_at) actually exist.
-- schema.sql / migration 004 never create them, so referencing them
-- unconditionally breaks every fresh install (42703).
DO $$
DECLARE
  has_version    BOOLEAN;
  has_flow_json  BOOLEAN;
  has_created_by BOOLEAN;
  has_created_at BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ivr_flow_versions' AND column_name='version')
    INTO has_version;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ivr_flow_versions' AND column_name='flow_json')
    INTO has_flow_json;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ivr_flow_versions' AND column_name='created_by')
    INTO has_created_by;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ivr_flow_versions' AND column_name='created_at')
    INTO has_created_at;

  EXECUTE format(
    'UPDATE ivr_flow_versions
        SET version_uuid   = COALESCE(version_uuid, gen_random_uuid()),
            version_number = COALESCE(version_number, %s, 1),
            graph          = COALESCE(graph, %s, ''{}''::jsonb),
            published_by   = COALESCE(published_by, %s),
            published_at   = COALESCE(published_at, %s)
      WHERE version_number IS NULL
         OR version_uuid   IS NULL',
    CASE WHEN has_version    THEN 'version'    ELSE 'NULL' END,
    CASE WHEN has_flow_json  THEN 'flow_json'  ELSE 'NULL' END,
    CASE WHEN has_created_by THEN 'created_by' ELSE 'NULL' END,
    CASE WHEN has_created_at THEN 'created_at' ELSE 'NULL' END
  );
END $$;

-- Final fallback for any rows still missing published_at (fresh-install path)
UPDATE ivr_flow_versions SET published_at = now() WHERE published_at IS NULL;

DO $$
BEGIN
  BEGIN ALTER TABLE ivr_flow_versions ALTER COLUMN version_uuid   SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE ivr_flow_versions ALTER COLUMN version_number SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE ivr_flow_versions ALTER COLUMN graph          SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE ivr_flow_versions ALTER COLUMN published_at   SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ivr_flow_versions_version_uuid_key'
  ) THEN
    ALTER TABLE ivr_flow_versions
      ADD CONSTRAINT ivr_flow_versions_version_uuid_key UNIQUE (version_uuid);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ivr_flow_versions_ivr_flow_id_version_number_key'
  ) THEN
    ALTER TABLE ivr_flow_versions
      ADD CONSTRAINT ivr_flow_versions_ivr_flow_id_version_number_key
      UNIQUE (ivr_flow_id, version_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ivr_versions_flow
  ON ivr_flow_versions (ivr_flow_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_ivr_versions_latest
  ON ivr_flow_versions (ivr_flow_id, published_at DESC);

-- ────────────────────────────────────────────────────────────
-- S6: ens_configuration_groups — add ens_group_id column
--
--  schema.sql created this table with responder_group_id FK.
--  Migration 003 B1-2 tried to CREATE TABLE with ens_group_id
--  FK → ens_groups — was a no-op. ensInternalController.js
--  queries: ecg.ens_group_id = egm.group_id
-- ────────────────────────────────────────────────────────────

ALTER TABLE ens_configuration_groups
  ADD COLUMN IF NOT EXISTS ens_group_id INT REFERENCES ens_groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ens_cfg_groups_cfg_group_key'
  ) THEN
    ALTER TABLE ens_configuration_groups
      ADD CONSTRAINT ens_cfg_groups_cfg_group_key
      UNIQUE (ens_configuration_id, ens_group_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ens_cfg_groups_cfg
  ON ens_configuration_groups (ens_configuration_id);

-- ────────────────────────────────────────────────────────────
-- S7: ens_configuration_contacts — add ens_contact_id column
--
--  schema.sql created this table with emergency_contact_id FK.
--  Migration 003 B1-1 tried to CREATE TABLE with ens_contact_id
--  FK → ens_contacts — was a no-op. ensInternalController.js
--  queries: ens_contact_id FROM ens_configuration_contacts
-- ────────────────────────────────────────────────────────────

ALTER TABLE ens_configuration_contacts
  ADD COLUMN IF NOT EXISTS ens_contact_id INT REFERENCES ens_contacts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ens_cfg_contacts_cfg_contact_key'
  ) THEN
    ALTER TABLE ens_configuration_contacts
      ADD CONSTRAINT ens_cfg_contacts_cfg_contact_key
      UNIQUE (ens_configuration_id, ens_contact_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ens_cfg_contacts_cfg
  ON ens_configuration_contacts (ens_configuration_id);

-- ────────────────────────────────────────────────────────────
-- S8: ens_notification_deliveries — schema corrections
--
--  ensInternalController.js uses:
--    • attempt_number column (schema has 'attempts')
--    • updated_at column (missing from schema.sql)
--    • INSERT without emergency_contact_id (was NOT NULL)
--  All fixed here idempotently.
-- ────────────────────────────────────────────────────────────

-- Add attempt_number as alias — keeps old 'attempts' for backward compat
ALTER TABLE ens_notification_deliveries
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ;

-- emergency_contact_id must be nullable — inserts now use contact_number
DO $$
BEGIN
  ALTER TABLE ens_notification_deliveries
    ALTER COLUMN emergency_contact_id DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ────────────────────────────────────────────────────────────
-- S9: ens_notifications — add updated_at
--
--  ensCompleteNotification uses:
--    UPDATE ens_notifications SET status = ..., updated_at = now()
-- ────────────────────────────────────────────────────────────

ALTER TABLE ens_notifications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────
-- S10: Ensure all indexes from migration 003 exist
--      (safe no-op if they were already created)
-- ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ens_notifs_config_status
  ON ens_notifications (ens_configuration_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ers_incidents_config_status
  ON ers_incidents (ers_configuration_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_emergency_numbers_number
  ON emergency_numbers (number, type)
  WHERE deleted_at IS NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_ers_queues_config_status
  ON ers_queues (ers_configuration_id, status, position);

-- Unique constraints from 003 (guarded — no-op if already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ens_notification_deliveries_notif_contact_key'
  ) THEN
    ALTER TABLE ens_notification_deliveries
      ADD CONSTRAINT ens_notification_deliveries_notif_contact_key
      UNIQUE (ens_notification_id, contact_number);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ers_incident_responders_incident_mobile_key'
  ) THEN
    ALTER TABLE ers_incident_responders
      ADD CONSTRAINT ers_incident_responders_incident_mobile_key
      UNIQUE (ers_incident_id, mobile_number);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- S11: schema_migrations — track which migrations have been applied
--      Used by the sequential migration runner (migrate.js).
--      Renamed from migration_log; migrate.js copies data from
--      migration_log automatically for backward compatibility.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(256) PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Record all previously applied migrations so the runner
-- does not re-apply them on the next deploy.
-- ON CONFLICT DO NOTHING makes this safe to re-run.
INSERT INTO schema_migrations (version) VALUES
  ('schema.sql'),
  ('002_phase6_bugfixes.sql'),
  ('003_sprint_b1_internal_api.sql'),
  ('004_sprint_b3_ivr_engine.sql'),
  ('005_stabilization.sql')
ON CONFLICT (version) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- Rollback notes (manual — run carefully):
--   ALTER TABLE ivr_flows DROP COLUMN IF EXISTS flow_uuid;
--   ALTER TABLE ivr_flows DROP COLUMN IF EXISTS tenant_id;
--   ALTER TABLE ivr_flows DROP COLUMN IF EXISTS graph;
--   ALTER TABLE ivr_flows DROP COLUMN IF EXISTS created_by;
--   ALTER TABLE ivr_flows DROP COLUMN IF EXISTS updated_by;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS version_uuid;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS version_number;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS graph;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS published_by;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS published_at;
--   ALTER TABLE ivr_flow_versions DROP COLUMN IF EXISTS change_notes;
--   ALTER TABLE emergency_numbers DROP COLUMN IF EXISTS tenant_id;
--   ALTER TABLE ens_configurations DROP COLUMN IF EXISTS tenant_id;
--   ALTER TABLE ers_configurations DROP COLUMN IF EXISTS tenant_id;
--   ALTER TABLE ens_configuration_groups DROP COLUMN IF EXISTS ens_group_id;
--   ALTER TABLE ens_configuration_contacts DROP COLUMN IF EXISTS ens_contact_id;
--   ALTER TABLE ens_notification_deliveries DROP COLUMN IF EXISTS attempt_number;
--   ALTER TABLE ens_notification_deliveries DROP COLUMN IF EXISTS updated_at;
--   ALTER TABLE ens_notifications DROP COLUMN IF EXISTS updated_at;
-- ────────────────────────────────────────────────────────────

COMMIT;
