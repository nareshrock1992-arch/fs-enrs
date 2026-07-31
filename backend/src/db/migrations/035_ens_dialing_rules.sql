-- ============================================================
--  Migration 035 — ENS Dialing Rules (campaign-owned)
--
--  Architecture: ENS Configuration owns ALL campaign dialing
--  behaviour. Gateway owns ONLY SIP connectivity.
--
--  The same gateway (e.g., Avaya) can serve multiple ENS
--  configurations, each with different dialing rules:
--    ENS-A: +966xxxxxxxxx  (international mobile)
--    ENS-B: 9xxxxxxxxxx    (local format)
--    ENS-C: 10-digit only  (no formatting)
--
--  Adds to ens_configurations:
--    Mobile dialing rules — allow_mobile, formatting options
--    Extension dialing rules — allow_extension, formatting options
--
--  Adds to ens_campaign_destinations:
--    Snapshot columns for audit trail — target_type,
--    original_number, routing_mode_used, gateway_name
--
--  All changes are ADD COLUMN IF NOT EXISTS — safe to run
--  multiple times. No columns are dropped in this migration.
--  Destructive cleanup (removing dead columns) is handled in
--  a separate migration after this one is stable in production.
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- A: Mobile dialing rules on ens_configurations
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS allow_mobile              BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mobile_normalize_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_strip_leading_zero BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_prefix             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS mobile_suffix             VARCHAR(20);

-- ─────────────────────────────────────────────────────────────
-- B: Extension dialing rules on ens_configurations
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS allow_extension      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ext_normalize_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ext_prefix            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ext_suffix            VARCHAR(20);

-- ─────────────────────────────────────────────────────────────
-- C: Destination snapshot — immutable audit trail per dial
--    gateway_name: which gateway was resolved at campaign creation
--                  null = internal routing (user/<ext>)
--    target_type:  'mobile' or 'extension'
--    original_number: raw value from emergency_contacts before formatting
--    routing_mode_used: 'gateway' or 'internal' (resolved value)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_campaign_destinations
  ADD COLUMN IF NOT EXISTS gateway_name      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS target_type       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS original_number   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS routing_mode_used VARCHAR(20);

COMMIT;
