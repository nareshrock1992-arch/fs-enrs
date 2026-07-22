-- =============================================================================
-- Migration 001 — Initial Schema
-- =============================================================================
--
-- Creates all base tables for the fs-enrs Emergency Notification &
-- Response System.  This file is the numbered-migration counterpart of
-- backend/src/db/schema.sql.
--
-- When to run:
--   • Automated path  : use `node src/db/migrate.js` — it detects a fresh
--     database and applies schema.sql automatically; this file is then
--     recorded as already applied so it is never re-run.
--   • Manual psql path: run this file FIRST, then run 006 → 011 in order.
--     (Migrations 002–005 are baked into this base schema.)
--
-- Idempotent: all statements use CREATE TABLE IF NOT EXISTS / IF NOT EXISTS.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Migration tracking ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(256) PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 1. Tenants ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL       PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  slug       VARCHAR(64)  UNIQUE,
  code       VARCHAR(64)  UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- ── 2. Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL       PRIMARY KEY,
  tenant_id            INT          REFERENCES tenants(id) ON DELETE SET NULL,
  email                VARCHAR(255) UNIQUE NOT NULL,
  password_hash        VARCHAR(255) NOT NULL,
  full_name            VARCHAR(128) NOT NULL,
  role                 VARCHAR(32)  NOT NULL DEFAULT 'OPERATOR'
                         CHECK (role IN ('ADMIN','SUPERVISOR','OPERATOR','VIEWER')),
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  refresh_token_hash   VARCHAR(255),
  last_login_at        TIMESTAMPTZ,
  failed_login_count   INT          NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  must_change_password BOOLEAN      NOT NULL DEFAULT false,
  password_changed_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS password_history (
  id         BIGSERIAL    PRIMARY KEY,
  user_id    INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pw_history_user ON password_history (user_id, created_at DESC);

-- ── 3. Organizations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL       PRIMARY KEY,
  tenant_id   INT          REFERENCES tenants(id) ON DELETE SET NULL,
  name        VARCHAR(128) NOT NULL,
  slug        VARCHAR(64)  UNIQUE,
  code        VARCHAR(64),
  description TEXT,
  address     VARCHAR(256),
  phone       VARCHAR(32),
  email       VARCHAR(255),
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_org_tenant ON organizations (tenant_id) WHERE deleted_at IS NULL;

-- ── 4. Tenant → Organization mapping ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_mappings (
  id              SERIAL      PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  organization_id INT         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization_id)
);

-- ── 5. Locations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  building        VARCHAR(128),
  floor           VARCHAR(64),
  room            VARCHAR(64),
  address         VARCHAR(256),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_location_org ON locations (organization_id) WHERE deleted_at IS NULL;

-- ── 6. Departments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id              SERIAL       PRIMARY KEY,
  organization_id INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id     INT          REFERENCES locations(id) ON DELETE SET NULL,
  name            VARCHAR(128) NOT NULL,
  type            VARCHAR(64),
  extension       VARCHAR(32),
  notes           TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ── 7. Emergency Contacts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id                 SERIAL       PRIMARY KEY,
  organization_id    INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id        INT          REFERENCES locations(id)   ON DELETE SET NULL,
  department_id      INT          REFERENCES departments(id) ON DELETE SET NULL,
  first_name         VARCHAR(64)  NOT NULL,
  last_name          VARCHAR(64)  NOT NULL,
  role               VARCHAR(64),
  mobile_number      VARCHAR(32)  NOT NULL,
  internal_extension VARCHAR(32),
  extension_number   VARCHAR(32),
  email              VARCHAR(255),
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contact_org    ON emergency_contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_mobile ON emergency_contacts (mobile_number)   WHERE deleted_at IS NULL;

-- ── 8. Responder Groups ───────────────────────────────────────────────────────
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

-- ── 9. Responder Group Members ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS responder_group_members (
  id                   SERIAL      PRIMARY KEY,
  responder_group_id   INT         NOT NULL REFERENCES responder_groups(id)   ON DELETE CASCADE,
  emergency_contact_id INT         NOT NULL REFERENCES emergency_contacts(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (responder_group_id, emergency_contact_id)
);

-- ── 10. Media Files ───────────────────────────────────────────────────────────
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

-- ── 11. Notification Templates ────────────────────────────────────────────────
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

-- ── 12. ENS Configurations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configurations (
  id                        SERIAL       PRIMARY KEY,
  tenant_id                 INT          REFERENCES tenants(id)       ON DELETE SET NULL,
  organization_id           INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                      VARCHAR(128) NOT NULL,
  description               TEXT,
  pin                       VARCHAR(32),
  blast_clid                VARCHAR(32),
  reply_clid                VARCHAR(32),
  sip_gateway               VARCHAR(128),
  sip_caller_id             VARCHAR(64),
  destination_number        VARCHAR(32),
  phone_number              VARCHAR(32),
  caller_id                 VARCHAR(64),
  max_concurrent            INT          NOT NULL DEFAULT 30,
  max_concurrent_calls      INT          NOT NULL DEFAULT 30,
  calls_per_second          NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  batch_size                INT          NOT NULL DEFAULT 30,
  retry_count               INT          NOT NULL DEFAULT 3,
  retry_delay_seconds       INT          NOT NULL DEFAULT 60,
  retry_interval_sec        INT          NOT NULL DEFAULT 60,
  max_attempts              INT          NOT NULL DEFAULT 3,
  campaign_timeout_min      INT          NOT NULL DEFAULT 60,
  recording_retention_hours INT          NOT NULL DEFAULT 24,
  retry_failed_only         BOOLEAN      NOT NULL DEFAULT false,
  adaptive_throttling       BOOLEAN      NOT NULL DEFAULT true,
  campaign_priority         INT          NOT NULL DEFAULT 5,
  max_active_campaigns      INT          NOT NULL DEFAULT 1,
  no_pending_msg            TEXT,
  expiry_announcement       TEXT,
  playback_number           VARCHAR(32),
  template_id               INT          REFERENCES notification_templates(id) ON DELETE SET NULL,
  is_active                 BOOLEAN      NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ens_org    ON ens_configurations (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ens_tenant ON ens_configurations (tenant_id)       WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ens_dest_number ON ens_configurations (destination_number)
  WHERE deleted_at IS NULL AND is_active = true AND destination_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ens_reply_clid  ON ens_configurations (reply_clid)
  WHERE deleted_at IS NULL AND is_active = true AND reply_clid IS NOT NULL;

-- ── 13. ENS Config → Groups ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_groups (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_group_id         INT         REFERENCES ens_groups(id)        ON DELETE CASCADE,
  responder_group_id   INT         REFERENCES responder_groups(id)  ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ens_cfg_groups_rg
  ON ens_configuration_groups (ens_configuration_id, responder_group_id)
  WHERE responder_group_id IS NOT NULL;

-- ── 14. ENS Config → Individual Contacts ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_configuration_contacts (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  ens_contact_id       INT         REFERENCES ens_contacts(id)         ON DELETE CASCADE,
  emergency_contact_id INT         REFERENCES emergency_contacts(id)   ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ens_cfg_contacts_ec
  ON ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
  WHERE emergency_contact_id IS NOT NULL;

-- ── 15. ENS Notifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_notifications (
  id                   SERIAL      PRIMARY KEY,
  ens_configuration_id INT         NOT NULL REFERENCES ens_configurations(id) ON DELETE CASCADE,
  notification_uuid    UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  triggered_via        VARCHAR(16) NOT NULL DEFAULT 'PHONE'
                         CHECK (triggered_via IN ('PHONE','UI','API')),
  triggered_by_user_id INT         REFERENCES users(id) ON DELETE SET NULL,
  caller_number        VARCHAR(32),
  recording_file       VARCHAR(512),
  recording_reference  VARCHAR(512),
  status               VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')),
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

-- ── 16. ENS Delivery Status ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ens_notification_deliveries (
  id                  SERIAL       PRIMARY KEY,
  ens_notification_id INT          NOT NULL REFERENCES ens_notifications(id) ON DELETE CASCADE,
  contact_number      VARCHAR(32)  NOT NULL,
  delivery_status     VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                        CHECK (delivery_status IN
                          ('PENDING','DIALLING','ANSWERED','NO_ANSWER','FAILED','REPLAYED','CANCELLED')),
  attempt_number      INT          NOT NULL DEFAULT 1,
  call_uuid           VARCHAR(64),
  hangup_cause        VARCHAR(64),
  answered_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ,
  UNIQUE (ens_notification_id, contact_number)
);
CREATE INDEX IF NOT EXISTS idx_delivery_notif ON ens_notification_deliveries (ens_notification_id);

-- ── 17. ENS Campaigns ────────────────────────────────────────────────────────
-- Definition must match migration 008 exactly (UUID PK) so that the manual
-- psql path and the automated migrate.js path produce the same schema.
CREATE TABLE IF NOT EXISTS ens_campaigns (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  ens_configuration_id INT          NOT NULL REFERENCES ens_configurations(id),
  organization_id     INT          REFERENCES organizations(id) ON DELETE SET NULL,
  triggered_by        INT          REFERENCES users(id) ON DELETE SET NULL,
  triggered_via       VARCHAR(20)  NOT NULL DEFAULT 'PHONE'
                        CHECK (triggered_via IN ('PHONE','UI','API','SCHEDULE')),
  trigger_number      VARCHAR(30),

  status              VARCHAR(20)  NOT NULL DEFAULT 'queued'
                        CHECK (status IN
                          ('queued','running','paused','completed','cancelled','failed')),

  recording_file      TEXT,
  message_audio_url   TEXT,
  message_text        TEXT,

  max_concurrent      INT          NOT NULL DEFAULT 30,
  calls_per_second    NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  retry_count         INT          NOT NULL DEFAULT 3,
  retry_interval_sec  INT          NOT NULL DEFAULT 300,
  max_attempts        INT          NOT NULL DEFAULT 4,
  retry_failed_only   BOOLEAN      NOT NULL DEFAULT true,
  adaptive_throttling BOOLEAN      NOT NULL DEFAULT true,
  campaign_priority   INT          NOT NULL DEFAULT 5,
  campaign_timeout_min INT         NOT NULL DEFAULT 60,
  sip_gateway         VARCHAR(100),
  sip_caller_id       VARCHAR(50),

  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  paused_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,

  total_destinations  INT          NOT NULL DEFAULT 0,
  queued_count        INT          NOT NULL DEFAULT 0,
  dialing_count       INT          NOT NULL DEFAULT 0,
  answered_count      INT          NOT NULL DEFAULT 0,
  busy_count          INT          NOT NULL DEFAULT 0,
  no_answer_count     INT          NOT NULL DEFAULT 0,
  failed_count        INT          NOT NULL DEFAULT 0,
  retried_count       INT          NOT NULL DEFAULT 0,
  completed_count     INT          NOT NULL DEFAULT 0,
  expired_count       INT          NOT NULL DEFAULT 0,
  skipped_count       INT          NOT NULL DEFAULT 0,
  peak_concurrent     INT          NOT NULL DEFAULT 0,
  campaign_duration_sec INT,
  avg_answer_time_ms  INT,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ens_campaigns_status
  ON ens_campaigns (status, campaign_priority DESC, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_ens_campaigns_config
  ON ens_campaigns (ens_configuration_id, created_at DESC);

-- ── 18. ENS Campaign Destinations ───────────────────────────────────────────
-- Replaces the old ens_campaign_deliveries table; matches migration 008.
CREATE TABLE IF NOT EXISTS ens_campaign_destinations (
  id              BIGSERIAL    PRIMARY KEY,
  campaign_id     UUID         NOT NULL REFERENCES ens_campaigns(id) ON DELETE CASCADE,
  contact_id      INT          REFERENCES emergency_contacts(id) ON DELETE SET NULL,
  phone_number    VARCHAR(50)  NOT NULL,
  contact_name    VARCHAR(200),

  status          VARCHAR(20)  NOT NULL DEFAULT 'queued'
                    CHECK (status IN
                      ('queued','dialing','answered','busy','no_answer',
                       'failed','completed','expired','skipped')),
  attempt_count   INT          NOT NULL DEFAULT 0,
  max_attempts    INT          NOT NULL DEFAULT 4,

  queued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  answered_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  call_uuid       VARCHAR(100),
  answer_time_ms  INT,
  call_duration_sec INT,
  hangup_cause    VARCHAR(50),
  error_message   TEXT,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_camp_dest_campaign_status
  ON ens_campaign_destinations (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_camp_dest_next_attempt
  ON ens_campaign_destinations (campaign_id, next_attempt_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_camp_dest_call_uuid
  ON ens_campaign_destinations (call_uuid)
  WHERE call_uuid IS NOT NULL;

-- ── 19. ERS Configurations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_configurations (
  id                         SERIAL       PRIMARY KEY,
  tenant_id                  INT          REFERENCES tenants(id)       ON DELETE SET NULL,
  organization_id            INT          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                       VARCHAR(128) NOT NULL,
  description                TEXT,
  pin                        VARCHAR(32),
  primary_bridge_number      VARCHAR(32),
  secondary_bridge_number    VARCHAR(32),
  conference_profile         VARCHAR(64)  NOT NULL DEFAULT 'default',
  primary_group_id           INT          REFERENCES responder_groups(id) ON DELETE SET NULL,
  secondary_group_id         INT          REFERENCES responder_groups(id) ON DELETE SET NULL,
  max_concurrent_conferences INT          NOT NULL DEFAULT 2,
  max_conference_duration_min INT         NOT NULL DEFAULT 0,
  queue_enabled              BOOLEAN      NOT NULL DEFAULT true,
  queue_announcement_audio   VARCHAR(512),
  queue_music_path           VARCHAR(512),
  queue_hold_audio           VARCHAR(512),
  queue_timeout_sec          INT          NOT NULL DEFAULT 0,
  queue_priority             INT          NOT NULL DEFAULT 5,
  record_conferences         BOOLEAN      NOT NULL DEFAULT false,
  recording_directory        VARCHAR(512),
  recording_retention_hours  INT          NOT NULL DEFAULT 48,
  retry_ring_count           INT          NOT NULL DEFAULT 3,
  retry_ring_interval        INT          NOT NULL DEFAULT 30,
  allow_rejoin               BOOLEAN      NOT NULL DEFAULT true,
  cli_authentication         BOOLEAN      NOT NULL DEFAULT false,
  primary_retry_count        INT          NOT NULL DEFAULT 3,
  primary_retry_interval_sec INT          NOT NULL DEFAULT 30,
  secondary_retry_count      INT          NOT NULL DEFAULT 3,
  secondary_retry_interval_sec INT        NOT NULL DEFAULT 30,
  emergency_number           VARCHAR(32),
  rejoin_number              VARCHAR(32),
  open_access_number         VARCHAR(32),
  conference_room_prefix     VARCHAR(64),
  is_active                  BOOLEAN      NOT NULL DEFAULT true,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ers_org    ON ers_configurations (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ers_tenant ON ers_configurations (tenant_id)       WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ers_emergency_number ON ers_configurations (emergency_number)
  WHERE deleted_at IS NULL AND is_active = true AND emergency_number IS NOT NULL;

-- ── 20. ERS Tier Groups ───────────────────────────────────────────────────────
-- (added in migration 009)
CREATE TABLE IF NOT EXISTS ers_tier_groups (
  id                   BIGSERIAL    PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  tier                 VARCHAR(10)  NOT NULL CHECK (tier IN ('primary','secondary')),
  group_id             INT          NOT NULL REFERENCES responder_groups(id)   ON DELETE CASCADE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ers_configuration_id, tier, group_id)
);
CREATE INDEX IF NOT EXISTS idx_ers_tier_groups_config ON ers_tier_groups (ers_configuration_id);

-- ── 21. ERS Tier Contacts ─────────────────────────────────────────────────────
-- (added in migration 010)
CREATE TABLE IF NOT EXISTS ers_tier_contacts (
  id                   BIGSERIAL    PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  tier                 VARCHAR(10)  NOT NULL CHECK (tier IN ('primary','secondary')),
  contact_id           INT          NOT NULL REFERENCES emergency_contacts(id)  ON DELETE CASCADE,
  priority             INT          NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ers_configuration_id, tier, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_ers_tier_contacts_config_tier ON ers_tier_contacts (ers_configuration_id, tier);

-- ── 22. ERS Incidents ─────────────────────────────────────────────────────────
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

-- ── 23. ERS Incident Responders ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_incident_responders (
  id                   SERIAL      PRIMARY KEY,
  ers_incident_id      INT         NOT NULL REFERENCES ers_incidents(id)       ON DELETE CASCADE,
  emergency_contact_id INT         NOT NULL REFERENCES emergency_contacts(id),
  join_time            TIMESTAMPTZ,
  leave_time           TIMESTAMPTZ,
  call_uuid            VARCHAR(64),
  joined_via           VARCHAR(32),
  rejoin_count         INT         NOT NULL DEFAULT 0,
  status               VARCHAR(16) NOT NULL DEFAULT 'INVITED'
                         CHECK (status IN ('INVITED','JOINED','MISSED','REJOINED','OBSERVER'))
);

-- ── 24. ERS Queue ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_queues (
  id                   SERIAL      PRIMARY KEY,
  ers_configuration_id INT         NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  incident_id          INT         NOT NULL REFERENCES ers_incidents(id) ON DELETE SET NULL,
  position             INT         NOT NULL DEFAULT 1,
  status               VARCHAR(16) NOT NULL DEFAULT 'QUEUED'
                         CHECK (status IN ('QUEUED','DEQUEUED','CANCELLED')),
  caller_number        VARCHAR(32),
  queued_reason        VARCHAR(64),
  dequeued_at          TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id)
);

-- ── 25. IVR Flows ─────────────────────────────────────────────────────────────
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

-- ── 26. IVR Flow Versions ─────────────────────────────────────────────────────
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

-- ── 27. IVR Templates ─────────────────────────────────────────────────────────
-- (added in migration 006)
CREATE TABLE IF NOT EXISTS ivr_templates (
  id          SERIAL       PRIMARY KEY,
  slug        VARCHAR(64)  UNIQUE NOT NULL,
  name        VARCHAR(128) NOT NULL,
  description TEXT,
  graph       JSONB        NOT NULL DEFAULT '{}',
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 28. Emergency Numbers — unified service registry ──────────────────────────
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
  service_name         VARCHAR(128),
  description          VARCHAR(255),
  icon                 VARCHAR(64),
  color                VARCHAR(32),
  sort_order           INT          NOT NULL DEFAULT 0,
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_emnum_tenant ON emergency_numbers (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emnum_number ON emergency_numbers (number)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emnum_type   ON emergency_numbers (type)      WHERE deleted_at IS NULL;

-- ── 29. Audit Logs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NOT NULL,
  entity_id   VARCHAR(64),
  details     JSONB,
  ip_address  INET,
  http_method VARCHAR(8),
  http_path   VARCHAR(512),
  user_agent  VARCHAR(512),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs (user_id)            WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs (created_at DESC);

-- ── 30. System Settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id          SERIAL       PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  value       TEXT,
  value_json  JSONB,
  description TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 31. ESL Connections ───────────────────────────────────────────────────────
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

-- ── 32. Feature Flags ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id          SERIAL       PRIMARY KEY,
  key         VARCHAR(128) UNIQUE NOT NULL,
  description TEXT,
  is_enabled  BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 33. Audio Library ─────────────────────────────────────────────────────────
-- (added in migration 007)
CREATE TABLE IF NOT EXISTS audio_library (
  id              BIGSERIAL    PRIMARY KEY,
  organization_id INT          REFERENCES organizations(id) ON DELETE SET NULL,
  tenant_id       INT          REFERENCES tenants(id)       ON DELETE SET NULL,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  file_path       VARCHAR(512) NOT NULL,
  file_size       BIGINT,
  duration_sec    NUMERIC(10,2),
  mime_type       VARCHAR(64)  NOT NULL DEFAULT 'audio/wav',
  category        VARCHAR(32)  NOT NULL DEFAULT 'general'
                    CHECK (category IN ('general','announcement','hold_music','ivr_prompt','recording')),
  uploaded_by     INT          REFERENCES users(id) ON DELETE SET NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_audio_org    ON audio_library (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audio_tenant ON audio_library (tenant_id)       WHERE deleted_at IS NULL;

-- ── Seed: Feature Flags ───────────────────────────────────────────────────────
INSERT INTO feature_flags (key, description, is_enabled) VALUES
  ('ens_enabled',     'Enable ENS (Emergency Notification System)', true),
  ('ers_enabled',     'Enable ERS (Emergency Response System)',     true),
  ('ivr_designer',    'IVR Designer visual editor',                 true),
  ('multi_tenant',    'Multi-tenant mode',                          false),
  ('csv_bulk_upload', 'Bulk upload contacts via CSV',               true),
  ('audit_logging',   'Record all data changes to audit_logs',      true)
ON CONFLICT (key) DO NOTHING;

-- ── Seed: System Settings ─────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('app_name',            'fs-enrs', 'Application display name'),
  ('app_version',         '1.0.0',   'Current version'),
  ('esl_reconnect_ms',    '3000',    'ESL reconnect delay milliseconds'),
  ('jwt_access_expiry',   '15m',     'JWT access token expiry'),
  ('jwt_refresh_expiry',  '7d',      'JWT refresh token expiry'),
  ('max_login_attempts',  '5',       'Max login attempts before lockout'),
  ('default_retry_count', '3',       'Default ENS retry count')
ON CONFLICT (key) DO NOTHING;

COMMIT;
