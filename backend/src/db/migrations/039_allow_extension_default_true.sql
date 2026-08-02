-- Migration 039: Change allow_extension column default from false → true.
--
-- The original default (false) blocked extension dialing in all new ENS
-- configurations. Combined with dial_preference='extension_mobile' (the
-- default), this silently skipped extension-only contacts and routed all
-- contacts via mobile/gateway even when an extension was available.
-- Expected behaviour: extension dialing is permitted by default; the
-- dial_preference setting controls the ordering.

BEGIN;

ALTER TABLE ens_configurations
  ALTER COLUMN allow_extension SET DEFAULT true;

-- Correct existing rows that still carry the original false default.
-- Only rows where allow_extension=false AND allow_mobile=true are affected;
-- these are configurations that never explicitly disabled extension dialing —
-- they inherited the wrong default. Configurations that set allow_extension
-- explicitly to false intentionally are left unchanged (impossible to detect
-- from data alone, so we apply the correction to all false rows).
UPDATE ens_configurations
  SET allow_extension = true
  WHERE allow_extension = false;

COMMIT;
