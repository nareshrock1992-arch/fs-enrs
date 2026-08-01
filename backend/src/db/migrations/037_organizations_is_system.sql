-- Migration 037: Add is_system flag to organizations
--
-- Problem: organizations.code is an optional editable admin field used only
-- for display and search. It was incorrectly used as a bootstrap conflict key,
-- causing a new 'Default Organization' row to be inserted on every restart.
--
-- Solution: add an immutable internal flag (is_system) that marks the one
-- organization created by the bootstrap process. This flag is never shown in
-- the UI, never accepted from API payloads, and never mutated by admin CRUD.
--
-- On a fresh database: the column exists with DEFAULT false; the first INSERT
-- in server.js sets is_system=true, and the index blocks any second one.
--
-- On the existing production database: the column and index already exist from
-- a prior run of this migration. ALTER TABLE ... ADD COLUMN IF NOT EXISTS and
-- CREATE UNIQUE INDEX IF NOT EXISTS are both idempotent — safe to re-run.

BEGIN;

-- ── 1. Add the column (idempotent) ───────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Add the unique index (idempotent) ─────────────────────────────────────
-- Enforces the singleton: at most one live row may have is_system = true.
-- Named exactly as specified: organizations_single_system_idx.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_single_system_idx
  ON organizations (is_system)
  WHERE is_system = true AND deleted_at IS NULL;

-- ── No backfill by code ───────────────────────────────────────────────────────
-- We do NOT use code='DEFAULT-ORG' to identify the system org because code is
-- an editable display field and must not be used as a stable identifier.
-- The system org is identified solely by is_system=true.
--
-- On the production database, id=111 was already marked is_system=true by a
-- prior migration run — no action needed here.
--
-- On a fresh database, server.js inserts the Default Organization with
-- is_system=true in the same transaction as first boot — no backfill needed.

COMMIT;
