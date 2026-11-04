# Task: Unify `organization_id` into `tenant_id` across fs-enrs (autonomous)

You are working autonomously in the **fs-enrs** repository. Work through every phase below without stopping to ask, except at the explicit STOP gates. Keep a running log in `docs/tenant-unification/PROGRESS.md`: append what you did, what you found, and what's next after every phase, so the work can be resumed if the session ends.

## Context

- Stack: Node.js/Express backend (`backend/`), React/Vite frontend (`frontend/`), PostgreSQL database `fs_enrs`, FreeSWITCH integration (ESL, generated dialplan XML, Lua scripts) driven by a visual IVR Builder.
- Read DB credentials from `backend/.env`. Never print, log or commit passwords, hashes or tokens.
- The `fs-cp` integration repo syncs fs-enrs into Docker images shipped to customers. Every DB change must therefore ship as an **idempotent migration**, not as manual SQL.
- **The bug that triggered this:** an ERS configuration (`ers_configurations.id = 73`, `tenant_id = 1`) does not appear in the IVR Builder's **ERS Ring All** node dropdown for the ADMIN user (`users.tenant_id = 1`). `ers_configurations` has both `tenant_id` (nullable) and `organization_id` (NOT NULL). `users` has only `tenant_id`. There is no `tenants` or `organizations` table. Hypothesis: some queries scope by `organization_id` while users and JWTs only carry `tenant_id`, so the two have drifted.
- **Target model:** one organization = one tenant. `tenant_id` is the single source of truth for scoping. `organization_id` is removed, after a compatibility period.

## Rules

- Work on a new git branch `fix/tenant-unification`. Commit in small, logical steps with clear messages. Do not push and do not merge.
- Before any DB change, take a backup: `pg_dump -Fc fs_enrs > ~/fs_enrs_backup_<timestamp>.dump`. Record the path in PROGRESS.md.
- Only touch the dev/test database configured in `backend/.env`.
- Never take tenant identity from a request body or query string. In HTTP requests it comes from the authenticated user (JWT/`req.user`). In call handling it comes from the called number or DID.
- **STOP gates** (pause and report before doing these):
  1. after the investigation report and plan are written (Phase 3);
  2. before any `DROP COLUMN` or destructive migration;
  3. before restarting any FreeSWITCH or service that is handling live calls.

## Phase 1: Investigation (read-only)

1. **DB inventory.** Using `information_schema`, list every table with `tenant_id` and/or `organization_id`, plus their nullability, defaults, indexes, unique constraints, foreign keys, views and functions that reference them. For each table, report the row count and the drift count:
   `COUNT(*) FILTER (WHERE organization_id IS DISTINCT FROM tenant_id)`, plus counts of NULL `tenant_id` and NULL `organization_id`.
2. **Code inventory.** Grep `backend/`, `frontend/`, migrations, seeds, scripts, Lua files, dialplan/XML templates, Dockerfiles and SQL files for `organization_id`, `organizationId`, `org_id`, `orgId`, `tenant_id`, `tenantId` and `tenant`. Classify every hit as one of:
   - READ-FILTER (WHERE clause or scoping)
   - INSERT/UPDATE (writing the value)
   - AUTH (JWT payload, middleware, `req.user`)
   - RUNTIME (FreeSWITCH, Lua, ESL, call handling, incidents)
   - UI (API params, state, display)
   - SCHEMA (migrations, seeds)
   - OTHER
3. **Auth path.** Document exactly what the JWT payload contains, what the auth middleware attaches to `req.user`, which roles exist, and whether any role (e.g. SUPER_ADMIN) bypasses tenant scoping today.
4. **Runtime path, which is critical.** Trace how a live emergency call resolves its tenant/config: the dialed number → `emergency_numbers` → `ers_configurations` → responder groups → conference/incident creation. These code paths have no logged-in user. Document every lookup that uses `organization_id`, including inside Lua scripts and generated XML.
5. **Root cause of the Ring All bug.** Identify the exact endpoint, query and frontend code the ERS Ring All node uses to load its dropdown. Explain precisely why config 73 is excluded. Confirm by calling the endpoint with curl, using a token from a login.

## Phase 2: Impact analysis

Write `docs/tenant-unification/INVESTIGATION.md` containing:
- the DB and code inventories, as tables;
- the root cause of the Ring All bug, with file:line references;
- an **impact matrix**: for each affected area (auth, every API resource, IVR Builder node pickers, flow publish/XML/Lua generation, incident lifecycle, responders/groups, recordings, reports, seeds, migrations, fs-cp Docker build, existing customer databases), list what changes, the risk level, and how to verify it;
- the risks specific to an emergency system: calls routed to the wrong tenant's responders, configs disappearing from call routing, and broken incident reconciliation.

## Phase 3: Plan, then STOP gate 1

Write `docs/tenant-unification/PLAN.md` with ordered, independently verifiable steps covering at least:
1. **Migration A (additive, safe):** backfill `tenant_id` from `organization_id` where `tenant_id` is NULL, and `organization_id` from `tenant_id` where they differ. Report conflicts that cannot be auto-resolved instead of guessing. Make `tenant_id` NOT NULL. Add indexes on `tenant_id` mirroring the existing `organization_id` indexes and unique constraints.
2. **Optional: create a `tenants` table** (id, name, slug, is_active, timestamps), seed it from the distinct `tenant_id` values, and add foreign keys.
3. **Code changes:** all READ-FILTERs scope by `tenant_id` from `req.user`. All INSERTs set `tenant_id` from `req.user` and, during the compatibility period, write `organization_id = tenant_id`. Runtime and Lua lookups use `tenant_id`. Frontend stops sending or relying on organization IDs.
4. **Centralize scoping** in one helper or middleware (e.g. `tenantScope(req)`) instead of ad-hoc WHERE clauses, so this can't drift again.
5. **IVR node pickers** (Ring All and all others) are scoped to the **flow's** `tenant_id`. A flow must never reference another tenant's config. Validate this on flow save and publish on the backend, not only in the UI.
6. **Role model:** propose `SUPER_ADMIN` with an explicit tenant switcher (the active tenant goes in the session or JWT). Do not show a mixed cross-tenant list. ADMIN stays tenant-scoped. Implement this only if it is small and isolated; otherwise list it as a follow-up.
7. **Migration B (destructive, later):** convert `organization_id` to `GENERATED ALWAYS AS (tenant_id) STORED` or drop it, after all code is migrated (STOP gate 2).
8. **Rollback plan** for each step.

**STOP:** send a short summary of the root cause, the impact matrix highlights and the plan. Wait for approval before Phase 4.

## Phase 4: Implementation

Execute PLAN.md step by step, one commit per step. After each step, run the existing tests and lint and fix anything you broke. Add tests where none exist for:
- tenant scoping on the ERS configurations list/get/create/update endpoints;
- the Ring All picker returning tenant-1 configs for a tenant-1 user, and none from other tenants;
- an insert ignoring any `tenant_id`/`organization_id` sent in the request body;
- flow publish rejecting a cross-tenant config reference.

All migrations must be idempotent (safe to run twice) and transactional, and they must work on a fresh DB and on an existing customer DB.

## Phase 5: Verification

1. Run the migrations against the dev DB and re-run the Phase 1 drift query. Drift must be 0 and there must be no NULL `tenant_id`.
2. Restart the backend. Log in as `admin@enrs.local` and confirm that `Test_ERS` (id 73) appears in the ERS Ring All dropdown, both through the API with curl and, if a browser is available, in the UI.
3. Publish an IVR flow that uses Ring All with `Test_ERS`. Diff the generated dialplan XML and Lua against the pre-change output; only the intended changes may differ.
4. Check the call path end to end as far as possible without live calls (simulate via ESL or the dev FreeSWITCH if safe; STOP gate 3 applies).
5. Create a second test tenant with its own user and config, and verify complete isolation in both directions.

## Phase 6: Report

Update PROGRESS.md and write `docs/tenant-unification/SUMMARY.md` covering: root cause, what changed (files and migrations), test results, verification evidence, anything deferred (Migration B, SUPER_ADMIN switcher), and exact steps to roll this out through fs-cp to customer instances.
