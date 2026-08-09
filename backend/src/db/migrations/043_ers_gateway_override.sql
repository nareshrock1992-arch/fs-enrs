-- Migration 043: Add gateway_override to ers_configurations
--
-- Administrators may need to reference FreeSWITCH gateway names that are not
-- registered in the sip_gateways table (e.g. manually created XML files or
-- carrier-provisioned SIP trunks). This column stores that override name.
--
-- Precedence at dial time:
--   gateway_override → sip_gateway_id → tenant default → user/<dest>
--
-- Backward compatible: existing rows remain valid; the column is nullable.
-- No index required — not used as a WHERE predicate.

BEGIN;

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS gateway_override VARCHAR(255) DEFAULT NULL;

COMMIT;
