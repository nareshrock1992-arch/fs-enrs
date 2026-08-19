BEGIN;

-- Fix: the original UNIQUE (tenant_id, name) constraint in 015_sip_gateways
-- is non-partial — it covers soft-deleted rows (deleted_at IS NOT NULL) as
-- well as active ones. This means a soft-deleted gateway permanently holds its
-- (tenant_id, name) slot, preventing recreation of a gateway with the same name
-- after deletion. Replace the constraint with a partial unique index that
-- enforces uniqueness only among active (non-deleted) rows.
--
-- The business rule is unchanged: two ACTIVE gateways for the same tenant cannot
-- share a name. A deleted gateway no longer holds the slot.

ALTER TABLE sip_gateways
  DROP CONSTRAINT IF EXISTS sip_gateways_tenant_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS sip_gateways_active_name_unique
  ON sip_gateways (tenant_id, name)
  WHERE deleted_at IS NULL;

COMMIT;
