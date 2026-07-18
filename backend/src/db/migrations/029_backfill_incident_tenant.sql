-- =============================================================================
-- Migration 029 — Backfill tenant_id on ers_incidents
--
-- ersCreateIncident previously omitted tenant_id from the INSERT, leaving all
-- existing rows with tenant_id = NULL. The reports API filters by tenant_id,
-- so every historical incident was invisible in the ERS Reports page.
--
-- This migration derives tenant_id from the joined ers_configurations row,
-- which is the authoritative source used by the fixed INSERT path.
-- =============================================================================

BEGIN;

UPDATE ers_incidents i
SET tenant_id = ec.tenant_id
FROM ers_configurations ec
WHERE i.ers_configuration_id = ec.id
  AND i.tenant_id IS NULL
  AND i.deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('029_backfill_incident_tenant.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
