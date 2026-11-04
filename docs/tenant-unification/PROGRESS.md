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
