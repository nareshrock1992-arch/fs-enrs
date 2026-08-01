-- Migration 037: Add is_system flag to organizations
--
-- Problem: organizations.code is an optional editable admin field used only
-- for display and search. It was incorrectly used as a bootstrap conflict key,
-- causing a new 'Default Organization' row to be inserted on every restart
-- because ON CONFLICT DO NOTHING had nothing to conflict on.
--
-- Solution: add an immutable internal identity flag (is_system) that marks
-- the one organization created by the bootstrap process. This flag is never
-- shown in the UI, never accepted from API requests, and never changed by
-- admin operations.
--
-- The partial unique index ensures at most one live system organization can
-- exist at any time. The bootstrap INSERT targets this flag, not the editable
-- code field.

BEGIN;

-- ── 1. Add the column ─────────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Mark the existing default organization ─────────────────────────────────
-- Targets the row with code='DEFAULT-ORG' that was created by previous
-- bootstrap runs. Uses the lowest id if duplicates exist (the original row).
-- Safe when no such row exists — UPDATE affects 0 rows.

UPDATE organizations
SET    is_system  = true,
       updated_at = now()
WHERE  id = (
  SELECT MIN(id)
  FROM   organizations
  WHERE  code       = 'DEFAULT-ORG'
    AND  deleted_at IS NULL
);

-- ── 3. Add partial unique index ───────────────────────────────────────────────
-- Enforces the singleton: at most one live row may have is_system = true.
-- Soft-deleted system orgs are excluded so a restored org doesn't violate it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_system_singleton
  ON organizations (is_system)
  WHERE is_system = true AND deleted_at IS NULL;

COMMIT;
