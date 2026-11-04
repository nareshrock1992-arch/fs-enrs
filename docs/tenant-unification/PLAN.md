# Tenant unification — Plan (Phase 3, awaiting approval at STOP gate 1)

Read with INVESTIGATION.md.

The brief's target ("organization = tenant; drop `organization_id`") rests on a premise that does not hold here:
- `organizations` is a real entity under `tenants`, with its own id space.
- Six tables are owned *only* through `organization_id`.

The brief's own STOP and approval rules apply here: `ARCHITECTURE.md` is frozen, and the zero-regression principle covers business behaviour. So this plan is split into two parts:
- **Part 1:** safe, approved-in-principle fixes for the defects actually found.
- **Part 2:** the organization → tenant collapse, which needs an explicit product decision.

Every step: one commit, existing unit + integration tests and lint re-run, and the failure baselines unchanged (unit + Lua 23, integration 7).

## Part 1 — Fix what is actually broken (recommended)

### Step 1. Overflow-queued incidents carry their tenant
- **Code:** `ersOverflowEnqueue` (`internal/ersInternalController.js:1131`) writes `tenant_id` taken from `ers_configurations.tenant_id`, selected inside the same transaction.
- **Migration `050_ers_incident_tenant_backfill.sql`:**
  - `UPDATE ers_incidents i SET tenant_id = c.tenant_id FROM ers_configurations c WHERE c.id = i.ers_configuration_id AND i.tenant_id IS NULL AND c.tenant_id IS NOT NULL;`
  - A `RAISE NOTICE` reports any incidents still NULL (orphan or NULL-tenant config) instead of guessing.
  - `BEGIN/COMMIT`, idempotent.
- **Tests:**
  - enqueue stores the config's tenant;
  - ADMIN sees queued incidents in the report and export.
- **Visible change:** the ERS report count for tenant 1 goes from 8 to 15. Recorded in `BEHAVIOUR_CHANGES.md`.
- **Rollback:**
  - revert the commit;
  - the backfill is harmless to keep. If needed, run `UPDATE … SET tenant_id = NULL WHERE id IN (<ids from the NOTICE>)`.

### Step 2. IVR config pickers always show current configs
- **Change:** `useConfigOptions` refetches when a picker mounts, or when the builder opens. Today it caches for the whole page load.
- **Truncation:** either request `limit: 200` and show a "showing first 200" hint when `total > 200`, or allow the picker 1000 on the list endpoint, decided in review. The current behaviour is a silent cap at 200.
- **Tests:** a frontend unit test for refetch; a backend test that the list honours the cap and reports `total`.
- **Rollback:** revert the commit (UI only).

### Step 3. Flow save/publish validates against the flow's tenant
- **Change:** in `ivrController.js:166, 247, 264`, pass `flow.tenant_id` to `validateGraph` instead of `effectiveTenantId(req)`. `deploymentEngine.js:289` already passes the flow's tenant.
- **Tests:**
  - publish rejects a cross-tenant `ers_configuration_id`;
  - same-tenant is accepted;
  - SUPER_ADMIN editing tenant-1's flow is validated against tenant 1.
- **Rollback:** revert the commit.

### Step 4. Tests the brief asked for that are missing
Add tests only where existing tenant-isolation suites don't already cover them:
- ERS config list/get/create/update are tenant-scoped;
- the picker endpoint gives tenant-1 configs to a tenant-1 user, and none from tenant 2;
- `tenant_id` / `organization_id` in a request body are ignored for non-SUPER_ADMIN.

No production code changes in this step.

### Step 5 (optional, additive). Make tenant consistency enforceable
- **Migration 051:** for `ers_configurations`, `ens_configurations` and `emergency_numbers`:
  - derive any NULL `tenant_id` through `organizations.tenant_id`, the same rule as 011/013;
  - **abort with a report** if a row has no derivable tenant, or `row.tenant_id ≠ org.tenant_id`;
  - then `SET NOT NULL` on `tenant_id`.
  - Live dev DB: 0 NULLs and 0 drift, so this is a no-op plus the constraint.
- **Not applied to:** `ivr_flows`, because of test-fixture flows with NULL tenant. Fix those fixtures first, then a later migration.
- **Not applied to:** `users`, where SUPER_ADMIN is NULL by design.
- **Rollback:** `ALTER … DROP NOT NULL`.
- **Before running:** `pg_dump -Fc` backup.

## Part 2 — Collapse organizations into tenants (NOT recommended now; needs a decision)

What the brief's Migration A/B would actually require, done correctly:
1. Decide what happens to tenants with more than one organization. Today the model allows it, and customer DBs may have it. Options are merge, split into tenants, or forbid.
2. Add `tenant_id` to the six org-only tables and backfill it through `organizations.tenant_id`.
3. Move every org-based read path to tenant-based. That covers contacts, groups, departments, locations, reports' `org_id` filter, and the UI org pickers.
4. Only then drop `organization_id` or make it generated. That is **destructive** (STOP gate 2) and touches `ARCHITECTURE.md` (frozen).

A generated `organization_id = tenant_id` column is **never** correct while `organizations.id` ≠ `tenants.id`.

## Role model (follow-up, not in Part 1)
- **Current:** SUPER_ADMIN has a NULL tenant and sees mixed cross-tenant lists unless `?tenant_id` is sent. It can target a tenant through query/body.
- **Proposed:** an explicit active-tenant switcher.
  - The selected tenant is carried in a re-issued JWT claim, `activeTenantId`, and `effectiveTenantId` reads only that claim.
  - With no tenant selected, lists return 400 "select a tenant" instead of mixed data.
- **Size:** medium. It touches auth refresh, the UI header and every SUPER_ADMIN test. Listed as a follow-up.

## Rollout through fs-cp
- Part 1 ships as normal code plus migration 050 (and 051 if approved).
- `migrate.js` applies them on container start, for both fresh and existing DBs.
- No FreeSWITCH or dialplan change, so no IVR redeploy is needed.
