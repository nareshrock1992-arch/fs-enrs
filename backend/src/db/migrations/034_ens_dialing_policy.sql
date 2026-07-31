-- ============================================================
--  Migration 034 — ENS Dialing Policy (campaign-level)
--
--  Adds campaign-level routing policy to ens_configurations.
--  ENS only decides WHAT to dial (preference + mode).
--  HOW to format and route numbers is the gateway's concern
--  and lives in migration 035 (sip_gateways dialing rules).
--
--  Wave 1 defaults preserve existing behaviour:
--    routing_mode    = 'auto'            (gateway-chain detection)
--    dial_preference = 'extension_mobile' (extension preferred, mobile fallback)
--    skip_behavior   = 'skip'            (skip + WARN per Wave 1 spec)
-- ============================================================

BEGIN;

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS routing_mode   VARCHAR(20)  NOT NULL DEFAULT 'auto'
                             CHECK (routing_mode IN ('auto','internal_only','gateway_only')),
  ADD COLUMN IF NOT EXISTS dial_preference VARCHAR(30) NOT NULL DEFAULT 'extension_mobile'
                             CHECK (dial_preference IN
                               ('extension_only','mobile_only','extension_mobile','mobile_extension')),
  ADD COLUMN IF NOT EXISTS fallback_mode  VARCHAR(30)  NOT NULL DEFAULT 'none'
                             CHECK (fallback_mode IN ('none','extension_mobile','mobile_extension')),
  ADD COLUMN IF NOT EXISTS skip_behavior  VARCHAR(20)  NOT NULL DEFAULT 'skip'
                             CHECK (skip_behavior IN ('skip','fail','warn'));

COMMIT;
