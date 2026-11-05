# Tenant unification — Progress log

## 2026-11-04 — Phases 1–3 (investigation, impact, plan) — STOP gate 1

**Done**
- Created branch `fix/tenant-unification` from `98fa2c3`. Not pushed.
- DB inventory on the WSL dev DB, read-only (sessions forced `default_transaction_read_only=on`; credentials sourced inside the process, never printed). **No DB changes, so no backup taken yet.** A backup is required before Step 1's migration.
- Code inventory, auth path, runtime path traced.
- Ring All endpoint called with curl as `admin@enrs.local`.

**Found**
- The brief's premise does not hold:
  - `tenants` and `organizations` both exist;
  - `organization_id` → `organizations.id` is a different id space from `tenant_id`;
  - the drift query compares unrelated ids (342 false positives on `media_files`).
- Ring All picker: the API returns `Test_ERS` (#73) to the ADMIN, scoped by `tenant_id`, and live flow 173 already uses #73. The earlier miss is most likely the page-load cache in `useConfigOptions`, or stale backend code. It is not caused by `organization_id`.
- **Real defect:** the overflow-queue insert omits `tenant_id`. 7 queued incidents have a NULL tenant and are hidden from the ADMIN's ERS reports (8 visible of 15).
- Secondary findings:
  - `validateGraph` uses the caller's tenant, not the flow's;
  - the picker silently caps at 200;
  - `tenant_mappings` is in `schema.sql` but missing from the live DB.

**Next:** waiting for approval of PLAN.md Part 1 (Steps 1–5) and a decision on Part 2 (collapsing organizations into tenants).

## 2026-11-05 — Part 1, Steps 1–4 implemented (Step 5 deferred by decision; nothing committed)

**Changes (uncommitted on `fix/tenant-unification`)**
- **Step 1:**
  - `ersInternalController.js`: the overflow enqueue INSERT writes `tenant_id = (SELECT tenant_id FROM ers_configurations WHERE id = $2)`.
  - New `050_ers_incident_tenant_backfill.sql`: backfills only NULL tenants, from the incident's own configuration; reports anything left; idempotent.
- **Step 2:** `frontend/src/hooks/useConfigOptions.js`:
  - refetches on every mount, showing the cached list until the new one arrives;
  - concurrent pickers share one request;
  - fetches every page (200 each) until `total` is reached.
- **Step 3:** `ivrController.js`: save, validate and publish check config references against `flow.tenant_id`. Flows without a tenant fall back to the old behaviour.
- **Step 4:** new tests:
  - `backend/src/__tests__/integration/tenantUnification.test.js` (11);
  - `frontend/src/__tests__/configOptions.test.js` (6).

**Evidence**
- New tests:
  - on the tree: 11/11 pass;
  - on HEAD (`cedf011`) with the same tests: TU-4 and both TU-5 tests fail, which shows they detect the bugs.
- Regression:
  - integration 271 tests, 216 pass, the same 7 failures as the baseline;
  - unit + Lua 1991 tests, the same 23 failures;
  - frontend 282/282; build OK; lint 0 errors.
- Generated output, built from HEAD and from the tree with the same DEV bindings:
  - executor Lua byte-identical;
  - dialplan XML (plain and nested) identical apart from the `Generated:` timestamp.
- DEV DB:
  - backup `/home/user/fs_enrs_backup_20261105_063622.dump` (pg_dump -Fc, 371,751 bytes);
  - migration 050 applied by `migrate.js`;
  - NULL-tenant incidents 7 → 0, tenant-1 incidents 8 → 15;
  - a second direct run of the SQL changed nothing (checksum unchanged);
  - the runner skips 050 on a re-run;
  - configs, flows, numbers and versions checksum unchanged.
- API, as `admin@enrs.local`: `/reports/ers` total = 15.

**Found, not fixed (out of scope):** ERS config create/update accepts any `organization_id` from the body without checking that the organization belongs to the caller's tenant.

**Security-hardening item SH-1 (future phase, separately approved):** validate `organization_id` against the caller's tenant on ERS configuration create/update (`ersController.js` `createConfiguration` / `updateConfiguration`), and review the same pattern on the ENS, IVR flow and media endpoints. It is deliberately not part of the Part 1 commit.

**Next:** waiting for review and commit approval. Step 5, deployment, Docker and customer DBs are not started.
