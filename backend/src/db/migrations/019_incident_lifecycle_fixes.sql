BEGIN;

-- ── 1. Backfill conference_room for any ACTIVE incidents missing it ─────────────
-- Uses the same deterministic formula as deterministicRoom():
-- ers_cfg<configuration_id>_<group_type>
UPDATE ers_incidents
SET conference_room = 'ers_cfg' || ers_configuration_id::text || '_' || group_type
WHERE status = 'ACTIVE'
  AND conference_room IS NULL
  AND deleted_at IS NULL;

-- ── 2. Enforce: ACTIVE incidents must always have a conference_room ─────────────
-- QUEUED incidents legitimately have no room until they are promoted.
ALTER TABLE ers_incidents
  DROP CONSTRAINT IF EXISTS ers_incidents_room_not_null;
ALTER TABLE ers_incidents
  ADD CONSTRAINT ers_incidents_room_not_null
  CHECK (conference_room IS NOT NULL OR status = 'QUEUED');

-- ── 3. Expand ers_queues.status to include CANCELLED and EXPIRED ────────────────
-- CANCELLED: caller hung up while waiting (Lua overflow_wait hangup detection).
-- EXPIRED:   swept out by the 2-hour safety cap in reconcileAllActiveIncidents.
ALTER TABLE ers_queues
  DROP CONSTRAINT IF EXISTS ers_queues_status_check;
ALTER TABLE ers_queues
  ADD CONSTRAINT ers_queues_status_check
  CHECK (status IN ('QUEUED', 'DEQUEUED', 'CANCELLED', 'EXPIRED'));

-- ── 4. One-time hygiene: cancel stale QUEUED rows and complete their incidents ──
-- Rows older than 2 hours with no matching live call are abandoned sessions.
UPDATE ers_queues
SET status = 'EXPIRED', updated_at = now()
WHERE status = 'QUEUED'
  AND created_at < now() - interval '2 hours';

UPDATE ers_incidents
SET status = 'COMPLETED', ended_at = now()
WHERE status = 'QUEUED'
  AND deleted_at IS NULL
  AND id NOT IN (SELECT incident_id FROM ers_queues WHERE status = 'QUEUED');

COMMIT;
