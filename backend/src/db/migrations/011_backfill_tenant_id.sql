-- =============================================================================
-- Migration 011 — Backfill tenant_id on ERS/ENS configurations
-- =============================================================================
--
-- Catches any rows where tenant_id was never populated because the INSERT
-- statements in ersController.js / ensController.js were missing the column
-- (fixed in the same release as this migration).
--
-- Safe to re-run: UPDATE … WHERE tenant_id IS NULL is idempotent.
-- =============================================================================

BEGIN;

-- ERS configurations
UPDATE ers_configurations ec
SET    tenant_id  = o.tenant_id,
       updated_at = now()
FROM   organizations o
WHERE  o.id        = ec.organization_id
  AND  ec.tenant_id IS NULL
  AND  ec.deleted_at IS NULL;

-- ENS configurations
UPDATE ens_configurations ec
SET    tenant_id  = o.tenant_id,
       updated_at = now()
FROM   organizations o
WHERE  o.id        = ec.organization_id
  AND  ec.tenant_id IS NULL
  AND  ec.deleted_at IS NULL;

-- Verification
DO $$
DECLARE
  v_ers_null INT;
  v_ens_null INT;
BEGIN
  SELECT COUNT(*)::INT INTO v_ers_null FROM ers_configurations WHERE tenant_id IS NULL AND deleted_at IS NULL;
  SELECT COUNT(*)::INT INTO v_ens_null FROM ens_configurations  WHERE tenant_id IS NULL AND deleted_at IS NULL;

  RAISE NOTICE '=== Migration 011 verification ===';
  RAISE NOTICE 'ERS configs with NULL tenant_id : % (expect 0)', v_ers_null;
  RAISE NOTICE 'ENS configs with NULL tenant_id : % (expect 0)', v_ens_null;
  RAISE NOTICE '==================================';

  IF v_ers_null > 0 THEN RAISE WARNING 'ERS rows still have NULL tenant_id — check organizations.tenant_id for those orgs'; END IF;
  IF v_ens_null > 0 THEN RAISE WARNING 'ENS rows still have NULL tenant_id — check organizations.tenant_id for those orgs'; END IF;
END $$;

COMMIT;
