-- Migration 051: platform-wide uniqueness of contact extensions and mobile numbers.
--
-- Business rule (CONTACT_UPSERT_DESIGN.md): a normalised extension and a normalised
-- mobile number belong to at most one live contact on the whole platform, so a person
-- cannot exist twice and be called twice.
--
--   extension_norm  remove whitespace and ( ) . -, lower-case; empty → NULL
--   mobile_norm     keep digits and +; leading 00 → +; only a leading + kept; empty → NULL
-- (the same rules as backend/src/services/contactIdentity.js — keep both in step)
--
-- The columns are generated from the existing ones, so every writer stays consistent.
-- The unique indexes are partial: soft-deleted contacts and missing identifiers never
-- collide. Existing duplicates are NOT merged: if any exist the migration stops with
-- the contact ids and rolls back completely; remediation is a separate, reviewed step.
--
-- Idempotent (IF NOT EXISTS). Rollback:
--   DROP INDEX IF EXISTS uq_contacts_extension_norm;
--   DROP INDEX IF EXISTS uq_contacts_mobile_norm;
--   ALTER TABLE emergency_contacts DROP COLUMN IF EXISTS extension_norm, DROP COLUMN IF EXISTS mobile_norm;

BEGIN;

ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS extension_norm TEXT GENERATED ALWAYS AS (
    NULLIF(lower(regexp_replace(COALESCE(extension_number, ''), '[[:space:]().-]', '', 'g')), '')
  ) STORED;

ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS mobile_norm TEXT GENERATED ALWAYS AS (
    NULLIF(NULLIF(
      CASE WHEN left(regexp_replace(regexp_replace(COALESCE(mobile_number, ''), '[^0-9+]', '', 'g'), '^00', '+'), 1) = '+'
           THEN '+' || regexp_replace(regexp_replace(regexp_replace(COALESCE(mobile_number, ''), '[^0-9+]', '', 'g'), '^00', '+'), '[^0-9]', '', 'g')
           ELSE regexp_replace(regexp_replace(COALESCE(mobile_number, ''), '[^0-9+]', '', 'g'), '[^0-9]', '', 'g')
      END, ''), '+')
  ) STORED;

DO $$
DECLARE
  dup_ext TEXT;
  dup_mob TEXT;
BEGIN
  SELECT string_agg(ids, '; ') INTO dup_ext FROM (
    SELECT array_agg(id ORDER BY id)::text AS ids FROM emergency_contacts
     WHERE deleted_at IS NULL AND extension_norm IS NOT NULL
     GROUP BY extension_norm HAVING COUNT(*) > 1) d;
  SELECT string_agg(ids, '; ') INTO dup_mob FROM (
    SELECT array_agg(id ORDER BY id)::text AS ids FROM emergency_contacts
     WHERE deleted_at IS NULL AND mobile_norm IS NOT NULL
     GROUP BY mobile_norm HAVING COUNT(*) > 1) d;
  IF dup_ext IS NOT NULL OR dup_mob IS NOT NULL THEN
    RAISE EXCEPTION '[051] Existing duplicate contacts must be resolved first (nothing was changed). Contacts sharing an extension: %. Contacts sharing a mobile number: %. See docs/enterprise/CONTACT_UPSERT_IMPLEMENTATION.md',
      COALESCE(dup_ext, 'none'), COALESCE(dup_mob, 'none');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_extension_norm
  ON emergency_contacts (extension_norm) WHERE deleted_at IS NULL AND extension_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_mobile_norm
  ON emergency_contacts (mobile_norm) WHERE deleted_at IS NULL AND mobile_norm IS NOT NULL;

COMMIT;
