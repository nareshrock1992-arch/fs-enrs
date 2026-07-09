BEGIN;

-- Backfill emergency_numbers.tenant_id rows that were created before
-- createService started setting it, or via direct SQL import.
-- Priority: linked org's tenant_id → first available tenant (single-tenant fallback).
UPDATE emergency_numbers en
SET tenant_id = COALESCE(
  (SELECT o.tenant_id
     FROM organizations o
    WHERE o.id = en.organization_id AND o.deleted_at IS NULL),
  (SELECT id FROM tenants ORDER BY id LIMIT 1)
)
WHERE en.tenant_id IS NULL AND en.deleted_at IS NULL;

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count
    FROM emergency_numbers
   WHERE tenant_id IS NULL AND deleted_at IS NULL;
  IF null_count > 0 THEN
    RAISE WARNING 'emergency_numbers: % row(s) still have NULL tenant_id — verify tenants table is populated', null_count;
  ELSE
    RAISE NOTICE 'emergency_numbers: tenant_id backfill complete — 0 NULLs remaining';
  END IF;
END $$;

COMMIT;
