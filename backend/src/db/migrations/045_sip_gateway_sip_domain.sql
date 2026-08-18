BEGIN;

-- Phase 27: Explicit P-Asserted-Identity support.
-- The SIP domain (e.g. "yerp.com") used to build PAI headers on outbound
-- SIP legs differs from the gateway proxy host (IP or FQDN).  Store it
-- per gateway so each trunk can carry its own enterprise SIP domain.
-- NULL means "use the FS_SIP_DOMAIN env-var global fallback"; an empty
-- PAI is suppressed entirely if neither is set.

ALTER TABLE sip_gateways
  ADD COLUMN IF NOT EXISTS sip_domain VARCHAR(255);

COMMENT ON COLUMN sip_gateways.sip_domain IS
  'SIP domain used in P-Asserted-Identity header (e.g. "yerp.com"). '
  'Distinct from host/proxy — this is the enterprise identity domain '
  'expected by the Session Manager / SBC. NULL = fall back to FS_SIP_DOMAIN env var.';

COMMIT;
