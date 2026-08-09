-- =============================================================================
-- Migration 042 — ERS configuration-level SIP gateway
--
-- ERS configurations currently have no gateway field. The Lua script
-- ers_conference_bridge.lua falls back to a hardcoded
-- "sofia/gateway/primary" name when calling responders because
-- ers_configurations.sip_gateway does not exist (that column belongs
-- to ens_configurations). This migration adds a proper FK column.
--
-- Priority chain (highest → lowest):
--   1. emergency_contacts.gateway_id   (per-contact override, added migration 015)
--   2. ers_configurations.sip_gateway_id  (configuration default, NEW)
--   3. tenant's is_default_outbound gateway
--   4. null → user/<ext>  (internal FreeSWITCH, no gateway)
--
-- ON DELETE SET NULL: deleting a sip_gateways row leaves ERS configs
-- intact — they fall through to the next priority level rather than
-- failing hard.
--
-- Backward compatibility: all existing ers_configurations rows keep
-- sip_gateway_id = NULL and therefore behave identically to today.
-- =============================================================================

BEGIN;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS sip_gateway_id INT REFERENCES sip_gateways(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ers_cfg_gateway
  ON ers_configurations (sip_gateway_id)
  WHERE sip_gateway_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('042_ers_gateway.sql')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
