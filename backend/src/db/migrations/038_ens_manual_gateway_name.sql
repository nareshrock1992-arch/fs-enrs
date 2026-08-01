-- Migration 038: Add gateway_override to ens_configurations
--
-- Administrators may need to reference FreeSWITCH gateway names that are not
-- registered in the telephony_gateways table (e.g. manually created XML files
-- or carrier-provisioned SIP trunks). This column stores that override name.
--
-- Priority at dial time (future bgapi integration):
--   gateway_override → sip_gateway → platform default → internal
--
-- Backward compatible: existing rows remain valid; the column is nullable.

BEGIN;

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS gateway_override VARCHAR(255) DEFAULT NULL;

COMMIT;
