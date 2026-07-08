-- 009_ers_tier_groups.sql
-- Replaces the single primary_group_id / secondary_group_id FKs on
-- ers_configurations with a proper junction table that allows any number
-- of responder groups per tier (primary / secondary).
--
-- Backward compat: existing single-FK rows are migrated into the new table
-- and the old columns are kept but no longer written by the application.

BEGIN;

CREATE TABLE IF NOT EXISTS ers_tier_groups (
  id                   BIGSERIAL    PRIMARY KEY,
  ers_configuration_id INT          NOT NULL REFERENCES ers_configurations(id) ON DELETE CASCADE,
  tier                 VARCHAR(10)  NOT NULL CHECK (tier IN ('primary','secondary')),
  group_id             INT          NOT NULL REFERENCES responder_groups(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ers_configuration_id, tier, group_id)
);

CREATE INDEX IF NOT EXISTS idx_ers_tier_groups_config_tier
  ON ers_tier_groups (ers_configuration_id, tier);

-- Migrate existing single-FK assignments so no config loses its responders
INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id)
  SELECT id, 'primary', primary_group_id
  FROM   ers_configurations
  WHERE  primary_group_id IS NOT NULL
    AND  deleted_at IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id)
  SELECT id, 'secondary', secondary_group_id
  FROM   ers_configurations
  WHERE  secondary_group_id IS NOT NULL
    AND  deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Queue hold audio path (optional) — played in a loop while caller waits
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS queue_hold_audio VARCHAR(512);

-- Record conferences flag (optional, default false)
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS record_conferences BOOLEAN NOT NULL DEFAULT false;

-- Track the FreeSWITCH UUID of the held caller so Lua can poll status
ALTER TABLE ers_incidents
  ADD COLUMN IF NOT EXISTS caller_fs_uuid VARCHAR(64);

COMMIT;
