-- IVR Tenant Diagnostic + Data Repair Script
-- Run on India server: psql -U enrs -d enrs_db -f docs/ivr_tenant_repair.sql
-- STEP 1 is read-only. Review its output before running STEP 2.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: READ-ONLY DIAGNOSTICS
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== TENANTS ==='
SELECT id, name, code FROM tenants ORDER BY id;

\echo ''
\echo '=== USERS with tenant linkage ==='
SELECT u.id, u.email, u.role, u.tenant_id, t.name AS tenant_name
FROM users u
LEFT JOIN tenants t ON t.id = u.tenant_id
WHERE u.deleted_at IS NULL
ORDER BY u.id;

\echo ''
\echo '=== ALL ivr_flows (including NULL tenant) ==='
SELECT
  f.id,
  f.flow_uuid,
  f.name,
  f.tenant_id,
  f.is_active,
  f.deleted_at,
  f.last_deployment_status,
  COUNT(v.id) AS version_count
FROM ivr_flows f
LEFT JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
GROUP BY f.id, f.flow_uuid, f.name, f.tenant_id, f.is_active, f.deleted_at, f.last_deployment_status
ORDER BY f.id;

\echo ''
\echo '=== NULL-tenant flows (invisible to any user) ==='
SELECT id, flow_uuid, name, created_at
FROM ivr_flows
WHERE tenant_id IS NULL AND deleted_at IS NULL;

\echo ''
\echo '=== emergency_numbers bound to IVR flows ==='
SELECT en.id, en.number, en.type, en.ivr_flow_id, en.tenant_id, en.is_active, en.deleted_at
FROM emergency_numbers en
WHERE en.type = 'IVR' OR en.ivr_flow_id IS NOT NULL
ORDER BY en.id;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: DATA REPAIR — uncomment and run ONLY after reviewing STEP 1 output
--
-- Replace <TENANT_ID> with the actual tenant id from STEP 1 output.
-- Only repairs non-deleted flows that currently have NULL tenant_id.
-- ─────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- UPDATE ivr_flows
-- SET    tenant_id = <TENANT_ID>
-- WHERE  tenant_id IS NULL
--   AND  deleted_at IS NULL;
--
-- -- Verify: should return 0 rows after the update
-- SELECT id, flow_uuid, name FROM ivr_flows WHERE tenant_id IS NULL AND deleted_at IS NULL;
--
-- COMMIT;
-- -- (ROLLBACK; if the verification query returns rows you didn't expect)
