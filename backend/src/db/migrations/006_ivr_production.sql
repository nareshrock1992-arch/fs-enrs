-- ============================================================
--  Migration 006 — IVR Production Readiness
--
--  Fixes remaining schema gaps discovered during Sprint 6
--  end-to-end testing on existing databases.
--
--  All statements are fully idempotent.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- P1: ers_incidents — add tenant_id
--
--  dashboardController.js queries:
--    WHERE i.status = 'ACTIVE' AND i.deleted_at IS NULL AND i.tenant_id = $1
--  Column was never added to this table.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ers_incidents
  ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL;

-- Backfill tenant_id from the parent ers_configuration
UPDATE ers_incidents ei
   SET tenant_id = ec.tenant_id
  FROM ers_configurations ec
 WHERE ec.id = ei.ers_configuration_id
   AND ei.tenant_id IS NULL
   AND ec.tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_incident_tenant
  ON ers_incidents (tenant_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- P2: ers_incidents — align status CHECK and add missing columns
--
--  Migration 002 B8 added these columns and extended the CHECK
--  but only for databases that had previously run 002.
--  Safe no-ops on databases that already have them.
-- ────────────────────────────────────────────────────────────

ALTER TABLE ers_incidents
  ADD COLUMN IF NOT EXISTS caller_number  VARCHAR(32),
  ADD COLUMN IF NOT EXISTS caller_name    VARCHAR(128),
  ADD COLUMN IF NOT EXISTS conference_room VARCHAR(128),
  ADD COLUMN IF NOT EXISTS group_type     VARCHAR(16),
  ADD COLUMN IF NOT EXISTS recording_path VARCHAR(512),
  ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;

-- Extend status CHECK to include CANCELLED (matches migration 002 B8)
ALTER TABLE ers_incidents
  DROP CONSTRAINT IF EXISTS ers_incidents_status_check;
ALTER TABLE ers_incidents
  ADD CONSTRAINT ers_incidents_status_check
  CHECK (status IN ('ACTIVE','COMPLETED','QUEUED','FAILED','CANCELLED'));

-- Add group_type CHECK if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ers_incidents_group_type_check'
  ) THEN
    ALTER TABLE ers_incidents
      ADD CONSTRAINT ers_incidents_group_type_check
      CHECK (group_type IN ('primary','secondary'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- P3: emergency_numbers — add IVR to type CHECK
--
--  Migration 002 (B14) created emergency_numbers with:
--    CHECK (type IN ('ERS','ENS','REJOIN','OPEN_ACCESS'))
--  schema.sql (fresh installs) has:
--    CHECK (type IN ('ENS','ERS','IVR'))
--  Existing databases are missing 'IVR'; fresh installs are
--  missing 'REJOIN' and 'OPEN_ACCESS'.
--  This migration unifies both to all 5 values.
-- ────────────────────────────────────────────────────────────

ALTER TABLE emergency_numbers
  DROP CONSTRAINT IF EXISTS emergency_numbers_type_check;
ALTER TABLE emergency_numbers
  ADD CONSTRAINT emergency_numbers_type_check
  CHECK (type IN ('ENS','ERS','IVR','REJOIN','OPEN_ACCESS'));

-- ────────────────────────────────────────────────────────────
-- P4: users — add SUPERVISOR to role CHECK
--
--  Migration 002 B1 already does this on databases that ran 002.
--  Fresh installs (schema.sql) now include SUPERVISOR too (fixed).
--  This guard handles any edge case where 002 ran but didn't
--  persist the updated CHECK (e.g. manual restore from old dump).
-- ────────────────────────────────────────────────────────────

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN','SUPERVISOR','OPERATOR','VIEWER'));

-- ────────────────────────────────────────────────────────────
-- P5: ivr_flows — ensure flow_uuid NOT NULL
--
--  Migration 004 adds flow_uuid with NOT NULL DEFAULT on new rows,
--  but existing rows need backfill before the NOT NULL can be set.
-- ────────────────────────────────────────────────────────────

UPDATE ivr_flows SET flow_uuid = gen_random_uuid() WHERE flow_uuid IS NULL;

DO $$
BEGIN
  ALTER TABLE ivr_flows ALTER COLUMN flow_uuid SET NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ────────────────────────────────────────────────────────────
-- P6: ivr_flows — ensure graph NOT NULL
--
--  Rows inserted by old code before migration 004 may have graph IS NULL.
-- ────────────────────────────────────────────────────────────

UPDATE ivr_flows SET graph = '{"entry_node_id":"","nodes":{}}'::jsonb WHERE graph IS NULL;

DO $$
BEGIN
  ALTER TABLE ivr_flows ALTER COLUMN graph SET NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ────────────────────────────────────────────────────────────
-- P7: ivr_flow_versions — ensure graph and version_number NOT NULL
-- ────────────────────────────────────────────────────────────

UPDATE ivr_flow_versions SET graph          = '{}'::jsonb WHERE graph          IS NULL;
UPDATE ivr_flow_versions SET version_number = id          WHERE version_number IS NULL;

DO $$
BEGIN
  ALTER TABLE ivr_flow_versions ALTER COLUMN graph          SET NOT NULL;
  ALTER TABLE ivr_flow_versions ALTER COLUMN version_number SET NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ────────────────────────────────────────────────────────────
-- P8: Record this migration in schema_migrations
-- ────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES ('006_ivr_production.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
