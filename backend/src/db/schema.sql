-- ============================================================
--  fs_enrs — Emergency Notification & Response System
--  PostgreSQL schema — run once on a fresh database
--  All tables use soft-delete: deleted_at TIMESTAMPTZ
--
--  This file represents the canonical final state after all
--  migrations (001-005). New installations run this file;
--  existing databases run the numbered migrations instead.
--
--  Table creation order respects foreign-key dependencies.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Migration tracking ───────────────────────────────────────
-- NOTE: migrate.js creates this table before running schema.sql,
-- so the IF NOT EXISTS here is a safe no-op on fresh installs.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(256) PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 1. Tenants ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL       PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  code       VARCHAR(64)  UNIQUE NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- ── 2. Users ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 SERIAL       PRIMARY KEY,
  tenant_id          INT          REFERENCES tenants(id) ON DELETE SET NULL,
  email              VARCHAR(255) UNIQUE NOT NULL,
  password_hash      VARCHAR(255) NOT NULL,
  full_name          VARCHAR(128) NOT NULL,
  role               VARCHAR(32)  NOT NULL DEFAULT 'OPERATOR'
                       CHECK (role IN ('ADMIN','SUPERVISOR','OPERATOR','VIEWER')),
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  refresh_token_hash VARCHAR(255),
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id) WHERE deleted_at IS NULL;

-- ── 3. Organizations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL       PRIMARY KEY,
  tenant_id   INT          REFERENCES tenants(id) ON DELETE SET NULL,
  name        VARCHAR(128) NOT NULL,
  code        VARCHAR(64),
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_org_tenant ON organizations (tenant_id) WHERE deleted_at IS NULL;

-- ── 4. Tenant → Organization mapping ───────────────────────
CREATE TABLE IF NOT EXISTS tenant_mappings (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  organization_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization_id)
);

-- ── 5. Locations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  building        VARCHAR(128),
  floor           VARCHAR(64),
  room            VARCHAR(64),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_location_org ON locations (organization_id) WHERE deleted_at IS NULL;

-- ── 6. Departments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id     INT          REFERENCES locations(id) ON DELETE SET NULL,
  name            VARCHAR(128) NOT NULL,
  type            VARCHAR(64),
  notes           TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── 7. Emergency Contacts (public API model) ─────────────────
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id               SERIAL       PRIMARY KEY,
  organization_id  INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id      INT          REFERENCES locations(id)   ON DELETE SET NULL,
  department_id    INT          REFERENCES departments(id) ON DELETE SET NULL,
  first_name       VARCHAR(64)  NOT NULL,
  last_name        VARCHAR(64)  NOT NULL,
  role             VARCHAR(64),
  mobile_number    VARCHAR(32)  NOT NULL,
  extension_number VARCHAR(32),
  email            VARCHAR(255),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contact_org    ON emergency_contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_mobile ON emergency_contacts (mobile_number)   WHERE deleted_at IS NULL;

-- ── 8. Responder Groups (public API model) ───────────────────
CREATE TABLE IF NOT EXISTS responder_groups (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── 9. Responder Group Members ───────────────────────────────
CREATE TABLE IF NOT EXISTS responder_group_members (
  id                   SERIAL      PRIMARY KEY,
  responder_group_id   INT         NOT NULL REFERENCES responder_groups(id)   ON DELETE CASCADE,
  emergency_contact_id INT         NOT NULL REFERENCES emergency_contacts(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (responder_group_id, emergency_contact_id)
);

-- ── 10. Media Files ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
  id                  SERIAL       PRIMARY KEY,
  organization_id     INT          REFERENCES organizations(id) ON DELETE SET NULL,
  uploaded_by_user_id INT          REFERENCES users(id)         ON DELETE SET NULL,
  type                VARCHAR(32)  NOT NULL DEFAULT 'RECORDING'
                        CHECK (type IN ('RECORDING','PROMPT','MUSIC','OTHER')),
  name                VARCHAR(255) NOT NULL,
  path_or_uri         VARCHAR(512) NOT NULL,
  duration_seconds    INT,
  size_bytes          BIGINT,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

-- ── 11. Notification Templates ──────────────────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          REFERENCES organizations(id) ON DELETE SET NULL,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  media_file_id   INT          REFERENCES media_files(id) ON DELETE SET NULL,
  text_body       TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── 12. ENS Contacts (internal Lua/API model) ────────────────
CREATE TABLE IF NOT EXISTS ens_contacts (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_name       VARCHAR(128) NOT NULL,
  mobile_number   VARCHAR(32)  NOT NULL,
  email           VARCHAR(255),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_contact_org    ON ens_contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ens_contact_mobile ON ens_contacts (mobile_number)   WHERE deleted_at IS NULL;

-- ── 13. ENS Groups (internal Lua/API model) ─────────────────
CREATE TABLE IF NOT EXISTS ens_groups (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_group_org ON ens_groups (organization_id) WHERE deleted_at IS NULL;

-- ── 14. ENS Group Members ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_group_members (
  id         SERIAL      PRIMARY KEY,
  group_id   INT         NOT NULL REFERENCES ens_groups(id)   ON DELETE CASCADE,
  contact_id INT         NOT NULL REFERENCES ens_contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, contact_id)
);

-- ── 15. ENS Configurations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configurations (
  id                        SERIAL       PRIMARY KEY,
  tenant_id                 INT          REFERENCES tenants(id) ON DELETE SET NULL,
  organization_id           INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                      VARCHAR(128) NOT NULL,
  pin                       VARCHAR(32)  NOT NULL,
  blast_clid                VARCHAR(32),
  reply_clid                VARCHAR(32),
  phone_number              VARCHAR(32),
  caller_id                 VARCHAR(64),
  retry_count               INT          NOT NULL DEFAULT 3,
  retry_delay_seconds       INT          NOT NULL DEFAULT 30,
  max_concurrent            INT          NOT NULL DEFAULT 5,
  recording_retention_hours INT          NOT NULL DEFAULT 24,
  template_id               INT          REFERENCES notification_templates(id) ON DELETE SET NULL,
  is_active                 BOOLEAN      NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_pin    ON ens_configurations (pin)             WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_ens_org    ON ens_configurations (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ens_tenant ON ens_configurations (tenant_id)       WHERE deleted_at IS NULL;

-- ── 16. ENS Config → Groups ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_groups (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_group_id         INT         REFERENCES ens_groups(id)                  ON DELETE CASCADE,
  responder_group_id   INT         REFERENCES responder_groups(id)            ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ens_configuration_id, ens_group_id)
);

-- ── 17. ENS Config → Individual Contacts ────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_contacts (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_contact_id       INT         REFERENCES ens_contacts(id)                ON DELETE CASCADE,
  emergency_contact_id INT         REFERENCES emergency_contacts(id)          ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ens_configuration_id, ens_contact_id)
);

-- ── 18. ENS Notifications (triggered events) ────────────────
CREATE TABLE IF NOT EXISTS ens_notifications (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  notification_uuid    UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  triggered_via        VARCHAR(16) NOT NULL DEFAULT 'PHONE'
                         CHECK (triggered_via IN ('PHONE','UI','API')),
  caller_number        VARCHAR(32),
  recording_file       VARCHAR(512),
  status               VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED')),
  total_targets        INT         NOT NULL DEFAULT 0,
  total_answered       INT         NOT NULL DEFAULT 0,
  total_no_answer      INT         NOT NULL DEFAULT 0,
  total_replayed       INT         NOT NULL DEFAULT 0,
  callback_count       INT         NOT NULL DEFAULT 0,
  started_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_notif_cfg    ON ens_notifications (ens_configuration_id);
CREATE INDEX IF NOT EXISTS idx_ens_notif_status ON ens_notifications (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ens_notif_uuid   ON ens_notifications (notification_uuid);

-- ── 19. ENS Delivery Status (per contact per notification) ──
CREATE TABLE IF NOT EXISTS ens_notification_deliveries (
  id                  SERIAL       PRIMARY KEY,
  ens_notification_id INT          NOT NULL REFERENCES ens_notifications(id) ON DELETE CASCADE,
  contact_number      VARCHAR(32)  NOT NULL,
  delivery_status     VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                        CHECK (delivery_status IN ('PENDING','ANSWERED','NO_ANSWER','FAILED','CANCELLED','REPLAYED')),
  attempt_number      INT          NOT NULL DEFAULT 1,
  call_uuid           VARCHAR(64),
  hangup_cause        VARCHAR(64),
  answered_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ,
  UNIQUE (ens_notification_id, contact_number)
);
CREATE INDEX IF NOT EXISTS idx_delivery_notif ON ens_notification_deliveries (ens_notification_id);

-- ── 20. ERS Configurations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_configurations (
  id                         SERIAL       PRIMARY KEY,
  tenant_id                  INT          REFERENCES tenants(id) ON DELETE SET NULL,
  organization_id            INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                       VARCHAR(128) NOT NULL,
  pin                        VARCHAR(32),
  primary_group_id           INT          REFERENCES responder_groups(id) ON DELETE SET NULL,
  secondary_group_id         INT          REFERENCES responder_groups(id) ON DELETE SET NULL,
  max_concurrent_conferences INT          NOT NULL DEFAULT 2,
  queue_enabled              BOOLEAN      NOT NULL DEFAULT true,
  is_active                  BOOLEAN      NOT NULL DEFAULT true,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ers_pin    ON ers_configurations (pin)             WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_ers_org    ON ers_configurations (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ers_tenant ON ers_configurations (tenant_id)       WHERE deleted_at IS NULL;

-- ── 21. ERS Incidents ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_incidents (
  id                    SERIAL       PRIMARY KEY,
  ers_configuration_id  INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  tenant_id             INT          REFERENCES tenants(id) ON DELETE SET NULL,
  incident_uuid         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  emergency_call_number VARCHAR(32),
  conference_id         VARCHAR(128),
  caller_number         VARCHAR(32),
  caller_name           VARCHAR(128),
  conference_room       VARCHAR(128),
  group_type            VARCHAR(16)  CHECK (group_type IN ('primary','secondary')),
  recording_path        VARCHAR(512),
  status                VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','COMPLETED','QUEUED','FAILED','CANCELLED')),
  started_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at              TIMESTAMPTZ,
  queued_at             TIMESTAMPTZ,
  dequeued_at           TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incident_cfg    ON ers_incidents (ers_configuration_id);
CREATE INDEX IF NOT EXISTS idx_incident_status ON ers_incidents (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incident_tenant ON ers_incidents (tenant_id) WHERE deleted_at IS NULL;

-- ── 22. ERS Incident Responders ─────────────────────────────
CREATE TABLE IF NOT EXISTS ers_incident_responders (
  id                   SERIAL      PRIMARY KEY,
  ers_incident_id      INT         NOT NULL REFERENCES ers_incidents(id)       ON DELETE CASCADE,
  emergency_contact_id INT         NOT NULL REFERENCES emergency_contacts(id),
  join_time            TIMESTAMPTZ,
  leave_time           TIMESTAMPTZ,
  status               VARCHAR(16) NOT NULL DEFAULT 'INVITED'
                         CHECK (status IN ('INVITED','JOINED','MISSED'))
);

-- ── 23. ERS Queue ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_queues (
  id                   SERIAL      PRIMARY KEY,
  ers_configuration_id INT         NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  incident_id          INT         REFERENCES ers_incidents(id) ON DELETE SET NULL,
  position             INT         NOT NULL DEFAULT 1,
  status               VARCHAR(16) NOT NULL DEFAULT 'QUEUED'
                         CHECK (status IN ('QUEUED','DEQUEUED','CANCELLED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 24. IVR Flows ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ivr_flows (
  id              BIGSERIAL    PRIMARY KEY,
  flow_uuid       UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id       INT          REFERENCES tenants(id) ON DELETE SET NULL,
  organization_id INT          REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  graph           JSONB        NOT NULL DEFAULT '{}',
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_by      INT          REFERENCES users(id) ON DELETE SET NULL,
  updated_by      INT          REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ivr_flow_tenant ON ivr_flows (tenant_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ivr_flow_org    ON ivr_flows (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ivr_flow_uuid   ON ivr_flows (flow_uuid)       WHERE deleted_at IS NULL;

-- ── 25. IVR Flow Versions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ivr_flow_versions (
  id             BIGSERIAL    PRIMARY KEY,
  version_uuid   UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ivr_flow_id    BIGINT       NOT NULL REFERENCES ivr_flows(id) ON DELETE CASCADE,
  version_number INT          NOT NULL DEFAULT 1,
  graph          JSONB        NOT NULL DEFAULT '{}',
  published_by   INT          REFERENCES users(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  change_notes   TEXT,
  UNIQUE (ivr_flow_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_ivr_ver_flow ON ivr_flow_versions (ivr_flow_id);

-- ── 26. Emergency Numbers ───────────────────────────────────
--  Depends on: tenants, organizations, ens_configurations,
--              ers_configurations, ivr_flows (all created above)
CREATE TABLE IF NOT EXISTS emergency_numbers (
  id                   SERIAL       PRIMARY KEY,
  tenant_id            INT          REFERENCES tenants(id)           ON DELETE SET NULL,
  organization_id      INT          REFERENCES organizations(id)     ON DELETE SET NULL,
  number               VARCHAR(32)  NOT NULL UNIQUE,
  type                 VARCHAR(16)  NOT NULL DEFAULT 'ENS'
                         CHECK (type IN ('ENS','ERS','IVR','REJOIN','OPEN_ACCESS')),
  ens_configuration_id INT          REFERENCES ens_configurations(id) ON DELETE SET NULL,
  ers_configuration_id INT          REFERENCES ers_configurations(id) ON DELETE SET NULL,
  ivr_flow_id          BIGINT       REFERENCES ivr_flows(id)          ON DELETE SET NULL,
  description          VARCHAR(255),
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_emnum_tenant ON emergency_numbers (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emnum_number ON emergency_numbers (number)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emnum_type   ON emergency_numbers (type)      WHERE deleted_at IS NULL;

-- ── 27. Audit Logs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NOT NULL,
  entity_id   VARCHAR(64),
  details     JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs (user_id)            WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs (created_at DESC);

-- ── 28. System Settings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id          SERIAL       PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  value       TEXT,
  value_json  JSONB,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 29. ESL Connections ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS esl_connections (
  id                SERIAL       PRIMARY KEY,
  name              VARCHAR(128) NOT NULL,
  host              VARCHAR(256) NOT NULL,
  port              INT          NOT NULL DEFAULT 8021,
  password          VARCHAR(128) NOT NULL DEFAULT 'ClueCon',
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  last_heartbeat_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 30. Feature Flags ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id          SERIAL       PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  description TEXT,
  is_enabled  BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Default data ─────────────────────────────────────────────
INSERT INTO feature_flags (key, description, is_enabled) VALUES
  ('ens_enabled',    'Enable ENS (Emergency Notification System)', true),
  ('ers_enabled',    'Enable ERS (Emergency Response System)',     true),
  ('ivr_designer',   'IVR Designer visual editor',                 true),
  ('multi_tenant',   'Multi-tenant mode',                          false),
  ('csv_bulk_upload','Bulk upload contacts via CSV',               true),
  ('audit_logging',  'Record all data changes to audit_logs',      true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value, description) VALUES
  ('app_name',            'fs-enrs', 'Application display name'),
  ('app_version',         '1.0.0',   'Current version'),
  ('esl_reconnect_ms',    '3000',    'ESL reconnect delay milliseconds'),
  ('jwt_access_expiry',   '15m',     'JWT access token expiry'),
  ('jwt_refresh_expiry',  '7d',      'JWT refresh token expiry'),
  ('max_login_attempts',  '5',       'Max login attempts before lockout'),
  ('default_retry_count', '3',       'Default ENS retry count')
ON CONFLICT (key) DO NOTHING;

-- Tracking is handled by migrate.js — no INSERT needed here.
