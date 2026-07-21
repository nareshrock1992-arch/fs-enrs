# Architectural Decision Log

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Reading This Document

Each entry is an Architectural Decision Record (ADR). The format is:

- **Status:** `FROZEN` | `ACTIVE` | `SUPERSEDED`
- **Context:** Why this decision was needed
- **Decision:** What was decided
- **Consequences:** What this enables or constrains
- **Alternatives considered:** What was rejected and why

`FROZEN` decisions cannot be changed without a formal architecture review and a new superseding ADR.

---

## ADR-001: Tenant = Security Boundary; Organization = UX Grouping

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

The codebase has two concepts that appear similar: `tenants` and `organizations`. Early code mixed their use as security boundaries, causing confusion about which ID to use when scoping queries and inserting records.

**Decision:**

- `tenant` = the security and isolation boundary. Every row that must be isolated from other customers belongs to a tenant. All access control, row-level filtering, and JWT claims use `tenant_id`. A tenant may belong to only one installation.
- `organization` = a UX grouping within a tenant. Organizations group users, locations, and departments for display purposes. They carry no security significance. Multiple organizations exist within one tenant.

A user belongs to one organization. An organization belongs to one tenant. A tenant has many organizations.

**Consequences:**

- `req.user.tenantId` (from JWT) is ALWAYS used for INSERT and WHERE clauses. Never `req.body.tenantId`.
- `organizationId` from the request body is permitted for INSERT into organization-scoped tables (e.g., adding a user to an org), but never as the security filter.
- New tables that store tenant-scoped data must have `tenant_id INT NOT NULL REFERENCES tenants(id)`. Not `org_id`.
- Cross-tenant queries are never written. Admin views that require cross-tenant data use a super-admin role with explicit tenant-switching.

**Alternatives considered:**

- Organization as security boundary: Rejected. Would require per-org isolation in every query. Tenant is the natural boundary for a B2B SaaS model.
- Merge tenant and organization: Rejected. Tenants are technical isolation units; organizations are business units. A hospital is a tenant. Its ICU department is an organization. These concepts are different.

---

## ADR-002: Dual ENS Tracking Model — `ens_campaigns` Is Authoritative Post-Wave 1

**Status:** ACTIVE  
**Date:** 2026-07-21

**Context:**

The ENS blast system was built twice, in different development phases. The original implementation writes to `ens_notifications` + `ens_notification_deliveries`. A later redesign created `ens_campaigns` + `ens_campaign_deliveries`. Both systems currently operate in parallel. Lua scripts trigger both. Some code reads from one; other code reads from the other.

This is F1 Critical — a dual-write state that makes it unclear which table is authoritative.

**Decision:**

After Wave 1 migration is complete:
- `ens_campaigns` + `ens_campaign_deliveries` are the authoritative blast tracking tables
- `ens_notifications` + `ens_notification_deliveries` are retained (not dropped) as historical record until a defined data retention policy decides their fate
- All new code reads from `ens_campaigns` only
- Reporting uses `ens_campaigns` for all records with `created_at >= Wave1DeployDate`; legacy tables for earlier records

The `ens_blast_trigger.lua` Lua script is updated in Wave 1 to call `POST /internal/ens/campaign/start` exclusively — not both paths.

**Consequences:**

- Wave 1 must confirm exactly what both Lua scripts write to before any code changes
- Any campaign reporting built before Wave 1 must be tested post-Wave 1 to confirm data source is correct
- The legacy tables must not be dropped until reporting migration is confirmed complete

**Alternatives considered:**

- Keep both systems as parallel: Rejected. Dual-write systems accumulate divergence bugs. One must be authoritative.
- Drop `ens_notifications`: Rejected. Contains historical data. Additive-only migration policy prevents destructive drops.

---

## ADR-003: Provider Isolation Principle

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

Business modules (ENS, ERS, IVR) were calling `eslService.js` directly and constructing FreeSWITCH-specific `bgapi originate {vars}dialString &conference(...)` strings. This made business logic tightly coupled to one specific provider and untestable without a running FreeSWITCH instance.

**Decision:**

> Business modules must never depend on provider-specific concepts or transport-specific identifiers.

Specifically prohibited in business module code:
- `bgapi` or `api originate` commands
- FreeSWITCH dial string format (`sofia/gateway/...`, `user/...`, `&conference(...)`)
- Channel variable names (`origination_caller_id_number`, `ignore_early_media`, etc.)
- FreeSWITCH hangup cause strings (`NORMAL_CIRCUIT_CONGESTION`, `USER_BUSY`, etc.)
- FreeSWITCH UUID format assumptions
- Direct imports of `eslService.js` from any business module

Business modules submit `CommunicationRequest` objects to the Outbound Router (Wave 1) or Communication Engine (Wave 3) and receive standard status events.

**Consequences:**

- `ersRingService.js` must be refactored in Wave 1 to remove inline `bgapi originate` (currently the only critical violation)
- `campaignEngine.js` must be refactored in Wave 1 to use standard disconnect codes
- All hangup cause handling in business modules uses the standard code vocabulary from `CommunicationEngine.md`
- Testing business modules no longer requires a running FreeSWITCH instance

**Alternatives considered:**

- Wrapper functions in ESL service: Rejected. The wrapper would still expose FS-specific concepts (dial string format, channel variables). The Provider interface is the correct abstraction level.

---

## ADR-004: Wave Completeness Rule

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

Development in earlier phases left temporary code paths, half-implemented abstractions, and `// TODO: Wave N` comments that never got cleaned up. This created production risk and made the codebase difficult to reason about.

**Decision:**

Each wave must leave the platform in a production-ready state:
- No partially completed abstractions
- No temporary code paths
- No `TODO: Wave N+1` comments in committed code
- No feature flags for half-implemented features that are on by default
- Every wave is independently deployable, fully tested, and reversible

A wave is complete when:
1. All unit and integration tests pass
2. The wave's migration runs on a copy of production data without error
3. The previous application version runs without error against the new schema
4. The monitoring dashboard shows no unexpected errors after deployment
5. All items in the pre-deployment checklist in `MigrationStrategy.md` are checked

**Consequences:**

- Waves cannot be split into "Phase A" and "Phase B" unless both phases independently satisfy the completeness criteria
- A bug found in Wave 1 implementation must be fixed before Wave 2 begins
- "Technical debt" items that affect correctness are bugs, not backlog items

---

## ADR-005: Additive-Only Schema Changes

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

Destructive schema changes (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN TYPE`, `RENAME COLUMN`) break the previous application version's ability to run against the new schema. This violates the Wave Completeness Rule (ADR-004) because rollback becomes impossible.

**Decision:**

All database migrations are additive only:
- `ADD COLUMN IF NOT EXISTS` with `DEFAULT NULL` or a safe non-null default
- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `ADD CONSTRAINT IF NOT EXISTS` (or via `ON CONFLICT DO NOTHING`)

Removing a column requires:
1. Deploy an application version that stops reading/writing the column
2. Wait until the application version is stable across all environments
3. Then add a migration that `DROP COLUMN` — at this point, the column is invisible to application code and the drop is safe

**Consequences:**

- Schema accumulates deprecated columns over time (see F7, F8, F9 in architecture review)
- Cleanup migrations are written last, not first
- The `recordings.campaign_id` UUID column (F9) cannot be removed until a two-phase approach completes

---

## ADR-006: `dialResolver.js` Contract Is Frozen

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

`dialResolver.js` is the single function that translates routing intent into a FreeSWITCH dial string. Multiple services call it. Changing its resolution priority order would change call routing behavior silently.

**Decision:**

The gateway resolution priority order in `dialResolver.js` is frozen:
1. Explicit `gatewayId` (FK lookup)
2. Explicit `gatewayName` (name lookup, raw fallback)
3. Contact's own `emergency_contacts.gateway_id`
4. Tenant's `is_default_outbound` gateway
5. No gateway → `user/<extension>` (FreeSWITCH internal)

**Changes to routing behavior** must come through Wave 5's `gateway_routes` table (per-tenant routing rules) — not by modifying `dialResolver.js`.

**Exceptions:** Bug fixes to `dialResolver.js` that correct an incorrect implementation of the above priority order are permitted.

---

## ADR-007: IVR Flow Versioning Is Immutable

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

IVR flows in production must be stable. A change to a live flow while callers are mid-session would cause undefined behavior.

**Decision:**

Published flow versions are immutable. `ivr_flow_versions.graph_snapshot` is set at publish time and never modified. A deployment always references a specific version ID.

To change a deployed IVR:
1. Edit the live `ivr_flows.nodes` JSONB
2. Publish a new version (creates a new `ivr_flow_versions` row)
3. Deploy the new version (generates new Lua file, updates dialplan)

The old Lua file remains on disk until explicitly removed (safe — the dialplan no longer references it).

**Consequences:**

- `ivr_flow_versions` grows monotonically — no cleanup needed unless disk space becomes a concern
- Rollback is trivially possible: deploy the previous version ID
- Canary/A-B testing of IVR flows is possible by assigning different phone numbers to different version deployments

---

## ADR-008: Internal API Is a Lua Contract

**Status:** FROZEN  
**Date:** 2026-07-21

**Context:**

FreeSWITCH Lua scripts use `io.popen(curl ...)` to call the Node.js backend. These scripts cannot be updated atomically with the backend — they are deployed to the FreeSWITCH filesystem and may lag the backend by a deployment cycle.

**Decision:**

The `/api/v1/internal/*` endpoints form a versioned contract with Lua scripts. Breaking changes to these endpoints require:
1. A backward-compatible transitional version
2. Lua scripts updated and deployed to FreeSWITCH
3. Only then, the old endpoint variant deprecated

The contract includes:
- Endpoint paths (never rename without a versioned alias)
- Response field names (never rename without adding the new name alongside the old)
- Required request parameters (adding optional parameters is safe)

**Consequences:**

- `GET /internal/ers/lookup` response shape cannot change without a transition period
- New fields may be added freely to lookup responses — Lua ignores unknown fields
- Removing required response fields requires a Lua script update first
