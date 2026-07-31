-- Migration 036: Drop dead and duplicate columns from ens_configurations
--
-- Dead columns (never read or written by any code path):
--   caller_id, phone_number, template_id
--
-- Denormalized orphans (authoritative source is emergency_numbers table;
--   these were never written by the API — Zod has always stripped them):
--   destination_number, playback_number
--
-- Duplicate aliases (canonical column kept, alias dropped):
--   max_concurrent      → canonical: max_concurrent_calls
--   retry_count         → canonical: max_attempts
--   retry_delay_seconds → canonical: retry_interval_sec
--   sip_caller_id       → canonical: blast_clid
--
-- The internal controller COALESCE fallbacks referencing the duplicate aliases
-- have been removed in ensInternalController.js before this migration runs.
-- The Zod schema in ensController.js never included the dead or alias columns.

BEGIN;

ALTER TABLE ens_configurations
  DROP COLUMN IF EXISTS caller_id,
  DROP COLUMN IF EXISTS phone_number,
  DROP COLUMN IF EXISTS template_id,
  DROP COLUMN IF EXISTS destination_number,
  DROP COLUMN IF EXISTS playback_number,
  DROP COLUMN IF EXISTS max_concurrent,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS retry_delay_seconds,
  DROP COLUMN IF EXISTS sip_caller_id;

COMMIT;
