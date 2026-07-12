BEGIN;

-- Update ACTIVE incidents whose ERS configuration has bridge numbers configured,
-- so their conference_room reflects the bridge number that callers should dial
-- to rejoin (e.g. "7000" instead of "ers_cfg1_primary").
--
-- Only updates rows where the current room still uses the old deterministic
-- pattern (ers_cfg<id>_<tier>) AND the configuration now has a bridge number.
-- Already-correct rows and COMPLETED/QUEUED rows are untouched.

UPDATE ers_incidents i
SET conference_room = ec.primary_bridge_number::text
FROM ers_configurations ec
WHERE i.ers_configuration_id = ec.id
  AND i.status = 'ACTIVE'
  AND i.group_type = 'primary'
  AND i.deleted_at IS NULL
  AND ec.primary_bridge_number IS NOT NULL
  AND i.conference_room = 'ers_cfg' || ec.id::text || '_primary';

UPDATE ers_incidents i
SET conference_room = ec.secondary_bridge_number::text
FROM ers_configurations ec
WHERE i.ers_configuration_id = ec.id
  AND i.status = 'ACTIVE'
  AND i.group_type = 'secondary'
  AND i.deleted_at IS NULL
  AND ec.secondary_bridge_number IS NOT NULL
  AND i.conference_room = 'ers_cfg' || ec.id::text || '_secondary';

COMMIT;
