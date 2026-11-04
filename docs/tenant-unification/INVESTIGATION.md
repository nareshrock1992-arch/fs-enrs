# Tenant unification — Investigation (Phases 1–2)

Date: 2026-11-04 · Branch: `fix/tenant-unification` (from `98fa2c3`) · Read-only. No DB or code changes.

Evidence sources:
- the WSL dev DB `fs_enrs` (every session forced `default_transaction_read_only=on`; no credentials printed);
- the dev backend on `127.0.0.1:4100`, logged in as `admin@enrs.local`;
- the repository at `98fa2c3`.

## 0. Headline: the task's premise does not match this codebase

The brief assumes:
- there is no `tenants` or `organizations` table;
- `organization_id` and `tenant_id` are two names for the same thing;
- the Ring All bug is caused by `organization_id` drift.

All three are false here:

| Brief assumption | Reality (schema.sql + live DB) |
|---|---|
| No `tenants` / `organizations` table | Both exist. `tenants(id, name, code, is_active, …)` and `organizations(id, tenant_id → tenants, name, code, is_system, …)`. |
| `organization_id` ≡ `tenant_id` | They are **different entities with different id spaces**. `organization_id` → `organizations.id`, `tenant_id` → `tenants.id`. An organization belongs to a tenant via `organizations.tenant_id`. A tenant may own several organizations. |
| Drift = `organization_id IS DISTINCT FROM tenant_id` | That comparison is meaningless: it compares ids from two tables. The real consistency rule is `row.tenant_id = organizations[row.organization_id].tenant_id`. On this DB the ids coincide (tenant 1, org 1) only by chance. |
| Config 73 excluded because of `organization_id` | The list endpoint already scopes by `tenant_id` from the JWT and returns config 73 to the ADMIN (see §5). |

**Consequence:** Migration A as written must not run. The step "backfill `tenant_id` from `organization_id`" would write an organization id into a tenant column. On any customer DB where org ids ≠ tenant ids, that silently re-homes configurations, numbers and flows to a different tenant, or to a nonexistent one. In an emergency system that means calls routed with another tenant's configuration, and configs vanishing from scoped lists. The project's own migrations 011 and 013 already use the correct derivation, through `organizations.tenant_id`.

## 1. DB inventory (live dev DB)

### 1.1 Entities
- **Tenants:** 1 row (id 1, "Default Tenant", DEFAULT).
- **Organizations:** 1 row (id 1, tenant 1, "Default Organization", `is_system = true`).
- **Users:**
  - `admin@enrs.local` is ADMIN, tenant 1.
  - `superadmin@enrs.local` is SUPER_ADMIN, tenant NULL. That is by design for SUPER_ADMIN.
- **`tenant_mappings`:** defined in `schema.sql` but **absent from the live DB**, which is schema drift. No code reads it.

### 1.2 Columns, nullability, foreign keys

| Table | tenant_id | organization_id | FK tenant → tenants | FK org → organizations |
|---|---|---|---|---|
| ers_configurations | NULL ok | NOT NULL | SET NULL | CASCADE |
| ens_configurations | NULL ok | NOT NULL | SET NULL | CASCADE |
| emergency_numbers | NULL ok | NULL ok | SET NULL | SET NULL |
| ivr_flows | NULL ok | NULL ok | SET NULL | CASCADE |
| media_files | NULL ok | NULL ok | SET NULL | SET NULL |
| organizations | NULL ok | — | SET NULL | — |
| users, recordings, ers_incidents | NULL ok | — | SET NULL | — |
| sip_gateways, ers_playback_lines, config_versions, config_audit_log | NULL ok | — | CASCADE | — |
| emergency_contacts, responder_groups, departments, locations, ers_responders, ers_responder_groups | — (**none**) | NOT NULL | — | CASCADE |
| ens_campaigns | — | NULL ok | — | SET NULL |

Notes:
- Six tables (contacts, responder groups, departments, locations and others) have **only** `organization_id`. Their tenant is reachable only through the organization. Dropping `organization_id` would leave them with no tenant at all.
- Indexes: `idx_*_org` and `idx_*_tenant` partial indexes exist on the config tables (`schema.sql:272-273, 356-357, 424-425, 461`).
- No views or functions reference `organization_id`.

### 1.3 Drift and NULL counts

Drift is measured with the correct rule: tenant compared through the organization.

| Table | Rows | NULL tenant | NULL org | Drift (tenant ≠ org.tenant) | Naive id mismatch (brief's query) |
|---|---|---|---|---|---|
| ers_configurations | 1 | 0 | 0 | 0 | 0 |
| ens_configurations | 0 | 0 | 0 | 0 | 0 |
| emergency_numbers | 3 | 0 | 0 | 0 | 0 |
| ivr_flows | 17 | 12 | 12 | 0 | 0 |
| media_files | 342 | 0 | 342 | 0 | **342 (false positive)** |
| ers_incidents | 15 | **7** | — | — | — |
| recordings | 11 | 0 | — | — | — |
| users | 2 | 1 (SUPER_ADMIN, intended) | — | — | — |

- **ivr_flows:** the 12 NULL-tenant flows are all deleted "Temp Delete Flow" test residue. All 5 live flows are tenant 1.
- **media_files:** the brief's query flags all 342 rows only because `organization_id` is NULL while `tenant_id` is set. That is correct data, not drift.
- **ers_incidents:** the 7 NULL-tenant incidents are a real defect (§5.2).

## 2. Code inventory (non-test, `organization_id|organizationId|org_id|orgId`)

| File | Hits | Classification | Notes |
|---|---|---|---|
| routes/v1/reports.js | 47 | READ-FILTER, UI | Optional `org_id` filter **inside** a `tenant_id` scope; org name display |
| controllers/organizationController.js | 23 | INSERT/UPDATE, READ-FILTER | CRUD of the organizations entity itself (tenant-scoped) |
| controllers/contactController.js | 23 | READ-FILTER, INSERT | Contacts are org-owned; tenant via `o.tenant_id` |
| controllers/ersController.js | 20 | READ-FILTER (optional), INSERT, UI | `listConfigurations` scopes by `e.tenant_id = effectiveTenantId(req)`; org is an **optional extra filter** from `?organization_id` |
| controllers/serviceController.js | 18 | INSERT/UPDATE, READ-FILTER | `:145` "organization_id is never used to derive or override the caller's tenant" |
| controllers/groupController.js | 12 | READ-FILTER, INSERT | Responder groups are org-owned |
| controllers/ensController.js | 11 | READ-FILTER (optional), INSERT | Same pattern as ERS |
| controllers/deploymentController.js | 9 | READ-FILTER (optional), INSERT | Media list/upload |
| controllers/ivrController.js | 6 | READ-FILTER (optional), INSERT | Flow create stores `tenant_id` from the JWT, `organization_id` optional |
| services/campaignEngine.js | 5 | RUNTIME | `:842-857, :991-1003`: copies `emergency_numbers.organization_id` onto the campaign row (attribution only; no scoping) |
| controllers/internal/ersInternalController.js | 1 | RUNTIME | `:193` returns `en.organization_id` in the lookup payload (not a filter) |
| controllers/recordingController.js, media.js, mediaLibraryController.js, dashboardController.js, campaignController.js, monitoringController.js | 1–4 each | READ-FILTER (optional), UI | |
| validators/ivrValidator.js | 1 | OTHER | optional `organization_id` on flow create |
| frontend pages (ErsConfigList, EnsList, ContactList, GroupList, LocationList, DeptList, ServiceRegistry, IvrList), api/client.js | 2–11 each | UI | Org dropdowns / filters |
| db/schema.sql, migrations 001, 002, 004, 005, 008, 010–013, 028; validateSchema.js; scripts | — | SCHEMA | 011/013 backfill tenant **through** `organizations.tenant_id` |
| Lua, dialplan XML, Dockerfiles | **0** | — | No `organization_id` or `tenant_id` in generated or runtime FreeSWITCH files |

`tenant_id` is the established scoping key throughout, via the central helper `backend/src/middleware/tenantScope.js`:
- `effectiveTenantId` (`:58`), `callerTenantId`, `requireTenantScope`, plus a write helper.
- Tenant-isolation unit tests already exist: `tenantIsolation`, `conferenceTenantIsolation`, `socketTenantIsolation`, `mediaTenantIsolation`, `ivrTrustBoundaries`.

## 3. Auth path
- **JWT payload** (decoded from a real login): `{ id, email, role, tenantId, iat, exp }`.
- **`requireAuth`** (`middleware/auth.js`) attaches `req.user = { id, email, role, tenantId }`. It fails closed: a non-SUPER_ADMIN identity without a tenant is rejected (`auth.js:17-19`, `hasTenantContext`).
- **Roles:** SUPER_ADMIN (migration 044), ADMIN, SUPERVISOR, OPERATOR, VIEWER.
- **SUPER_ADMIN bypass:** `effectiveTenantId` returns `?tenant_id` or body `tenant_id` when given, else **NULL, which means all tenants (a mixed list)**. Every other role gets the JWT tenant.
  - This conflicts with the brief's rule "never take tenant identity from a request body or query string". The conflict is limited to SUPER_ADMIN and is deliberate in the existing design.
  - The brief's proposed tenant switcher would replace it.

## 4. Runtime path (no logged-in user)
1. The dialled number goes to `GET /internal/ers/lookup?number=` (`ersInternalController.js:~160-215`). It selects from `emergency_numbers en JOIN ers_configurations ec ON ec.id = en.ers_configuration_id WHERE en.number = $1 AND en.type = 'ERS' AND active`.
   - The number is **globally unique**, so the tenant is implied by the number and config.
   - No `organization_id` filter. `en.organization_id` is only echoed in the payload.
2. Ring All: `POST /internal/ers/ring-all { configuration_id }`. It loads `ers_configurations` (incl. `tenant_id`), checks responders through `ers_tier_groups` → `responder_group_members` → `emergency_contacts`, then `INSERT ers_incidents (…, tenant_id = cfg.tenant_id)` (`:972-977`).
3. Classic conference: `INSERT ers_incidents (…, tenant_id = cfg.tenant_id)` (`:328-334`; UI path `ersController.js:610`).
4. **Overflow queue: `POST /internal/ers/overflow/enqueue`** (`ersInternalController.js:1126-1137`). `INSERT ers_incidents (incident_uuid, ers_configuration_id, status, caller_number, caller_name, group_type, started_at, queued_at)` **omits `tenant_id`**. See §5.2.
5. Lua and generated XML: no tenant or organization lookups. The IVR executor passes `configuration_id` from the published graph. Tenant safety of that id is enforced at **publish** time by `validateGraph` (`utils/ivrGraphValidator.js:373-401`, `… AND tenant_id = $2`).

## 5. Root causes

### 5.1 Ring All dropdown missing `Test_ERS` (#73): not reproducible, and not tenant scoping
- **Dropdown data path:**
  - `PropertyPanel.jsx:619` → `ConfigPicker` (`:256`) → `useConfigOptions('ers')` (`hooks/useConfigOptions.js:11-29`) → `api.ers.list({ limit: 1000 })` → `GET /api/v1/ers/configurations` → `ersController.listConfigurations` (`:173-215`).
  - The SQL scopes by `($4::int IS NULL OR e.tenant_id = $4)` with `effectiveTenantId(req)`. The org filter applies only if `?organization_id` is sent, and the picker never sends it.
- **Live check (curl, as admin):** `GET /ers/configurations?limit=1000` → HTTP 200, `total = 1`, `configurations = [{ id: 73, name: "Test_ERS", tenant_id: 1, organization_id: 1 }]`.
- **The DB confirms the picker has worked:** live flow 173 `ERS_TEST_1222` already holds two `ers_ring_all` nodes with `ers_configuration_id = 73`.
- **Most likely causes of the earlier miss** (none involve `organization_id`):
  1. **Stale front-end cache.** `useConfigOptions` keeps a module-level cache "per page load" (`useConfigOptions.js:4-9, 12`). If the IVR Builder was opened before `Test_ERS` was created (2026-11-03 10:13), the dropdown keeps the old list until a full browser reload. Navigating inside the SPA does not refresh it.
  2. **The backend was running older code** at the time. The WSL checkout was switched between branches during this period.
  3. **Latent issue, not the cause here:** the list caps `limit` at 200 (`ersController.js:175`) while the picker asks for 1000, and the picker shows no truncation warning. Ordering is by name, so a tenant with more than 200 configs silently loses the later ones from the picker.

### 5.2 Confirmed tenant defect: overflow-queued incidents have no tenant
- **Data:** all 7 NULL-tenant incidents (ids 51–54, 59, 60, 63, config 73) have `queued_at` set. All 8 non-queued incidents have a tenant.
- **Cause:** `ersOverflowEnqueue` omits `tenant_id` from the INSERT (`ersInternalController.js:1131-1136`).
- **Effect:** ERS reports, lists and exports scope by `i.tenant_id = <user tenant>` (`reports.js:201, 227, 596, 835`), so the **ADMIN cannot see these 7 incidents**. This matches the screenshot showing "8 incidents". Tenant-scoped realtime emits for those incidents also carry no tenant.

### 5.3 Secondary findings
- **`validateGraph` checks against the caller's tenant** (`ivrController.js:166, 247, 264`: `effectiveTenantId(req)`), not the **flow's** `tenant_id`.
  - For ADMIN they are equal.
  - For SUPER_ADMIN without `?tenant_id`, the tenant is NULL and `tenant_id = NULL` matches nothing, so the check behaves differently. The brief's rule ("validate against the flow's tenant") is the right fix.
- `schema.sql` defines `tenant_mappings`, but the live DB lacks it. That is fresh-vs-upgrade schema drift, and nothing reads the table.

## 6. Impact matrix (of the corrected plan in PLAN.md)

| Area | Change | Risk | Verify |
|---|---|---|---|
| Auth / JWT | none | — | existing auth tests |
| ERS/ENS config APIs | none to scoping (already `tenant_id`); optional: honour the picker's limit or flag truncation | Low | list returns 73 for tenant 1, none for tenant 2 |
| IVR node pickers | refetch configs when the builder mounts (drop the stale cache) | Low (UI only) | create a config, open the builder without reload, see it |
| Flow save/publish | validate against `flow.tenant_id` instead of the caller's tenant | Low-Med (SUPER_ADMIN path changes) | cross-tenant reference rejected; same-tenant accepted |
| Generated XML/Lua | none | — | byte-diff of the deployment output before and after = empty |
| Incident lifecycle | overflow enqueue writes `tenant_id = cfg.tenant_id`; migration backfills NULL incident tenants from their config | Low (additive) | 0 NULL-tenant incidents; queued incidents visible to ADMIN |
| Responders/groups/contacts | none (org-owned, tenant through org) | — | — |
| Recordings | none (0 NULL) | — | — |
| Reports | none to code; the 7 hidden incidents become visible after the backfill | Low (**visible behaviour change**: counts rise) | ERS report shows 15 |
| Seeds | none | — | fresh-DB migrate |
| Migrations | new idempotent 050 (backfill incident tenant; optional consistency checks) | Low | run twice on fresh and on existing DB |
| fs-cp Docker build | picks up the new migration through `migrate.js` | Low | fs-cp image build + migrate log |
| Customer DBs | backfill only touches `ers_incidents.tenant_id IS NULL`, derived from the config | Low | pre/post counts in the migration NOTICE |
| **NOT done:** `organization_id := tenant_id` / drop `organization_id` | would corrupt scoping wherever org ids ≠ tenant ids, and orphan six org-only tables | **Critical** | — |

## 7. Emergency-system risks
- **Wrong-tenant routing:**
  - Today routing is by globally unique number → config. There is no org/tenant join, so there is no cross-tenant risk at call time.
  - The brief's Migration A *would introduce* that risk by rewriting `tenant_id`.
- **Configs disappearing from routing:**
  - The lookup requires `ec.is_active AND en.is_active AND not deleted`. Tenant is not involved.
  - Making `tenant_id` NOT NULL is safe only after verifying 0 NULLs. Otherwise the migration fails, and it fails before any data change.
- **Incident reconciliation:**
  - Hangup and ESL reconciliation key on `incident_uuid` / conference room, not on tenant.
  - The overflow tenant fix changes only visibility and scoping, not reconciliation.
