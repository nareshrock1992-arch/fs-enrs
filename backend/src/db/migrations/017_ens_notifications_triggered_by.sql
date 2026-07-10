BEGIN;

-- Fix: "column n.triggered_by_user_id does not exist" (reports query) and
-- the same crash on the UI-trigger path (ensController.js INSERTs into it).
--
-- Root cause — the recurring schema.sql drift disease: migration 001
-- defines triggered_by_user_id (and recording_reference) on
-- ens_notifications, but schema.sql — which fresh installs apply INSTEAD
-- of 001, marking 001 as covered — omits both. Any database created via
-- the fresh-install path is missing them while every upgraded-from-001
-- database has them. schema.sql is fixed in the same commit; this
-- migration repairs existing fresh-installed databases. Idempotent — a
-- database that came through 001 already has the columns and this no-ops.

ALTER TABLE ens_notifications
  ADD COLUMN IF NOT EXISTS triggered_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recording_reference  VARCHAR(512);

-- Matches 001's FK semantics (ON DELETE SET NULL — a deleted user must
-- never cascade-delete notification history). Index for the reports
-- query's join and any per-user history lookups.
CREATE INDEX IF NOT EXISTS idx_ens_notif_triggered_by
  ON ens_notifications (triggered_by_user_id)
  WHERE triggered_by_user_id IS NOT NULL;

COMMIT;
