-- =============================================================================
-- Migration 030 — Report Performance Indexes
--
-- Adds compound indexes for the tenant-scoped report queries introduced in the
-- enterprise reporting phase. The pattern:
--   WHERE i.tenant_id = $1 AND i.started_at >= $2 ORDER BY i.started_at DESC
-- cannot use idx_incident_tenant (single column) efficiently — it must then
-- filter and sort on started_at with a table scan over the tenant's rows.
--
-- Compound (tenant_id, started_at DESC) eliminates both the filter and sort.
-- =============================================================================

BEGIN;

-- ers_incidents: tenant + date range for /reports/ers summary and detail
CREATE INDEX IF NOT EXISTS idx_ers_incidents_tenant_started
  ON ers_incidents (tenant_id, started_at DESC)
  WHERE deleted_at IS NULL;

-- ens_notifications: tenant (via config join) already resolved at query time;
-- the direct tenant filter is on ens_configurations.tenant_id. Add an index on
-- ens_configurations for the tenant lookup so the join is fast.
CREATE INDEX IF NOT EXISTS idx_ens_configurations_tenant
  ON ens_configurations (tenant_id)
  WHERE deleted_at IS NULL AND is_active = true;

-- ers_incident_responders: incident_id lookups for report detail panel.
-- Already indexed from migration 001 (idx_responder_incident), confirmed present.

INSERT INTO schema_migrations (version) VALUES ('030_report_performance_indexes.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
