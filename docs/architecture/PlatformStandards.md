# Platform Standards

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21  
**STATUS: MANDATORY — All future development must comply with every standard in this document.**

---

## 1. Database Design Standards

### 1.1 Primary Keys

- New tables use `UUID DEFAULT gen_random_uuid()` as the primary key.
- Existing tables with SERIAL/BIGSERIAL PKs are not migrated (additive-only rule).
- When a table has a UUID PK, its FK references in other tables are also UUID.
- When a table has an INT/BIGSERIAL PK, its FK references are INT.

### 1.2 Tenant Isolation

- Every table that stores business data must have `tenant_id INT NOT NULL REFERENCES tenants(id)`.
- `JOIN`s across tenant-scoped tables must always include `AND t.tenant_id = $n` conditions.
- Row-level filtering is always done in the query, never trusted from request body.
- `req.user.tenantId` (from JWT) is the exclusive source of truth for tenant ID in all controllers.

### 1.3 Audit Columns

Every table must have:
```sql
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()  -- maintained by trigger
deleted_at  TIMESTAMPTZ                         -- soft delete
```
Tables that record events (e.g. `ers_incident_events`, `audit_logs`) may omit `updated_at` and `deleted_at` if they are immutable append-only records.

### 1.4 Status Column Standards

**One case convention, per layer:**

| Layer | Convention | Example |
|---|---|---|
| ERS domain (incidents, responders, queue) | `UPPER_SNAKE_CASE` | `ACTIVE`, `INVITED`, `NO_ANSWER` |
| ENS domain (campaigns, destinations) | `lower_snake_case` | `queued`, `running`, `no_answer` |
| IVR domain | `lower_snake_case` | `draft`, `published`, `deployed` |
| Deployment/gateway | `lower_snake_case` | `success`, `failed` |

**Rule:** Do not mix case within a single table's status column. Do not mix case within a module domain.

**Goal state (Wave 2 cleanup migration):** Migrate all ENS status columns to `lower_snake_case`. ERS status columns remain `UPPER_SNAKE_CASE` (majority convention for that domain).

### 1.5 Spelling

Use **American English** spelling exclusively in all column names, status values, log messages, and code identifiers.

- `dialing` (not `dialling`)
- `canceled` (not `cancelled`) — exception: `CANCELLED` is already established in ERS domain; do not change existing values
- `color` (not `colour`)

New status values follow American spelling regardless of which direction existing values went.

### 1.6 Naming Conventions

- Table names: `lower_snake_case`, plural (`ers_incidents`, `sip_gateways`)
- Column names: `lower_snake_case` (`tenant_id`, `created_at`, `dial_attempts`)
- Index names: `idx_<table>_<columns>` (`idx_ers_incidents_conference_room_active`)
- FK constraint names: `fk_<table>_<column>` where the name adds clarity beyond the default

### 1.7 Migrations

- File naming: `NNN_short_description.sql` where NNN is zero-padded to 3 digits
- All migrations: `BEGIN;` ... `COMMIT;`
- All migrations: idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`)
- All migrations: additive only (never `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, `ALTER COLUMN TYPE`)
- Never modify a migration file that has been committed and deployed

### 1.8 Soft Delete

- Always query with `AND deleted_at IS NULL`
- Soft-delete on the parent does not cascade to children — children must be individually soft-deleted via cascade at application layer if required
- Hard delete is never performed on business tables

---

## 2. API Design Standards

### 2.1 Route Naming

- Resources use plural nouns: `/configurations`, `/incidents`, `/campaigns`
- Sub-resources use the parent resource path: `/configurations/:id/tier-groups`
- Actions use verbs only when a sub-resource would be ambiguous: `POST /configurations/:id/toggle`
- Detail endpoints **do not use a `/detail` suffix**: `GET /incidents/:uuid` not `GET /incidents/:uuid/detail`
- The ERS incident detail endpoint (`GET /ers/incidents/:uuid/detail`) is the only exception — maintain backward compat with existing Lua scripts but do not create new endpoints with this pattern.

### 2.2 Response Format

**List response:**
```json
{
  "data": [...],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

**Single item response:** return the object directly (no wrapper)

**Error response:**
```json
{
  "error": "Human-readable message",
  "field": "field_name"  // optional, for validation errors
}
```

**Never return:**
- Stack traces in responses (logged internally only)
- `null` for a field that should be an array (return `[]`)
- Undocumented fields that begin with `_`

### 2.3 HTTP Status Codes

| Status | When |
|---|---|
| 200 | Success (GET, PUT, PATCH) |
| 201 | Resource created (POST that creates) |
| 204 | Success, no content (DELETE) |
| 400 | Validation error, bad request |
| 401 | Not authenticated |
| 403 | Authenticated but not authorized |
| 404 | Resource not found |
| 409 | Conflict (FK violation, unique violation, business rule conflict) |
| 500 | Unhandled internal error |

### 2.4 Authentication

- All `/api/v1/*` endpoints: `requireAuth` middleware (JWT Bearer or httpOnly cookie)
- All `/api/v1/internal/*` endpoints: `requireInternalKey` middleware (X-Internal-Key header)
- Never mix auth middleware between the two route trees
- RBAC uses named middleware from `rbac.js`: `adminOnly`, `adminOrSuper`, `canTriggerEns` — never inline role checks

### 2.5 Pagination

- Default limit: 20 rows
- Maximum limit: 1000 rows (for dropdown population)
- Dropdowns that populate selects must pass `limit: 1000` explicitly
- All list endpoints must accept `page` and `limit` query parameters

### 2.6 Tenant Isolation in APIs

- Every query must include `AND tenant_id = req.user.tenantId`
- Tenant ID must never come from the request body for security decisions
- Cross-tenant access requires a super-admin bypass mechanism, not a missing WHERE clause

### 2.7 Validation

- Zod for all request body validation
- Apply `asyncHandler` wrapper to all route handlers
- Validation schemas live in the controller file (not in the route file)
- UUIDs are validated by `router.param('uuid', ...)` before they reach handlers

---

## 3. Module Design Standards

### 3.1 Single Responsibility

Each module owns one domain. Boundaries from `ModuleBoundaries.md` are mandatory.

### 3.2 Forbidden Cross-Module Access

- Business modules (ENS, ERS, IVR) must never call `eslService.js` directly
- Business modules must never import from another business module's internal files
- Platform services (`conferenceManager`, `eslService`) must never query business module tables directly
- After Wave 3: all outbound calls go through Communication Engine

### 3.3 Dynamic Imports for Circular Dependency Prevention

When a circular dependency would form between two services, use dynamic `await import()` at the call site rather than a top-level import. Document why the dynamic import is used with a single-line comment. This pattern is currently used in `eslService.js` and `conferenceManager.js` and is explicitly permitted.

### 3.4 Controller vs Service

- Controllers: handle HTTP concerns (request parsing, response shaping, auth checking, Zod validation)
- Services: contain business logic (no `req`/`res` references)
- Report queries are the current exception (`reports.js` embeds SQL in route handlers) — this is technical debt to be resolved in Wave 3

---

## 4. Naming Standards

### 4.1 Files and Directories

| Type | Convention | Example |
|---|---|---|
| Service files | `camelCase.js` | `campaignEngine.js`, `dialResolver.js` |
| Controller files | `camelCase.js` | `ersController.js`, `gatewayController.js` |
| Route files | `camelCase.js` | `ens.js`, `monitoring.js` |
| Migration files | `NNN_snake_case.sql` | `032_gateway_fields.sql` |
| Lua scripts | `snake_case.lua` | `ers_conference_bridge.lua` |

### 4.2 JavaScript

- Variables and functions: `camelCase`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Boolean parameters: use positive names (`isAsync`, `isActive`) not negatives (`notBlocking`)

### 4.3 Database

- Tables: `lower_snake_case` plural
- Columns: `lower_snake_case`
- All UUID fields named `*_uuid` when they reference an external UUID; `id` for the primary key

### 4.4 ESL / FreeSWITCH

- Channel variables: `lower_snake_case` (FreeSWITCH convention: `origination_caller_id_number`)
- Platform-defined channel variables: prefix `enrs_` (`enrs_session_uuid`, `enrs_flow_id`)
- Conference room names: `{module}_{config_id}_{slot}` (`ers_42_p`, `ers_42_s`)

### 4.5 Socket.IO Events

Two namespaces are established:

| Namespace | Format | Source | Example |
|---|---|---|---|
| Application domain | `enrs::{module}_{event}` | Business controllers | `enrs::ens_started`, `enrs::ers_incident_created` |
| Platform/ESL | `{entity}.{action}` | `eslService.js` | `conference.member.joined`, `channel.hangup` |

All new application-domain events use the `enrs::` prefix.  
All new ESL-origin events use dot notation without prefix.  
No other formats are permitted.

### 4.6 Lua Variables

- Local variables: `snake_case`
- Global variables: `UPPER_SNAKE_CASE`
- Constants: `UPPER_SNAKE_CASE`
- API response field access: use exact field names from the API contract (no aliasing)
- Log prefix: `[MODULE_NAME]` in brackets, e.g. `[ERS_CONF]`, `[ENS_PLAY]`, `[BLAST]`

---

## 5. Logging Standards

### 5.1 Current State

Unstructured `console.log`/`console.error`. This is acceptable until Wave 2.

### 5.2 Target State (Wave 2)

Structured JSON logging. Every log entry must include:

```json
{
  "time":        "ISO8601",
  "level":       "info|warn|error|debug",
  "module":      "ENS|ERS|IVR|ESL|GATEWAY|SYSTEM",
  "sessionUuid": "uuid or null",
  "tenantId":    42,
  "event":       "verb.noun",
  "msg":         "human readable"
}
```

### 5.3 Log Level Rules

- `error`: unhandled exception, ESL disconnect, migration failure, DB write failure
- `warn`: retry (with attempt number), unexpected-but-handled state, deprecated code path hit
- `info`: call originated, campaign started, incident opened, deployment completed, user authenticated
- `debug`: per-node IVR execution, DTMF events, ESL raw event dump, per-contact campaign tick

### 5.4 Sensitive Data

Never log: passwords, PINs, password hashes.  
Mask in info logs: phone numbers show only last 4 digits (`+44*******6789`).  
Full phone numbers permitted in debug level only.

---

## 6. Event Standards

### 6.1 Socket.IO Tenant Scoping

- All `enrs::` domain events MUST be scoped: `emitInternal(event, data, tenantId)`
- All ESL `conference.*` and `channel.*` events MUST be scoped to the correct tenant room before Wave 2
- Unscoped `io.emit()` is permitted only for system-level events (`esl.status`)

### 6.2 Event Payload Standards

Every emitted event payload must include:
- `tenantId` — always
- `timestamp` — ISO8601 string
- The primary resource ID (e.g. `incidentUuid`, `campaignId`, `sessionUuid`)

### 6.3 Correlation IDs

- Every originated call session has `session_uuid` (platform UUID)
- `session_uuid` is set as FreeSWITCH channel variable `enrs_session_uuid` on every outbound call
- All log lines related to a call include `sessionUuid`
- All Socket.IO events related to a call include `sessionUuid` (Wave 3+)

---

## 7. Lua Standards

### 7.1 Structure

Every Lua script follows this pattern:
1. `local config = {}` — load ENV vars and defaults
2. One `GET /internal/{module}/lookup` call — load all session config in one request
3. Main session logic using `session:` methods
4. `POST` calls to Internal API for state transitions only

### 7.2 No Mid-Session Config Fetches

Lookup endpoints must return all data needed for the entire call. No second lookup mid-call. The only exception: playback endpoints that fetch the latest campaign recording (inherently dynamic data).

### 7.3 Non-Blocking Originate

All responder origination uses `freeswitch.bgapi(cmd)` — not `session:execute()`. The session-execute pattern blocks the caller leg and is prohibited.

### 7.4 Error Handling

Every curl call is followed by:
```lua
if not response then
  freeswitch.consoleLog("ERR", "[MODULE] API call failed: description\n")
  session:hangup("NORMAL_CLEARING")
  return
end
```

### 7.5 Legacy Scripts

Legacy scripts live in `Lua-scripts/legacy/` and are never loaded by FreeSWITCH dialplan. Dialplan extensions reference only scripts from `Lua-scripts/` root. Legacy scripts are retained for reference only. Any modification to active scripts must NOT be mirrored to legacy.

### 7.6 Logging Prefix

Every `freeswitch.consoleLog` call uses the module prefix in brackets: `[ERS_CONF]`, `[ENS_PLAY]`, `[BLAST]`, `[IVR]`.

---

## 8. Routing and Provider Standards

### 8.1 Provider Isolation (frozen — ADR-003)

Business modules never contain:
- `bgapi`/`api originate` commands
- FreeSWITCH dial string construction
- Channel variable names
- FreeSWITCH hangup cause strings in business logic
- Direct `eslService.js` imports

### 8.2 Dial String Construction

All dial string construction goes through `dialResolver.resolveDialString()`.  
All channel variable assembly goes through `outboundRouter.js` (Wave 1+).  
No other code constructs `{k=v,k=v}dialString &app()` strings.

### 8.3 Hangup Cause Handling

Business modules use standard disconnect codes only:  
`NO_ANSWER | BUSY | REJECTED | FAILED | CONGESTION | NORMAL | CANCELLED`

FreeSWITCH-specific cause strings are translated to standard codes in the Provider Layer (Wave 4) or in `campaignEngine.js` until Wave 4.

### 8.4 Conference Profile

All conference actions must use `conferenceManager.getConferenceProfile(config)` for profile selection.  
Hard-coded `@default` profile is prohibited.  
Existing violation in `eslService.originateCall` must be fixed in Wave 1.

---

## 9. Communication Engine Standards

### 9.1 Single Entry Point (Wave 3+)

After Wave 3, all outbound communication goes through `communicationEngine.request(CommunicationRequest)`. No module calls `outboundRouter.js` directly.

### 9.2 CommunicationRequest

- Zero provider-specific fields
- Zero FreeSWITCH concepts
- `module`, `moduleRefTable`, `moduleRefId` are always set for session linkage
- `channel` defaults to `'voice'`
- `priority` defaults to `'normal'`; ERS ring-all uses `'high'`

### 9.3 Standard Codes

Business modules receive only standard disconnect codes. Never log or store FS-specific cause strings in module-owned tables.

---

## 10. IVR Node Standards

### 10.1 Node Type Definition

Every node type must have:
- `type` — unique string identifier, `snake_case`
- `label` — human display name
- `category` — `media | input | routing | integration`
- `schema` — Zod validation schema for `config`
- `branches` — boolean, whether `next` is a map or a string

### 10.2 Integration Nodes

Integration nodes call the public Internal API of the target module.  
Integration nodes never call internal service functions directly.  
Integration nodes never bypass the module's REST contract.

### 10.3 Variable Naming

Platform channel variables use prefix `enrs_`.  
IVR custom variables use prefix `ivr_custom_`.  
Collision with FreeSWITCH system variables is prohibited.

---

## 11. Documentation Standards

### 11.1 Architecture Documents

`docs/architecture/` is the authoritative source for all architectural decisions.  
Every ADR is written in `DecisionLog.md` before implementation begins.  
Architecture documents are updated when the architecture changes — never afterward.

### 11.2 Code Comments

Default: no comments.  
Comment only when: the WHY is non-obvious, a constraint is hidden, or a workaround for a specific bug.  
Never comment WHAT the code does.  
Never reference callers, issue numbers, or task names in inline comments.

### 11.3 Changelog

Migration files are the changelog for schema. No `CHANGELOG.md` required.  
ADRs in `DecisionLog.md` are the changelog for architecture decisions.

---

## 12. Architecture Rules

### 12.1 Additive Schema Only (frozen — ADR-005)

No destructive migrations ever. See ADR-005.

### 12.2 Wave Completeness (frozen — ADR-004)

Each wave is independently deployable. No TODOs survive a wave boundary.

### 12.3 Tenant Boundary (frozen — ADR-001)

`tenant_id` from JWT is the only security boundary. `organization_id` is never a security filter.

### 12.4 Internal API as Lua Contract (frozen — ADR-008)

`/api/v1/internal/*` endpoints are a versioned contract. Breaking changes follow the transition protocol in ADR-008.

### 12.5 dialResolver Contract (frozen — ADR-006)

Gateway resolution priority order in `dialResolver.js` is frozen. Routing policy changes go through `gateway_routes` table.

---

## 13. Future Development Rules

1. Every new capability starts with an ADR in `DecisionLog.md`
2. Every new status value is documented in `DomainModel.md` before the migration is written
3. Every new Socket.IO event is added to the event table in `Observability.md`
4. Every new Lua API contract change is documented before the Lua script is updated
5. No new module may import from another module's internal files
6. No new direct `eslService.js` import from a business module
7. No new hardcoded FreeSWITCH paths (use `freeSwitchPathService`)
8. No new hardcoded conference profile names (use `conferenceManager.getConferenceProfile`)
9. Reserved columns (`max_participants`, `conference_lock`, etc.) must not appear in UI until enforcement code exists
10. Tests must cover the golden path AND at least one failure scenario per endpoint
