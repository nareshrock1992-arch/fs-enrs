-- ============================================================
--  Migration 002 — Phase 6 Bug Fixes
--  Run with: psql -d fs_enrs -f 002_phase6_bugfixes.sql
--  Idempotent: all statements use IF NOT EXISTS / IF EXISTS
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- B1: users.role CHECK constraint missing SUPERVISOR
-- Root cause: SUPERVISOR was not in the original role set.
-- Fix: drop old CHECK, add new one that includes all 4 roles.
-- ────────────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN','SUPERVISOR','OPERATOR','VIEWER'));

-- ────────────────────────────────────────────────────────────
-- B2: organizations missing contact columns
-- Root cause: schema omitted address/phone/email.
-- ────────────────────────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS address VARCHAR(256),
  ADD COLUMN IF NOT EXISTS phone   VARCHAR(32),
  ADD COLUMN IF NOT EXISTS email   VARCHAR(255);

-- ────────────────────────────────────────────────────────────
-- B3: locations missing address column
-- Root cause: only building/floor/room were captured.
-- ────────────────────────────────────────────────────────────
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS address VARCHAR(256);

-- ────────────────────────────────────────────────────────────
-- B4: users table missing lockout and password-policy columns
-- Root cause: account lockout not designed in original schema.
-- ────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count   INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS password_history (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pw_history_user
  ON password_history (user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- B5: ens_configurations.pin is NOT NULL — must be nullable
-- Root cause: CLID-based design makes PIN optional.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ens_configurations
  ALTER COLUMN pin DROP NOT NULL;

-- ────────────────────────────────────────────────────────────
-- B6: ens_configurations missing CLID + retention columns
-- Root cause: original schema used caller_id (single field);
--   new design needs blast_clid, reply_clid, destination_number.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS destination_number       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS blast_clid               VARCHAR(32),
  ADD COLUMN IF NOT EXISTS reply_clid               VARCHAR(32),
  ADD COLUMN IF NOT EXISTS retry_delay_seconds      INT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS recording_retention_hours INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS max_concurrent            INT NOT NULL DEFAULT 50;

-- Partial index on destination_number for Lua lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_ens_dest_number
  ON ens_configurations (destination_number)
  WHERE deleted_at IS NULL AND is_active = true AND destination_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ens_reply_clid
  ON ens_configurations (reply_clid)
  WHERE deleted_at IS NULL AND is_active = true AND reply_clid IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- B7: ers_configurations missing CLID + rejoin columns
-- Root cause: original schema had no emergency_number mapping.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS emergency_number         VARCHAR(32),
  ADD COLUMN IF NOT EXISTS rejoin_number            VARCHAR(32),
  ADD COLUMN IF NOT EXISTS open_access_number       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS conference_room_prefix   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS record_conferences       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS recording_retention_hours INT NOT NULL DEFAULT 48;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ers_emergency_number
  ON ers_configurations (emergency_number)
  WHERE deleted_at IS NULL AND is_active = true AND emergency_number IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- B8: ers_incidents missing caller and conference columns
-- Root cause: only stored emergency_call_number and conference_id;
--   Lua needs caller_name, conference_room, group_type, recording_path.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ers_incidents
  ADD COLUMN IF NOT EXISTS caller_number    VARCHAR(32),
  ADD COLUMN IF NOT EXISTS caller_name      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS conference_room  VARCHAR(128),
  ADD COLUMN IF NOT EXISTS group_type       VARCHAR(16)
    CHECK (group_type IN ('primary','secondary')),
  ADD COLUMN IF NOT EXISTS recording_path   VARCHAR(512),
  ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;

-- Backfill: map old column to new (idempotent)
UPDATE ers_incidents
  SET caller_number   = emergency_call_number,
      conference_room = conference_id
  WHERE caller_number  IS NULL
    AND conference_room IS NULL;

-- Add CANCELLED to status CHECK
ALTER TABLE ers_incidents DROP CONSTRAINT IF EXISTS ers_incidents_status_check;
ALTER TABLE ers_incidents
  ADD CONSTRAINT ers_incidents_status_check
  CHECK (status IN ('ACTIVE','COMPLETED','QUEUED','FAILED','CANCELLED'));

-- ────────────────────────────────────────────────────────────
-- B9: ers_incident_responders missing REJOINED / OBSERVER status
-- Root cause: original design only tracked initial dispatch.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ers_incident_responders
  DROP CONSTRAINT IF EXISTS ers_incident_responders_status_check;
ALTER TABLE ers_incident_responders
  ADD CONSTRAINT ers_incident_responders_status_check
  CHECK (status IN ('INVITED','JOINED','MISSED','REJOINED','OBSERVER'));

ALTER TABLE ers_incident_responders
  ADD COLUMN IF NOT EXISTS rejoin_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_uuid     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS leave_time    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS joined_via    VARCHAR(32);  -- "direct" | "rejoin" | "open_access"

-- ────────────────────────────────────────────────────────────
-- B10: ers_queues missing caller_number and queued_reason
-- Root cause: queue designed without preserving caller context.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ers_queues
  ADD COLUMN IF NOT EXISTS caller_number  VARCHAR(32),
  ADD COLUMN IF NOT EXISTS queued_reason  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS dequeued_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;

-- incident_id should be NOT NULL (a queue entry always has an incident)
-- and UNIQUE (one queue slot per incident)
ALTER TABLE ers_queues
  ALTER COLUMN incident_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ers_queue_incident
  ON ers_queues (incident_id);

-- ────────────────────────────────────────────────────────────
-- B11: ens_notification_deliveries status values incomplete
-- Root cause: only PENDING/SUCCESS/FAILED/RETRIED — missing
--   ANSWERED, NO_ANSWER, REPLAYED, CANCELLED, DIALLING.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ens_notification_deliveries
  DROP CONSTRAINT IF EXISTS ens_notification_deliveries_delivery_status_check;
ALTER TABLE ens_notification_deliveries
  ADD CONSTRAINT ens_notification_deliveries_delivery_status_check
  CHECK (delivery_status IN
    ('PENDING','DIALLING','ANSWERED','NO_ANSWER','FAILED','REPLAYED','CANCELLED'));

ALTER TABLE ens_notification_deliveries
  ADD COLUMN IF NOT EXISTS answered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hangup_cause   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS contact_number VARCHAR(32);  -- denormalized for fast Lua update

-- ────────────────────────────────────────────────────────────
-- B12: ens_notifications missing started_at, CANCELLED status
-- Root cause: limited status set, no started_at timestamp.
-- ────────────────────────────────────────────────────────────
ALTER TABLE ens_notifications
  DROP CONSTRAINT IF EXISTS ens_notifications_status_check;
ALTER TABLE ens_notifications
  ADD CONSTRAINT ens_notifications_status_check
  CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED'));

ALTER TABLE ens_notifications
  ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_answered  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_no_answer INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_replayed  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS caller_number   VARCHAR(32),
  ADD COLUMN IF NOT EXISTS recording_file  VARCHAR(512);

-- ────────────────────────────────────────────────────────────
-- B13: audit_logs missing http_method, http_path, user_agent
-- Root cause: original design only captured action + details JSONB.
-- ────────────────────────────────────────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS http_method VARCHAR(8),
  ADD COLUMN IF NOT EXISTS http_path   VARCHAR(512),
  ADD COLUMN IF NOT EXISTS user_agent  VARCHAR(512);

-- ────────────────────────────────────────────────────────────
-- B14: Emergency numbers as first-class entity
-- Root cause: was stored inside ERS config as a plain varchar.
--   Needed: independent table so numbers can be managed in UI.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_numbers (
  id                   SERIAL      PRIMARY KEY,
  organization_id      INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number               VARCHAR(32) NOT NULL,
  description          VARCHAR(256),
  type                 VARCHAR(16) NOT NULL DEFAULT 'ERS'
                         CHECK (type IN ('ERS','ENS','REJOIN','OPEN_ACCESS')),
  ers_configuration_id INT         REFERENCES ers_configurations(id) ON DELETE SET NULL,
  ens_configuration_id INT         REFERENCES ens_configurations(id) ON DELETE SET NULL,
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emerg_number_active
  ON emergency_numbers (number)
  WHERE deleted_at IS NULL AND is_active = true;

-- ────────────────────────────────────────────────────────────
-- B15: ERS responders separate from ENS contacts
--   (Addressed in Phase 4 design — tables already designed.
--    This migration adds the new tables that replace the old
--    unified emergency_contacts for the responder use case.)
-- ────────────────────────────────────────────────────────────

-- ens_contacts (replaces emergency_contacts for ENS side)
CREATE TABLE IF NOT EXISTS ens_contacts (
  id               SERIAL      PRIMARY KEY,
  organization_id  INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id      INT         REFERENCES locations(id)   ON DELETE SET NULL,
  department_id    INT         REFERENCES departments(id) ON DELETE SET NULL,
  first_name       VARCHAR(64) NOT NULL,
  last_name        VARCHAR(64) NOT NULL,
  title            VARCHAR(64),
  mobile_number    VARCHAR(32) NOT NULL,
  extension_number VARCHAR(32),
  email            VARCHAR(255),
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_contact_org    ON ens_contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ens_contact_mobile ON ens_contacts (mobile_number)   WHERE deleted_at IS NULL;

-- ens_groups (replaces responder_groups for ENS side)
CREATE TABLE IF NOT EXISTS ens_groups (
  id              SERIAL      PRIMARY KEY,
  organization_id INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ens_group_members (
  id          SERIAL PRIMARY KEY,
  group_id    INT    NOT NULL REFERENCES ens_groups(id)   ON DELETE CASCADE,
  contact_id  INT    NOT NULL REFERENCES ens_contacts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, contact_id)
);

-- ers_responders (separate from ENS contacts)
CREATE TABLE IF NOT EXISTS ers_responders (
  id               SERIAL      PRIMARY KEY,
  organization_id  INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id      INT         REFERENCES locations(id)   ON DELETE SET NULL,
  department_id    INT         REFERENCES departments(id) ON DELETE SET NULL,
  user_id          INT         REFERENCES users(id) ON DELETE SET NULL,
  first_name       VARCHAR(64) NOT NULL,
  last_name        VARCHAR(64) NOT NULL,
  title            VARCHAR(64),
  mobile_number    VARCHAR(32) NOT NULL,
  extension_number VARCHAR(32),
  email            VARCHAR(255),
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ers_responder_user
  ON ers_responders (user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ers_responder_org    ON ers_responders (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ers_responder_mobile ON ers_responders (mobile_number)   WHERE deleted_at IS NULL;

-- ers_responder_groups
CREATE TABLE IF NOT EXISTS ers_responder_groups (
  id              SERIAL      PRIMARY KEY,
  organization_id INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ers_responder_group_members (
  id            SERIAL PRIMARY KEY,
  group_id      INT    NOT NULL REFERENCES ers_responder_groups(id) ON DELETE CASCADE,
  responder_id  INT    NOT NULL REFERENCES ers_responders(id)       ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, responder_id)
);

-- Update ers_configurations to reference new responder groups
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS primary_ers_group_id   INT REFERENCES ers_responder_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS secondary_ers_group_id INT REFERENCES ers_responder_groups(id) ON DELETE SET NULL;

-- Update ers_incident_responders to reference ers_responders
ALTER TABLE ers_incident_responders
  ADD COLUMN IF NOT EXISTS ers_responder_id INT REFERENCES ers_responders(id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────
-- Data backfill helpers (run manually after data migration)
-- These are commented out — run only when ready to migrate data
-- from emergency_contacts → ens_contacts + ers_responders
-- ────────────────────────────────────────────────────────────

-- INSERT INTO ens_contacts (organization_id, location_id, department_id,
--   first_name, last_name, mobile_number, extension_number, email, is_active,
--   created_at, updated_at)
-- SELECT organization_id, location_id, department_id,
--   first_name, last_name, mobile_number, extension_number, email, is_active,
--   created_at, updated_at
-- FROM emergency_contacts WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- B16: departments missing extension column
-- Root cause: UI form has an extension field but the table didn't.
-- ────────────────────────────────────────────────────────────
ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS extension VARCHAR(32);

COMMIT;
