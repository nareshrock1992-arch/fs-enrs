-- ============================================================
--  fs_enrs — Emergency Notification & Response System
--  PostgreSQL schema — run once on a fresh database
--  All tables use soft-delete: deleted_at TIMESTAMPTZ
-- ============================================================

-- Enable UUID extension (used for incident UUIDs)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. Tenants ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL      PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  code       VARCHAR(64)  UNIQUE NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- ── 2. Users ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL      PRIMARY KEY,
  tenant_id     INT          REFERENCES tenants(id) ON DELETE SET NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(128) NOT NULL,
  role          VARCHAR(32)  NOT NULL DEFAULT 'OPERATOR'
                  CHECK (role IN ('ADMIN','OPERATOR','VIEWER')),
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  refresh_token_hash VARCHAR(255),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email     ON users (email)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant    ON users (tenant_id) WHERE deleted_at IS NULL;

-- ── 3. Organizations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL      PRIMARY KEY,
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
  id              SERIAL      PRIMARY KEY,
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
  id              SERIAL      PRIMARY KEY,
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

-- ── 7. Emergency Contacts ───────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id              SERIAL      PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id     INT          REFERENCES locations(id)   ON DELETE SET NULL,
  department_id   INT          REFERENCES departments(id) ON DELETE SET NULL,
  first_name      VARCHAR(64)  NOT NULL,
  last_name       VARCHAR(64)  NOT NULL,
  role            VARCHAR(64),
  mobile_number   VARCHAR(32)  NOT NULL,
  extension_number VARCHAR(32),
  email           VARCHAR(255),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contact_org    ON emergency_contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_mobile ON emergency_contacts (mobile_number)   WHERE deleted_at IS NULL;

-- ── 8. Responder Groups ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS responder_groups (
  id              SERIAL      PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── 9. Responder Group Members (many-to-many) ───────────────
CREATE TABLE IF NOT EXISTS responder_group_members (
  id                   SERIAL      PRIMARY KEY,
  responder_group_id   INT          NOT NULL REFERENCES responder_groups(id)    ON DELETE CASCADE,
  emergency_contact_id INT          NOT NULL REFERENCES emergency_contacts(id)  ON DELETE CASCADE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (responder_group_id, emergency_contact_id)
);

-- ── 10. Media Files ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
  id                 SERIAL      PRIMARY KEY,
  organization_id    INT          REFERENCES organizations(id) ON DELETE SET NULL,
  uploaded_by_user_id INT         REFERENCES users(id)         ON DELETE SET NULL,
  type               VARCHAR(32)  NOT NULL DEFAULT 'RECORDING'
                       CHECK (type IN ('RECORDING','PROMPT','MUSIC','OTHER')),
  name               VARCHAR(255) NOT NULL,
  path_or_uri        VARCHAR(512) NOT NULL,
  duration_seconds   INT,
  size_bytes         BIGINT,
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

-- ── 11. Notification Templates ──────────────────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id              SERIAL      PRIMARY KEY,
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

-- ── 12. ENS Configurations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configurations (
  id              SERIAL      PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  pin             VARCHAR(32)  NOT NULL,
  phone_number    VARCHAR(32),
  caller_id       VARCHAR(64),
  retry_count     INT          NOT NULL DEFAULT 3,
  template_id     INT          REFERENCES notification_templates(id) ON DELETE SET NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_pin    ON ens_configurations (pin)       WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_ens_org    ON ens_configurations (organization_id) WHERE deleted_at IS NULL;

-- ── 13. ENS Config → Groups ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_groups (
  id                   SERIAL PRIMARY KEY,
  ens_configuration_id INT NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  responder_group_id   INT NOT NULL REFERENCES responder_groups(id)   ON DELETE CASCADE,
  UNIQUE (ens_configuration_id, responder_group_id)
);

-- ── 14. ENS Config → Individual Contacts ────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_contacts (
  id                   SERIAL PRIMARY KEY,
  ens_configuration_id INT NOT NULL REFERENCES ens_configurations(id)  ON DELETE CASCADE,
  emergency_contact_id INT NOT NULL REFERENCES emergency_contacts(id)  ON DELETE CASCADE,
  UNIQUE (ens_configuration_id, emergency_contact_id)
);

-- ── 15. ENS Notifications (triggered events) ────────────────
CREATE TABLE IF NOT EXISTS ens_notifications (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT          NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  notification_uuid    UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  triggered_by_user_id INT          REFERENCES users(id) ON DELETE SET NULL,
  triggered_via        VARCHAR(16)  NOT NULL DEFAULT 'PHONE'
                         CHECK (triggered_via IN ('PHONE','UI','API')),
  recording_reference  VARCHAR(512),
  status               VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED')),
  total_targets        INT          NOT NULL DEFAULT 0,
  total_success        INT          NOT NULL DEFAULT 0,
  total_failed         INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_notif_cfg    ON ens_notifications (ens_configuration_id);
CREATE INDEX IF NOT EXISTS idx_ens_notif_status ON ens_notifications (status) WHERE deleted_at IS NULL;

-- ── 16. ENS Delivery Status (per contact per notification) ──
CREATE TABLE IF NOT EXISTS ens_notification_deliveries (
  id                   SERIAL      PRIMARY KEY,
  ens_notification_id  INT          NOT NULL REFERENCES ens_notifications(id) ON DELETE CASCADE,
  emergency_contact_id INT          NOT NULL REFERENCES emergency_contacts(id),
  delivery_status      VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                         CHECK (delivery_status IN ('PENDING','SUCCESS','FAILED','RETRIED')),
  attempts             INT          NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  call_uuid            VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_delivery_notif ON ens_notification_deliveries (ens_notification_id);

-- ── 17. ERS Configurations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_configurations (
  id                         SERIAL      PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_ers_pin ON ers_configurations (pin) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_ers_org ON ers_configurations (organization_id) WHERE deleted_at IS NULL;

-- ── 18. ERS Incidents ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_incidents (
  id                   SERIAL      PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  incident_uuid        UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  emergency_call_number VARCHAR(32),
  conference_id        VARCHAR(128),
  status               VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','COMPLETED','QUEUED','FAILED')),
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at             TIMESTAMPTZ,
  queued_at            TIMESTAMPTZ,
  dequeued_at          TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incident_cfg    ON ers_incidents (ers_configuration_id);
CREATE INDEX IF NOT EXISTS idx_incident_status ON ers_incidents (status) WHERE deleted_at IS NULL;

-- ── 19. ERS Incident Responders ─────────────────────────────
CREATE TABLE IF NOT EXISTS ers_incident_responders (
  id                   SERIAL PRIMARY KEY,
  ers_incident_id      INT NOT NULL REFERENCES ers_incidents(id)       ON DELETE CASCADE,
  emergency_contact_id INT NOT NULL REFERENCES emergency_contacts(id),
  join_time            TIMESTAMPTZ,
  leave_time           TIMESTAMPTZ,
  status               VARCHAR(16) NOT NULL DEFAULT 'INVITED'
                         CHECK (status IN ('INVITED','JOINED','MISSED'))
);

-- ── 20. ERS Queue ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_queues (
  id                   SERIAL      PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  incident_id          INT          REFERENCES ers_incidents(id) ON DELETE SET NULL,
  position             INT          NOT NULL DEFAULT 1,
  status               VARCHAR(16)  NOT NULL DEFAULT 'QUEUED'
                         CHECK (status IN ('QUEUED','DEQUEUED','CANCELLED')),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 21. Audit Logs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NOT NULL,
  entity_id   VARCHAR(64),
  details     JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs (user_id)     WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs (created_at DESC);

-- ── 22. System Settings (key/value) ─────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id          SERIAL      PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  value       TEXT,
  value_json  JSONB,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 23. ESL Connections ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS esl_connections (
  id               SERIAL      PRIMARY KEY,
  name             VARCHAR(128) NOT NULL,
  host             VARCHAR(256) NOT NULL,
  port             INT          NOT NULL DEFAULT 8021,
  password         VARCHAR(128) NOT NULL DEFAULT 'ClueCon',
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_heartbeat_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 24. Feature Flags ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id          SERIAL      PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  description TEXT,
  is_enabled  BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── IVR Designer (reserved for future module) ───────────────
CREATE TABLE IF NOT EXISTS ivr_flows (
  id              SERIAL      PRIMARY KEY,
  organization_id INT          REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ivr_flow_versions (
  id          SERIAL      PRIMARY KEY,
  ivr_flow_id INT          NOT NULL REFERENCES ivr_flows(id) ON DELETE CASCADE,
  version     INT          NOT NULL DEFAULT 1,
  flow_json   JSONB        NOT NULL DEFAULT '{}',
  created_by  INT          REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ivr_flow_id, version)
);

CREATE TABLE IF NOT EXISTS ivr_nodes (
  id                  SERIAL PRIMARY KEY,
  ivr_flow_version_id INT    NOT NULL REFERENCES ivr_flow_versions(id) ON DELETE CASCADE,
  node_type           VARCHAR(64) NOT NULL,
  node_key            VARCHAR(64) NOT NULL,
  config_json         JSONB  NOT NULL DEFAULT '{}',
  position_x          FLOAT,
  position_y          FLOAT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Default data ─────────────────────────────────────────────
INSERT INTO feature_flags (key, description, is_enabled) VALUES
  ('ens_enabled',        'Enable ENS (Emergency Notification System)',  true),
  ('ers_enabled',        'Enable ERS (Emergency Response System)',      true),
  ('ivr_designer',       'IVR Designer visual editor (future)',         false),
  ('multi_tenant',       'Multi-tenant mode',                           false),
  ('csv_bulk_upload',    'Bulk upload contacts via CSV',                true),
  ('audit_logging',      'Record all data changes to audit_logs',       true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value, description) VALUES
  ('app_name',            'fs-enrs',     'Application display name'),
  ('app_version',         '1.0.0',       'Current version'),
  ('esl_reconnect_ms',    '3000',        'ESL reconnect delay milliseconds'),
  ('jwt_access_expiry',   '15m',         'JWT access token expiry'),
  ('jwt_refresh_expiry',  '7d',          'JWT refresh token expiry'),
  ('max_login_attempts',  '5',           'Max login attempts before lockout'),
  ('default_retry_count', '3',           'Default ENS retry count')
ON CONFLICT (key) DO NOTHING;
