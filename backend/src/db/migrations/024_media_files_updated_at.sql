-- ============================================================
--  Migration 024 — Add updated_at to media_files
--
--  Root cause: media_files was created in migration 001 without
--  updated_at. Migrations 007 and 022 added many columns but
--  omitted updated_at. mediaLibraryController references it in
--  both SELECT (listMedia) and UPDATE SET (updateMedia), causing
--  "column m.updated_at does not exist" at runtime.
-- ============================================================

BEGIN;

ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Auto-update trigger so updated_at stays current on every UPDATE
CREATE OR REPLACE FUNCTION touch_media_files()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_files_updated ON media_files;
CREATE TRIGGER trg_media_files_updated
  BEFORE UPDATE ON media_files
  FOR EACH ROW EXECUTE FUNCTION touch_media_files();

INSERT INTO schema_migrations (version) VALUES ('024_media_files_updated_at.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
