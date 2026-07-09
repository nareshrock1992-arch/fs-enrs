BEGIN;

-- Root-cause backfill: createOrganization used to take tenant_id from the
-- request body (never sent by the UI), so orgs — and everything scoped
-- through them — ended up with NULL tenant_id. Backfill orgs first, then
-- re-derive every dependent table.

-- 1. Organizations: assign the first tenant (single-tenant installs).
UPDATE organizations
SET tenant_id = (SELECT id FROM tenants ORDER BY id LIMIT 1)
WHERE tenant_id IS NULL AND deleted_at IS NULL;

-- 2. Re-run dependent backfills now that orgs have tenants.
UPDATE ers_configurations c
SET tenant_id = COALESCE(
  (SELECT o.tenant_id FROM organizations o WHERE o.id = c.organization_id),
  (SELECT id FROM tenants ORDER BY id LIMIT 1)
)
WHERE c.tenant_id IS NULL AND c.deleted_at IS NULL;

UPDATE ens_configurations c
SET tenant_id = COALESCE(
  (SELECT o.tenant_id FROM organizations o WHERE o.id = c.organization_id),
  (SELECT id FROM tenants ORDER BY id LIMIT 1)
)
WHERE c.tenant_id IS NULL AND c.deleted_at IS NULL;

UPDATE emergency_numbers en
SET tenant_id = COALESCE(
  (SELECT o.tenant_id FROM organizations o WHERE o.id = en.organization_id),
  (SELECT id FROM tenants ORDER BY id LIMIT 1)
)
WHERE en.tenant_id IS NULL AND en.deleted_at IS NULL;

DO $$
DECLARE
  n_org INTEGER; n_en INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_org FROM organizations WHERE tenant_id IS NULL AND deleted_at IS NULL;
  SELECT COUNT(*) INTO n_en  FROM emergency_numbers WHERE tenant_id IS NULL AND deleted_at IS NULL;
  IF n_org > 0 OR n_en > 0 THEN
    RAISE WARNING 'tenant backfill incomplete: % org(s), % emergency_number(s) still NULL — is the tenants table empty?', n_org, n_en;
  ELSE
    RAISE NOTICE 'tenant backfill complete: organizations, ers/ens configurations, emergency_numbers all scoped';
  END IF;
END $$;

COMMIT;
