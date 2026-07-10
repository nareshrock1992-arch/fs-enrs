-- Utility: find and soft-delete duplicate IVR flows
--
-- A "duplicate" is two or more flows with the same (tenant_id, name) that
-- have NEVER been deployed (last_deployment_status IS NULL AND
-- last_deployed_at IS NULL) AND have no number currently bound to them.
-- The most-recently-updated copy is kept; all older copies are soft-deleted.
--
-- Usage:
--   Step 1 — run the SELECT below to review what would be deleted.
--   Step 2 — if the list looks right, run the UPDATE block.

-- ── Step 1: List duplicate candidates ────────────────────────────────────────

SELECT
  f.id,
  f.flow_uuid,
  f.name,
  f.tenant_id,
  f.organization_id,
  f.created_at,
  f.updated_at,
  f.last_deployment_status,
  f.last_deployed_at,
  'WOULD DELETE' AS action
FROM ivr_flows f
WHERE f.deleted_at IS NULL
  AND f.last_deployment_status IS NULL
  AND f.last_deployed_at       IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM emergency_numbers en
    WHERE en.ivr_flow_id = f.id AND en.deleted_at IS NULL
  )
  AND (f.tenant_id, f.name) IN (
    SELECT tenant_id, name
    FROM   ivr_flows
    WHERE  deleted_at IS NULL
    GROUP BY tenant_id, name
    HAVING COUNT(*) > 1
  )
  AND f.id NOT IN (
    -- the "keeper": newest updated_at per (tenant_id, name)
    SELECT DISTINCT ON (tenant_id, name) id
    FROM   ivr_flows
    WHERE  deleted_at IS NULL
    ORDER BY tenant_id, name, updated_at DESC
  )
ORDER BY f.tenant_id, f.name, f.updated_at;

-- ── Step 2: Soft-delete the duplicates ───────────────────────────────────────
-- Run this only after reviewing Step 1.

/*
UPDATE ivr_flows
SET    deleted_at = now()
WHERE  deleted_at IS NULL
  AND  last_deployment_status IS NULL
  AND  last_deployed_at       IS NULL
  AND  NOT EXISTS (
    SELECT 1 FROM emergency_numbers en
    WHERE en.ivr_flow_id = ivr_flows.id AND en.deleted_at IS NULL
  )
  AND  (tenant_id, name) IN (
    SELECT tenant_id, name
    FROM   ivr_flows
    WHERE  deleted_at IS NULL
    GROUP BY tenant_id, name
    HAVING COUNT(*) > 1
  )
  AND  id NOT IN (
    SELECT DISTINCT ON (tenant_id, name) id
    FROM   ivr_flows
    WHERE  deleted_at IS NULL
    ORDER BY tenant_id, name, updated_at DESC
  );
*/
