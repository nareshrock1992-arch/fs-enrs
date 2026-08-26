-- Migration 047: Add unauthorized_msg to ens_configurations
--
-- Adds a per-configuration text field for the message spoken to callers who
-- dial a playback number but are not authorized for any campaign.
-- NULL means use the generic fallback in Lua:
--   "You are not authorized to access this message."
-- No existing rows require updates — the Lua fallback handles NULL transparently.

BEGIN;

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS unauthorized_msg TEXT;

COMMIT;
