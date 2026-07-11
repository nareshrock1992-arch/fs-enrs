BEGIN;

-- ── 1. Show what we're about to touch ─────────────────────────────────────────
-- (Uncomment for debugging: SELECT id, status, conference_room, group_type
--   FROM ers_incidents WHERE conference_room IS NULL AND status = 'ACTIVE';)

-- ── 2. Backfill conference_room for ACTIVE incidents missing it ────────────────
-- COALESCE on group_type handles any rows where group_type is also NULL
-- (falls back to 'primary' — matches the default tier in ersRingAll).
UPDATE ers_incidents
SET conference_room = 'ers_cfg' || ers_configuration_id::text
                      || '_' || COALESCE(group_type, 'primary')
WHERE status = 'ACTIVE'
  AND conference_room IS NULL
  AND deleted_at IS NULL;

-- ── 3. Enforce: only future ACTIVE rows must have a conference_room ────────────
-- Historical COMPLETED/QUEUED rows pre-dating room tracking may have
-- conference_room IS NULL — the constraint must not reject those.
-- Only status='ACTIVE' needs a non-null room going forward.
ALTER TABLE ers_incidents
  DROP CONSTRAINT IF EXISTS ers_incidents_room_not_null;
ALTER TABLE ers_incidents
  ADD CONSTRAINT ers_incidents_room_not_null
  CHECK (status != 'ACTIVE' OR conference_room IS NOT NULL);

-- ── 4. Expand ers_queues.status to include CANCELLED and EXPIRED ────────────────
ALTER TABLE ers_queues
  DROP CONSTRAINT IF EXISTS ers_queues_status_check;
ALTER TABLE ers_queues
  ADD CONSTRAINT ers_queues_status_check
  CHECK (status IN ('QUEUED', 'DEQUEUED', 'CANCELLED', 'EXPIRED'));

-- ── 5. One-time hygiene: expire stale QUEUED rows + complete their incidents ───
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
