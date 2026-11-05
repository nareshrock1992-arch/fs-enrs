-- Migration 050: backfill ers_incidents.tenant_id for incidents stored without a tenant.
--
-- The overflow-queue insert (POST /internal/ers/overflow/enqueue) omitted tenant_id,
-- so queued incidents had tenant_id NULL and were hidden from their tenant's ERS
-- reports and lists (which scope by i.tenant_id). The insert now writes the
-- configuration's tenant; this migration repairs existing rows.
--
-- Rule: only rows with tenant_id IS NULL are touched, and the tenant is taken from
-- the incident's own ERS configuration (never guessed). Rows whose configuration has
-- no tenant are left unchanged and reported.
-- Idempotent: a second run matches no rows.

BEGIN;

DO $$
DECLARE
  n_before  INTEGER;
  n_fixed   INTEGER;
  n_left    INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_before FROM ers_incidents WHERE tenant_id IS NULL;

  UPDATE ers_incidents i
     SET tenant_id = c.tenant_id
    FROM ers_configurations c
   WHERE c.id = i.ers_configuration_id
     AND i.tenant_id IS NULL
     AND c.tenant_id IS NOT NULL;
  GET DIAGNOSTICS n_fixed = ROW_COUNT;

  SELECT COUNT(*) INTO n_left FROM ers_incidents WHERE tenant_id IS NULL;

  RAISE NOTICE '[050] ers_incidents with NULL tenant: before=%, backfilled=%, still NULL=%',
    n_before, n_fixed, n_left;
  IF n_left > 0 THEN
    RAISE NOTICE '[050] % incident(s) left NULL: their configuration has no tenant_id or no longer exists (not guessed).', n_left;
  END IF;
END $$;

COMMIT;
