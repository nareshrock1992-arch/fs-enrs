-- Migration 037: Add partial unique index on organizations.code
--
-- Root cause: organizations.code had no uniqueness enforcement, so
-- ON CONFLICT DO NOTHING in server.js ensureAdminUser() never fired,
-- creating a new 'Default Organization' row on every backend restart.
--
-- Design choice: partial index (WHERE deleted_at IS NULL AND code IS NOT NULL)
--   • Excludes soft-deleted rows so a deleted org's code can be reused.
--   • Excludes NULL codes so orgs without a code are unconstrained.
--   • Single-column (not composite with tenant_id) because tenant_id is
--     nullable (ON DELETE SET NULL), and NULLs are never equal in a
--     composite unique index — making UNIQUE(tenant_id, code) silently
--     ineffective whenever tenant_id is NULL.
--
-- Pre-condition: no two live rows (deleted_at IS NULL) may share the same
-- non-null code. If duplicate Default Organization rows exist, run the
-- cleanup script first:
--
--   psql -U enrs -d enrs_db -f backend/scripts/cleanup_duplicate_orgs.sql
--
-- then re-run this migration.
--
-- Future multi-tenant note: when organizations.tenant_id is made NOT NULL
-- (requires a separate backfill + constraint migration), replace this index
-- with UNIQUE(tenant_id, code) to allow different tenants to share codes.

BEGIN;

-- ── Pre-flight: abort with a clear message if duplicates exist ────────────────
-- This block runs before the index creation. If any code appears more than
-- once in live rows, the migration halts with an actionable error message
-- rather than a cryptic PostgreSQL index-build failure.

DO $$
DECLARE
  dup_count  INT;
  dup_sample TEXT;
BEGIN
  SELECT COUNT(*), string_agg(code || ' (' || cnt || ' rows)', ', ' ORDER BY code)
  INTO   dup_count, dup_sample
  FROM (
    SELECT code, COUNT(*) AS cnt
    FROM   organizations
    WHERE  deleted_at IS NULL
      AND  code IS NOT NULL
    GROUP  BY code
    HAVING COUNT(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      E'Migration 037 blocked: % duplicate organization code(s) found: %.\n'
      'Run the cleanup script first, then re-run migrations:\n'
      '  psql -U enrs -d enrs_db -f backend/scripts/cleanup_duplicate_orgs.sql\n'
      '  cd backend && npm run migrate',
      dup_count, dup_sample;
  END IF;
END $$;

-- ── Create the unique index ───────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_code_unique
  ON organizations (code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;

COMMIT;
