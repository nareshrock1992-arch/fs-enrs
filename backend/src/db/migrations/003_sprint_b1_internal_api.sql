-- ============================================================
--  Migration 003 — Sprint B1: Internal API prerequisites
--  Run with: psql -d fs_enrs -f 003_sprint_b1_internal_api.sql
--  Idempotent: all statements use IF NOT EXISTS
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- B1-1: ens_configuration_contacts junction table
-- Links ENS configurations directly to individual ens_contacts
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_contacts (
  id                   SERIAL PRIMARY KEY,
  ens_configuration_id INT NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_contact_id       INT NOT NULL REFERENCES ens_contacts(id)        ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ens_configuration_id, ens_contact_id)
);
CREATE INDEX IF NOT EXISTS idx_ens_cfg_contacts_cfg
  ON ens_configuration_contacts (ens_configuration_id);

-- ────────────────────────────────────────────────────────────
-- B1-2: ens_configuration_groups junction table
-- Links ENS configurations to ens_groups
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_groups (
  id                   SERIAL PRIMARY KEY,
  ens_configuration_id INT NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_group_id         INT NOT NULL REFERENCES ens_groups(id)          ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ens_configuration_id, ens_group_id)
);
CREATE INDEX IF NOT EXISTS idx_ens_cfg_groups_cfg
  ON ens_configuration_groups (ens_configuration_id);

-- ────────────────────────────────────────────────────────────
-- B1-3: ers_incident_responders — add mobile_number column
-- Needed for Lua lookup which only knows the phone number,
-- not the ers_responder_id at call time.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ers_incident_responders
  ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_ers_responders_mobile_incident
  ON ers_incident_responders (ers_incident_id, mobile_number)
  WHERE mobile_number IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- B1-4: ens_notification_deliveries — unique constraint
-- Required for the ON CONFLICT upsert in delivery update handler
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- B1-5: ers_incident_responders — unique constraint for upsert
-- ────────────────────────────────────────────────────────────
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
-- B1-6: Indexes for frequent internal API queries
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

-- ────────────────────────────────────────────────────────────
-- Rollback (run manually if needed):
-- DROP TABLE IF EXISTS ens_configuration_contacts;
-- DROP TABLE IF EXISTS ens_configuration_groups;
-- ALTER TABLE ers_incident_responders DROP COLUMN IF EXISTS mobile_number;
-- ALTER TABLE ens_notification_deliveries DROP CONSTRAINT IF EXISTS ...;
-- ────────────────────────────────────────────────────────────

COMMIT;
