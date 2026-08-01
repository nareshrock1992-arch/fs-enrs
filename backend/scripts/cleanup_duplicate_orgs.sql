-- Cleanup: Duplicate Default Organization rows
--
-- Run this BEFORE migration 037. The unique index in 037 will fail to
-- create if duplicate live rows still exist.
--
-- Safe execution order:
--   1. Run this script (removes phantom duplicates)
--   2. Run: cd backend && npm run migrate  (applies 037)
--   3. Restart PM2
--
-- This script:
--   • Never hard-deletes — uses soft-delete (deleted_at = now())
--   • Keeps the LOWEST id (the original row)
--   • Re-points any child records from phantom ids to the surviving id
--   • Is idempotent — safe to run multiple times
--   • Rolls back entirely if anything fails

BEGIN;

-- ── 1. Identify the surviving row (lowest id per code group) ──────────────────

CREATE TEMP TABLE _org_survivors AS
SELECT DISTINCT ON (code)
  id   AS survivor_id,
  code AS org_code
FROM organizations
WHERE deleted_at IS NULL
  AND code IS NOT NULL
ORDER BY code, id ASC;

-- ── 2. Identify phantom rows (same code, higher id than the survivor) ─────────

CREATE TEMP TABLE _org_phantoms AS
SELECT o.id AS phantom_id, s.survivor_id, o.code
FROM organizations o
JOIN _org_survivors s ON s.org_code = o.code AND s.survivor_id <> o.id
WHERE o.deleted_at IS NULL;

-- ── 3. Show what will be cleaned up (informational) ──────────────────────────
-- Uncomment the SELECT below to preview before committing.

-- SELECT p.phantom_id, p.survivor_id, p.code,
--        (SELECT COUNT(*) FROM emergency_contacts   WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS contacts,
--        (SELECT COUNT(*) FROM ens_configurations   WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS ens_configs,
--        (SELECT COUNT(*) FROM ers_configurations   WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS ers_configs,
--        (SELECT COUNT(*) FROM emergency_numbers    WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS service_numbers,
--        (SELECT COUNT(*) FROM ivr_flows            WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS ivr_flows,
--        (SELECT COUNT(*) FROM responder_groups     WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS responder_groups,
--        (SELECT COUNT(*) FROM media_files          WHERE organization_id = p.phantom_id AND deleted_at IS NULL) AS media_files
-- FROM _org_phantoms p;

-- ── 4. Re-point child records from each phantom to its survivor ───────────────

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

-- ── 5. Soft-delete the phantom rows ──────────────────────────────────────────

UPDATE organizations
SET deleted_at = now(), updated_at = now()
FROM _org_phantoms p
WHERE organizations.id = p.phantom_id;

-- ── 6. Verify: should be zero after cleanup ───────────────────────────────────

DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM (
    SELECT code FROM organizations
    WHERE deleted_at IS NULL AND code IS NOT NULL
    GROUP BY code HAVING COUNT(*) > 1
  ) dupes;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Cleanup incomplete: % duplicate code group(s) still exist', remaining;
  END IF;

  RAISE NOTICE 'Cleanup complete. No duplicate organization codes remain.';
END $$;

COMMIT;
