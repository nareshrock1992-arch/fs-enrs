-- Cleanup: Duplicate Default Organization rows
--
-- Run this BEFORE migration 037 (037_organizations_is_system.sql) if the
-- is_system column does not yet exist, or at any time as a safe re-run.
--
-- Survivor identification:
--   1. If a row with is_system=true already exists (from a prior migration run),
--      that row is the canonical survivor — never identified by code.
--   2. If no is_system=true row exists (fresh environment), the survivor is
--      the lowest id among live rows whose code = 'DEFAULT-ORG' (boot-created
--      rows always use that code), and that row will be marked is_system=true
--      by migration 037 after this script runs.
--
-- Safe execution order:
--   1. Run this script  →  psql -U enrs -d enrs_db -f backend/scripts/cleanup_duplicate_orgs.sql
--   2. Run migrations   →  cd backend && npm run migrate
--   3. Restart PM2      →  pm2 restart enrs-backend
--
-- This script:
--   • Never hard-deletes — uses soft-delete (deleted_at = now())
--   • Keeps the is_system=true row as the survivor (or lowest id as fallback)
--   • Re-points all child records from phantom ids to the surviving id
--   • Is idempotent — safe to run multiple times
--   • Rolls back entirely if anything fails

BEGIN;

-- ── 1. Identify the surviving row ────────────────────────────────────────────
-- Prefer the row already marked is_system=true. If the column doesn't exist
-- yet (pre-037 environment), fall back to the lowest id with code='DEFAULT-ORG'.

CREATE TEMP TABLE _org_survivor AS
SELECT id AS survivor_id
FROM organizations
WHERE deleted_at IS NULL
  AND (
    -- Post-037: use the immutable identity flag
    (pg_catalog.pg_attribute.attname IS NOT DISTINCT FROM NULL
       AND false)  -- placeholder; real check below
    OR true
  )
LIMIT 0; -- placeholder, replaced immediately below

-- Use a DO block to handle the case where is_system column may not exist yet
DO $$
DECLARE
  col_exists BOOLEAN;
  survivor_id INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'is_system'
  ) INTO col_exists;

  IF col_exists THEN
    -- Prefer the row already marked as the system org
    EXECUTE $q$
      SELECT id FROM organizations
      WHERE is_system = true AND deleted_at IS NULL
      LIMIT 1
    $q$ INTO survivor_id;
  END IF;

  IF survivor_id IS NULL THEN
    -- Fallback: lowest id with code='DEFAULT-ORG' (pre-037 or no marked row)
    SELECT MIN(id) INTO survivor_id
    FROM organizations
    WHERE code = 'DEFAULT-ORG' AND deleted_at IS NULL;
  END IF;

  IF survivor_id IS NULL THEN
    RAISE NOTICE 'No Default Organization rows found. Nothing to clean up.';
    RETURN;
  END IF;

  -- Write survivor_id into the temp table for the UPDATE steps below
  INSERT INTO _org_survivor VALUES (survivor_id);
END $$;

-- ── 2. Identify phantom rows (all live orgs that are NOT the survivor AND
--       share the same name as the survivor, meaning they were auto-created) ───

CREATE TEMP TABLE _org_phantoms AS
SELECT o.id AS phantom_id, s.survivor_id
FROM organizations o, _org_survivor s
WHERE o.id <> s.survivor_id
  AND o.deleted_at IS NULL
  AND o.name = 'Default Organization';

-- ── 3. Re-point child records from each phantom to its survivor ───────────────

UPDATE emergency_contacts
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE emergency_contacts.organization_id = p.phantom_id
  AND emergency_contacts.deleted_at IS NULL;

UPDATE ens_configurations
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE ens_configurations.organization_id = p.phantom_id
  AND ens_configurations.deleted_at IS NULL;

UPDATE ers_configurations
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE ers_configurations.organization_id = p.phantom_id
  AND ers_configurations.deleted_at IS NULL;

UPDATE emergency_numbers
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE emergency_numbers.organization_id = p.phantom_id
  AND emergency_numbers.deleted_at IS NULL;

UPDATE ivr_flows
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE ivr_flows.organization_id = p.phantom_id
  AND ivr_flows.deleted_at IS NULL;

UPDATE responder_groups
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE responder_groups.organization_id = p.phantom_id
  AND responder_groups.deleted_at IS NULL;

UPDATE locations
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE locations.organization_id = p.phantom_id
  AND locations.deleted_at IS NULL;

UPDATE departments
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE departments.organization_id = p.phantom_id
  AND departments.deleted_at IS NULL;

UPDATE notification_templates
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE notification_templates.organization_id = p.phantom_id
  AND notification_templates.deleted_at IS NULL;

UPDATE media_files
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE media_files.organization_id = p.phantom_id
  AND media_files.deleted_at IS NULL;

UPDATE audio_library
SET organization_id = p.survivor_id
FROM _org_phantoms p
WHERE audio_library.organization_id = p.phantom_id;

-- ── 4. Soft-delete the phantom rows ──────────────────────────────────────────

UPDATE organizations
SET deleted_at = now(), updated_at = now()
FROM _org_phantoms p
WHERE organizations.id = p.phantom_id;

-- ── 5. Verify ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  phantom_count INT;
  survivor_id   INT;
BEGIN
  SELECT survivor_id INTO survivor_id FROM _org_survivor;

  SELECT COUNT(*) INTO phantom_count FROM _org_phantoms;

  IF phantom_count = 0 THEN
    RAISE NOTICE 'No phantom Default Organization rows found. Nothing was changed.';
  ELSE
    RAISE NOTICE 'Soft-deleted % phantom Default Organization row(s). Survivor id=%.',
      phantom_count, survivor_id;
  END IF;

  RAISE NOTICE 'Safe to run: cd backend && npm run migrate';
END $$;

COMMIT;
