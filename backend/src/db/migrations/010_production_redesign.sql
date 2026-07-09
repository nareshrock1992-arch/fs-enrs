-- 010_production_redesign.sql
-- Production-grade redesign: ERS new fields, ENS new fields,
-- ERS tier contacts, IVR publish fix, ENS contact-model unification.
-- Idempotent — safe to re-run.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ERS CONFIGURATIONS — full production field set
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS description                  TEXT,
  ADD COLUMN IF NOT EXISTS primary_bridge_number        VARCHAR(32),
  ADD COLUMN IF NOT EXISTS secondary_bridge_number      VARCHAR(32),
  ADD COLUMN IF NOT EXISTS conference_profile           VARCHAR(64)  NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS queue_announcement_audio     VARCHAR(512),
  ADD COLUMN IF NOT EXISTS queue_music_path             VARCHAR(512),
  ADD COLUMN IF NOT EXISTS queue_timeout_sec            INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queue_priority               INT          NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS recording_directory          VARCHAR(512),
  ADD COLUMN IF NOT EXISTS retry_ring_count             INT          NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS retry_ring_interval          INT          NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS allow_rejoin                 BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cli_authentication           BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_conference_duration_min  INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS primary_retry_count          INT          NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS primary_retry_interval_sec   INT          NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS secondary_retry_count        INT          NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS secondary_retry_interval_sec INT          NOT NULL DEFAULT 30;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ERS TIER CONTACTS — individual contacts per tier
--    Complements ers_tier_groups (which maps whole responder groups).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_tier_contacts (
  id                   BIGSERIAL    PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  tier                 VARCHAR(10)  NOT NULL CHECK (tier IN ('primary','secondary')),
  contact_id           INT          NOT NULL REFERENCES emergency_contacts(id)  ON DELETE CASCADE,
  priority             INT          NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ers_configuration_id, tier, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_ers_tier_contacts_config_tier
  ON ers_tier_contacts (ers_configuration_id, tier);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ENS CONFIGURATIONS — new production fields
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS batch_size           INT          NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS max_active_campaigns INT          NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS no_pending_msg       TEXT,
  ADD COLUMN IF NOT EXISTS expiry_announcement  TEXT,
  ADD COLUMN IF NOT EXISTS playback_number      VARCHAR(32);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ENS CONTACT MODEL UNIFICATION
--    The public controller uses emergency_contact_id / responder_group_id.
--    Ensure those columns exist in the junction tables (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ens_configuration_contacts
  ADD COLUMN IF NOT EXISTS emergency_contact_id INT REFERENCES emergency_contacts(id) ON DELETE CASCADE;

ALTER TABLE ens_configuration_groups
  ADD COLUMN IF NOT EXISTS responder_group_id INT REFERENCES responder_groups(id) ON DELETE CASCADE;

-- Partial unique indexes for both FK columns (safe to re-run with IF NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ens_cfg_contacts_ec
  ON ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
  WHERE emergency_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_ens_cfg_groups_rg
  ON ens_configuration_groups (ens_configuration_id, responder_group_id)
  WHERE responder_group_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. EMERGENCY NUMBERS — service registry completeness
-- ─────────────────────────────────────────────────────────────────────────────
-- 'IVR' type is already allowed from migration 006.
-- Add tenant_id for scoping where missing.
ALTER TABLE emergency_numbers
  ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL;

-- Backfill tenant_id from the linked organization
UPDATE emergency_numbers en
SET    tenant_id = o.tenant_id
FROM   organizations o
WHERE  en.organization_id = o.id
  AND  en.tenant_id IS NULL
  AND  o.tenant_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. IVR FLOW VERSIONS — fix published_at NULL / missing DEFAULT
--    Migration 004 adds the column WITHOUT a DEFAULT, causing NULL inserts
--    when the backend INSERT omits the column.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ivr_flow_versions
  ALTER COLUMN published_at SET DEFAULT now();

-- Backfill any existing NULLs before enforcing NOT NULL
-- (ivr_flow_versions has no created_at column — now() is the only source)
UPDATE ivr_flow_versions
SET    published_at = now()
WHERE  published_at IS NULL;

ALTER TABLE ivr_flow_versions
  ALTER COLUMN published_at SET NOT NULL;

-- Ensure version_uuid has a DEFAULT so the INSERT can omit it safely
ALTER TABLE ivr_flow_versions
  ALTER COLUMN version_uuid SET DEFAULT gen_random_uuid();

UPDATE ivr_flow_versions
SET    version_uuid = gen_random_uuid()
WHERE  version_uuid IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. INDEXES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ens_configuration_contacts_ec
  ON ens_configuration_contacts (ens_configuration_id, emergency_contact_id)
  WHERE emergency_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ens_configuration_groups_rg
  ON ens_configuration_groups (ens_configuration_id, responder_group_id)
  WHERE responder_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ers_tier_contacts_config
  ON ers_tier_contacts (ers_configuration_id);

COMMIT;
