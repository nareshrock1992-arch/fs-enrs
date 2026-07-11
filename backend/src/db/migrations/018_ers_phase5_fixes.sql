-- Migration 018: ERS Phase-5 production fixes
-- * rejoin_open_access: when true, any caller may rejoin the active conference
--   via the bridge/rejoin number (observer mode). Default false = secure mode:
--   only configured tier contacts and the original initiator may rejoin.
-- * ring_timeout_seconds already exists (from migration 016). This migration
--   is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS rejoin_open_access BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ers_configurations.rejoin_open_access IS
  'When true, any caller dialing the bridge/rejoin number may join an active '
  'ERS conference (observer mode). Default false = only configured tier contacts '
  'and the original emergency initiator may rejoin.';

COMMIT;
