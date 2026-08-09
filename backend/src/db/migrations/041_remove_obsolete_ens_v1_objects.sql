-- Migration 041: Remove ENS V1 tables, dead FK columns, and the legacy duration alias.
--
-- Background:
--   ens_contacts / ens_groups / ens_group_members — the ENS V1 contact model
--   (migration 002). Superseded by emergency_contacts + responder_groups (the
--   unified ERS/ENS model introduced in migration 010). Explicitly annotated
--   DEPRECATED in schema.sql. No controller reads or writes these tables.
--
--   ens_configuration_contacts.ens_contact_id — FK to the dead ens_contacts table.
--   Only the emergency_contact_id column in the same table is used.
--
--   ens_configuration_groups.ens_group_id — FK to the dead ens_groups table.
--   Only the responder_group_id column in the same table is used.
--
--   notification_templates — created in migration 001; the FK column that
--   referenced it (ens_configurations.template_id) was dropped by migration 036.
--   No application code has ever read or written this table since that drop.
--
--   tenant_mappings — created in migration 001; zero application-code references
--   found in any controller, service, or report.
--
--   media_files.duration_seconds — explicitly flagged legacy in schema.sql.
--   The canonical column is duration_sec. No controller reads or writes
--   duration_seconds; all SQL aliases named "duration_seconds" in the codebase
--   are EXTRACT(...)::INT computed expressions unrelated to this column.
--
-- Safety: each table drop is preceded by a COUNT(*) guard that aborts the
-- transaction if the table unexpectedly contains rows, preventing silent data
-- loss if production data exists contrary to audit findings.
--
-- Drop ordering (FK dependency chain):
--   1. Drop FK columns from junction tables (removes FKs referencing the dead tables)
--   2. Drop ens_group_members (FKs to ens_contacts and ens_groups)
--   3. Drop ens_contacts (now no FKs point to it)
--   4. Drop ens_groups (now no FKs point to it)
--   5. Drop notification_templates (FK from ens_configurations.template_id
--      was already removed by migration 036)
--   6. Drop tenant_mappings (no FKs)
--   7. Drop media_files.duration_seconds (no FKs; canonical column duration_sec kept)

BEGIN;

-- ── Safety guards: abort if supposedly-empty tables contain unexpected rows ───

DO $$
DECLARE
  cnt BIGINT;
BEGIN
  -- ens_group_members
  SELECT COUNT(*) INTO cnt FROM ens_group_members;
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'Migration 041 aborted: ens_group_members contains % row(s). Audit before dropping.',
      cnt;
  END IF;

  -- ens_contacts
  SELECT COUNT(*) INTO cnt FROM ens_contacts;
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'Migration 041 aborted: ens_contacts contains % row(s). Audit before dropping.',
      cnt;
  END IF;

  -- ens_groups
  SELECT COUNT(*) INTO cnt FROM ens_groups;
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'Migration 041 aborted: ens_groups contains % row(s). Audit before dropping.',
      cnt;
  END IF;

  -- notification_templates
  SELECT COUNT(*) INTO cnt FROM notification_templates;
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'Migration 041 aborted: notification_templates contains % row(s). Audit before dropping.',
      cnt;
  END IF;

  -- tenant_mappings
  SELECT COUNT(*) INTO cnt FROM tenant_mappings;
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'Migration 041 aborted: tenant_mappings contains % row(s). Audit before dropping.',
      cnt;
  END IF;
END;
$$;

-- ── Step 1: Drop dead FK columns from junction tables ─────────────────────────

-- ens_configuration_contacts.ens_contact_id → ens_contacts (dead path)
-- The live path uses emergency_contact_id (active FK to emergency_contacts).
ALTER TABLE ens_configuration_contacts
  DROP COLUMN IF EXISTS ens_contact_id;

-- ens_configuration_groups.ens_group_id → ens_groups (dead path)
-- The live path uses responder_group_id (active FK to responder_groups).
ALTER TABLE ens_configuration_groups
  DROP COLUMN IF EXISTS ens_group_id;

-- ── Step 2: Drop ens_group_members (child of both ens_contacts and ens_groups) ─

DROP TABLE IF EXISTS ens_group_members;

-- ── Step 3: Drop ens_contacts ─────────────────────────────────────────────────

DROP TABLE IF EXISTS ens_contacts;

-- ── Step 4: Drop ens_groups ───────────────────────────────────────────────────

DROP TABLE IF EXISTS ens_groups;

-- ── Step 5: Drop notification_templates ──────────────────────────────────────
-- The FK from ens_configurations.template_id was dropped by migration 036.
-- No other FK references this table.

DROP TABLE IF EXISTS notification_templates;

-- ── Step 6: Drop tenant_mappings ─────────────────────────────────────────────

DROP TABLE IF EXISTS tenant_mappings;

-- ── Step 7: Drop media_files.duration_seconds (legacy alias column) ───────────
-- Canonical column is duration_sec — confirmed present and actively used.

ALTER TABLE media_files
  DROP COLUMN IF EXISTS duration_seconds;

COMMIT;
