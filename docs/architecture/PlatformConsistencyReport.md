# Platform Consistency Report

**ENRS Unified Communications Platform**  
Version 1.1 · 2026-07-21 (C1–C4 resolved)  
Lead Architect Sign-Off Document

---

## Executive Summary

A full-stack consistency audit was performed across the backend (routes, controllers, services, migrations), frontend (API client, routing, components), Lua scripts, ESL integration, Socket.IO event model, and all Wave 0 architecture documentation.

The audit identified **4 critical issues, 8 high issues, 7 medium issues, and 4 low issues** — a total of 23 findings. No finding requires a redesign. All critical and high findings are correctable within Wave 1 without architectural change.

The platform is architecturally sound. The five-layer model and module boundary design are correct. The primary risks are implementation-layer inconsistencies accumulated across multiple development phases rather than architectural flaws.

**Wave 1 may begin after the 4 critical findings are resolved or formally acknowledged with a documented resolution path.**

---

## Architecture Health Score

| Dimension | Score | Notes |
|---|---|---|
| Five-Layer Architecture | 9/10 | Model is correct; Wave 1 will complete the separation |
| Module Boundaries | 7/10 | Known violations (ersRingService bgapi, conferenceManager ERS logic) are documented and scheduled |
| Domain Model Correctness | 7/10 | Dual ENS tracking, NORMAL_CLEARING→MISSED mapping are correctness issues |
| Database Consistency | 6/10 | Status case inconsistency, migration drift, duplicate column definitions |
| API Consistency | 7/10 | One path anomaly (`/detail`), dual ESL endpoints, good overall |
| Event Model | 6/10 | Tenant scoping gaps, unlistened events, dual naming convention |
| Lua Platform | 7/10 | Active scripts are correct; legacy scripts need clear separation |
| Observability | 5/10 | No structured logging, no health endpoint, `session_uuid` not yet correlated |
| Security | 8/10 | Auth is solid; multi-tenant Socket.IO gap is the main risk |
| Documentation | 9/10 | Wave 0 docs are comprehensive and production-grade |

**Overall Platform Consistency Score: 7.1 / 10**

A score of 7.1 is appropriate for a platform in active development with multiple historical iterations. The score will reach 8.5+ after Wave 1–2 corrections are applied.

---

## Critical Findings (must resolve before Wave 1)

### C1 — `NORMAL_CLEARING` mapped to `MISSED` status

**File:** `backend/src/services/eslService.js` → `mapHangupCauseToStatus()`

**Evidence:**  
```javascript
// eslService.mapHangupCauseToStatus
'NORMAL_CLEARING': 'MISSED',
'SUCCESS': 'MISSED',
```
When a responder answers the call and then hangs up normally (e.g., they joined the conference and left after the incident resolved), their `ers_incident_responders.status` is set to `'MISSED'` — identical to a responder who never picked up. The `join_time` and `leave_time` in `ers_incident_participants` may correctly reflect their presence, but the `status` column in `ers_incident_responders` contradicts it.

**Impact:**  
- ERS reporting counts responded calls as missed
- Responder performance analytics are wrong
- Dashboard "missed" counts are inflated
- A responder who answered and participated looks identical to one who never picked up

**Recommendation:**  
Map `NORMAL_CLEARING` → `'JOINED'` (or a new status `'LEFT'` to distinguish a clean departure from an answer-then-miss). The current statuses `INVITED`, `JOINED`, `MISSED`, `REJOINED`, `OBSERVER` already include `JOINED` — use it. `MISSED` should only be used when no answer occurred.

**Corrected mapping:**
```javascript
'NORMAL_CLEARING': 'JOINED',    // answered and left cleanly
'SUCCESS':         'JOINED',
// All other non-answer causes retain MISSED/BUSY/NO_ANSWER/FAILED/REJECTED/TIMEOUT
```

**Priority:** Fix in Wave 1 — this corrupts production reporting data on every ERS incident.

---

### C2 — `ens_campaigns` defined twice across migrations with incompatible schemas

**Files:** `backend/src/db/migrations/001_initial_schema.sql` (or `schema.sql`) and `backend/src/db/migrations/008_*.sql`

**Evidence:**  
Migration 001/schema.sql defines `ens_campaigns` with `id BIGSERIAL PRIMARY KEY`.  
Migration 008 defines `CREATE TABLE IF NOT EXISTS ens_campaigns` with `id UUID PRIMARY KEY` and additional columns (`organization_id`, `message_audio_url`, `max_concurrent`, `queued_count`, `retry_count`, `retry_interval_sec`, `expiry_hours`).

On fresh installs via `schema.sql`: the BIGSERIAL version is created first; migration 008's `CREATE TABLE IF NOT EXISTS` is a no-op; the columns defined only in 008 are never added. The campaign engine reads `max_concurrent_calls` and `retry_interval_sec` which must come from `ens_configurations`, not `ens_campaigns` — but `queued_count` on `ens_campaigns` that 008 tried to add is silently missing.

**Impact:**  
- Fresh install column set differs from upgrade install column set
- Any code reading `ens_campaigns.queued_count` fails silently on fresh installs (column doesn't exist)
- The UUID vs BIGSERIAL PK discrepancy is a data integrity risk if any code assumes UUID FK references to `ens_campaigns`

**Recommendation:**  
Write migration `032_*` that adds all columns from migration 008 that are missing from the schema.sql version (`IF NOT EXISTS`). Confirm `ens_campaigns.id` type across all environments before Wave 1. If BIGSERIAL is established everywhere, remove the UUID assumption from any code that references it.

**Priority:** Audit before Wave 1 to confirm the column set on all environments.

---

### C3 — ENS notification status divergence: `PENDING` vs `IN_PROGRESS`

**Files:** `backend/src/controllers/ensController.js`, `backend/src/controllers/internal/ensInternalController.js`

**Evidence:**  
- `ensController.createNotification` (UI path): inserts `status = 'PENDING'`
- `ensInternalController.ensCreateNotification` (Lua path): inserts `status = 'IN_PROGRESS'`
- `ensInternalController.ensQueueStatus` checks `WHERE status = 'IN_PROGRESS'`

A notification created via the UI starts as `PENDING`. `ensQueueStatus` only queries for `IN_PROGRESS`. A notification created via the UI will never appear in queue status checks.

**Impact:**  
- UI-triggered notifications are invisible to the Lua `ensQueueStatus` endpoint
- Lua blast script may start a new campaign on top of an already-running UI-triggered one
- Status lifecycle is broken: no transition from `PENDING` → `IN_PROGRESS` exists in the UI path

**Recommendation:**  
Standardize on one initial status. The campaign engine uses `queued` for campaigns — apply the same pattern to notifications: initial status is `PENDING`, transitioned to `IN_PROGRESS` (or `running` after status case standardization) when blast originiation begins. The internal controller must use the same initial status as the UI controller.

**Priority:** Fix in Wave 1 — active blast sessions may be duplicated because the status check does not see UI-created notifications.

---

### C4 — `reconcileAllActiveIncidents` QUEUED path skips queue promotion

**File:** `backend/src/services/eslService.js` → `reconcileAllActiveIncidents()`

**Evidence:**  
The 60-second reconciliation loop has two code paths:

Path A (orphaned ACTIVE incident, conference-destroy triggered):
```javascript
await completeIncidentCore(incident.id, ...);  // promotes queue, emits socket events
```

Path B (QUEUED incident older than 2 hours):
```javascript
await query(`UPDATE ers_incidents SET status = 'COMPLETED' WHERE id = $1`, [incident.id]);
// No completeIncidentCore call — no queue promotion, no socket emission
```

Path B silently completes a queued incident without promoting the next queued caller or notifying any connected clients.

**Impact:**  
- A caller who has waited over 2 hours in queue remains in the queue display on the monitoring UI (no socket event)
- If multiple callers are queued, the next one in line is never promoted
- The queue counter stays stale until the next manual incident or reconciliation

**Recommendation:**  
Replace the raw SQL in Path B with a call to `completeIncidentCore`. The distinction between Path A and Path B is the trigger, not the required outcome — both should fully complete the incident lifecycle.

**Priority:** Fix in Wave 1 — this silently abandons queued callers.

---

## High Findings (should resolve in Wave 1)

### H1 — Three concurrent writers to `ers_incidents.recording_path`

**Files:** `eslService.js` (`start-recording` event), `ersRingService.startRingAll`, `recordingController.upsertRecordingStart`

Three separate code paths update `ers_incidents.recording_path` with different filename formats. Under concurrent execution (multiple responders answer near-simultaneously), the last write wins, overwriting earlier values. The three filename formats are:
- `eslService`: path derived from channel variable at recording start
- `ersRingService`: `ers_${room}_${incidentUuid}.wav`
- `conferenceManager`/`upsertRecordingStart`: `ers_${confName}_${ts}.wav`

**Recommendation:** Recording path ownership belongs to `recordingController.upsertRecordingStart`. The other two paths must be removed or consolidated. `ersRingService` and `eslService` should call `upsertRecordingStart` only; never write `recording_path` directly.

---

### H2 — `originateCall` hard-codes `@default` conference profile

**File:** `backend/src/services/eslService.js` → `originateCall()`

```javascript
// Current code — wrong:
`&conference(${target}@default)`

// Must be:
`&conference(${target}@${conferenceManager.getConferenceProfile(config)})`
```

Any ERS configuration with a non-default `conference_profile` value will silently use `default` when calls come through `originateCall`. `ersRingService.originateLeg` correctly uses `getConferenceProfile` — the two originate paths are inconsistent.

---

### H3 — Socket.IO tenant isolation gap on `conference.*` events

**File:** `backend/src/services/eslService.js`

All ESL-originated events (`conference.member.joined`, `channel.hangup`, etc.) are emitted with `io.emit()` — broadcast to every connected socket regardless of tenant. A SUPERVISOR user in Tenant A can receive real-time conference events from Tenant B's active incidents.

**Recommendation:** Identify the `tenant_id` from the conference room name (all ERS rooms follow `ers_{config_id}_{slot}` format — join to `ers_configurations` to get `tenant_id`), then emit to `tenant:{tenantId}` room. This is Wave 2 work but the risk should be acknowledged now.

---

### H4 — `resolveContacts` logic duplicated in two services

**Files:** `backend/src/services/campaignEngine.js` and `backend/src/controllers/internal/ensInternalController.js`

Both implement nearly identical SQL for resolving ENS contacts (individual contacts + group members, deduplication). A bug fixed in one will not be fixed in the other.

**Recommendation:** Extract to `src/utils/ensContactResolver.js` and call from both. Wave 1 task.

---

### H5 — ENS status case inconsistency

**Evidence:**
- `ens_notifications.status`: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED` (UPPER_CASE)
- `ens_campaigns.status`: `queued`, `running`, `paused`, `completed`, `cancelled`, `failed` (lower_case)
- `ens_campaign_destinations.status`: `queued`, `dialing`, `answered`, `no_answer`, `failed` (lower_case)
- `ens_notification_deliveries.delivery_status`: `PENDING`, `DIALLING`, `ANSWERED`, `NO_ANSWER`, `FAILED` (UPPER_CASE with British spelling)

Four ENS tables, two case conventions, two spellings of `dialing/DIALLING`.

**Recommendation:** Establish `lower_snake_case` as the ENS domain standard (see PlatformStandards.md §1.4). Schedule cleanup migration in Wave 2 to normalize `ens_notifications.status` to lowercase. `ens_notification_deliveries` is on the deprecation path (post-Wave 1 the legacy tables are read-only); normalize only if still actively written after Wave 1 audit.

---

### H6 — Dead socket events with no frontend listeners

**Emitted but never consumed:**
- `enrs::ers_observer_joined`
- `enrs::ers_ring_ended`
- `enrs::campaign_paused`
- `enrs::campaign_resumed`
- `enrs::campaign_cancelled`
- `enrs::campaign_expired`
- `enrs::campaign_call_answered`
- `enrs::campaign_call_hangup`
- `enrs::campaign_progress`

**Impact:** CampaignDashboard.jsx does not show live state changes for pause, resume, cancel, expiry. An operator who pauses a campaign sees no live feedback.

**Recommendation:** Add listeners in `CampaignDashboard.jsx` for the campaign lifecycle events. The backend already emits them correctly.

---

### H7 — Dual ENS Lua/backend tracking paths not fully unified (F1 from prior review)

**Files:** `Lua-scripts/ens_blast_trigger.lua`, `ensInternalController.js`, `campaignEngine.js`

The Lua blast script still calls two separate paths. This was flagged as F1 Critical in the prior architecture review. The unified path target is: Lua calls `POST /internal/ens/campaign/start` exclusively.

**Recommendation:** Wave 1 — confirm current Lua paths and unify to `campaign/start`. Do not change Lua until the backend campaign/start endpoint is confirmed as the single authoritative blast trigger.

---

### H8 — `addResponder` in ersController has no route

**File:** `backend/src/controllers/ersController.js`

`addResponder` is exported but not mounted in `routes/v1/ers.js`. It is dead code at the HTTP layer. It may have been superseded by the tier-groups update endpoint.

**Recommendation:** Confirm whether `addResponder` is needed. If not, remove the export. If needed, add the route.

---

## Medium Findings

### M1 — `/ers/incidents/:uuid/detail` path inconsistency

All other resource detail endpoints use `GET /resource/:id`. This endpoint uses `GET /ers/incidents/:uuid/detail`. Maintain for Lua backward compat (per ADR-008) but do not replicate this pattern.

### M2 — Dual ESL status endpoints

`GET /settings/esl/status` and `GET /deployment/diagnostics/esl` both return ESL connection status. The frontend references both through different namespaces. Consolidate to one endpoint in Wave 2.

### M3 — Frontend monitoring page lacks role guard

`/monitoring` is accessible to all authenticated users. Backend API calls will fail for VIEWER/OPERATOR roles, but the page renders. Add `RequireAdminOrSupervisor` guard in `App.jsx`.

### M4 — Legacy Lua scripts ambiguity

`Lua-scripts/legacy/` exists but there is no runtime guard preventing these scripts from being manually loaded. The `dial_911_conference.lua` legacy script uses `session:execute("bgapi ...")` — a blocking call — while the active script correctly uses `freeswitch.bgapi()`. If a legacy script is accidentally loaded, callers would experience blocking delay on each responder invitation.

**Recommendation:** Add a `LEGACY_DO_NOT_LOAD.txt` marker file in the legacy directory. Document in CLAUDE.md.

### M5 — `media.js` legacy upload route still live alongside `mediaLibrary.js`

Two upload endpoints writing to `media_files`. No migration path documented. Add deprecation header to `media.js` responses and a sunset date.

### M6 — `reports.js` embeds all SQL in route handlers

No controller, no reuse. Technical debt only — no correctness issue. Schedule extraction to `reportingController.js` in Wave 3.

### M7 — `getByPin` endpoint approaching sunset

Comment says `// sunset: 2026-08-31`. Today is 2026-07-21. One month remains. Confirm whether any production Lua scripts call this endpoint before the date passes.

---

## Low Findings

### L1 — `getConferenceProfile` redundant `i` regex flag

`/^[a-z0-9_-]{1,64}$/i.test(raw)` — the `i` flag is redundant since the character class already covers both cases. No behavioral impact.

### L2 — `getConfRecordingDir` deprecated but still in `getSummary()` output

`freeSwitchPathService.getConfRecordingDir()` is `@deprecated` but still appears in the diagnostics path summary. Remove from `getSummary()` in Wave 2.

### L3 — `ens_configurations` has dead columns `caller_id` and `blast_clid`

Superseded by `sip_caller_id`. No code reads them. Can be dropped in a cleanup migration after confirming no external integrations reference them.

### L4 — `esl_connections.last_heartbeat_at` never updated

The column exists and migrations 001/schema.sql create it. `eslService.js` does not update it. The heartbeat logic was planned but not implemented. Either implement it or remove the column. Leave for Wave 6 when `esl_connections` is activated.

---

## Database Health

### Tables Inventory

**Active and healthy:**
- `tenants`, `organizations`, `users`, `locations`, `departments`
- `emergency_contacts`, `responder_groups`, `responder_group_members`
- `ens_configurations`, `ens_configuration_groups`, `ens_configuration_contacts`
- `ens_campaigns`, `ens_campaign_destinations`
- `ers_configurations`, `ers_tier_groups`, `ers_tier_contacts`
- `ers_incidents`, `ers_incident_responders`, `ers_incident_participants`, `ers_incident_events`
- `ers_queues`
- `ivr_flows`, `ivr_flow_versions`, `ivr_templates`
- `sip_gateways`, `emergency_numbers`
- `recordings`
- `audio_library`
- `system_settings`, `feature_flags`
- `audit_logs`

**Deprecated (read-only after Wave 1):**
- `ens_notifications` — superseded by `ens_campaigns`
- `ens_notification_deliveries` — superseded by `ens_campaign_destinations`
- `media_files` — superseded by `audio_library`

**Reserved (not yet active):**
- `esl_connections` — Wave 6 multi-site
- `communication_sessions` — Wave 3 (not yet created)
- `gateway_routes` — Wave 5 (not yet created)

**Columns reserved but not enforced (must not appear in UI):**
- `ers_configurations`: `max_participants`, `conference_lock`, `auto_destroy`, `allow_external`, `allow_duplicate_responders`, `moderator_required`, `bridge_timeout_sec`
- `recordings.conference_name` — generated alias for `conference_room`, redundant

**Dead columns (safe to remove in future cleanup migration):**
- `ens_configurations.caller_id` — superseded by `sip_caller_id`
- `ens_configurations.blast_clid` — superseded by `sip_caller_id`
- `ens_configurations.max_concurrent` — superseded by `max_concurrent_calls`
- `ens_configurations.retry_delay_seconds` — superseded by `retry_interval_sec`

---

## API Health

**Consistent:** Route naming, HTTP verbs, Zod validation, asyncHandler, error format, pagination, tenant scoping in queries.

**Exceptions:**
- `/ers/incidents/:uuid/detail` — `/detail` suffix (maintain for compat, freeze as exception)
- `POST /ers/broadcast-users` — semantics unclear from name; no frontend caller found; may be dead
- Dual ESL status paths (M2)

---

## Lua Health

**Active scripts:** Correct pattern (`freeswitch.bgapi()`, single lookup call, ENV-driven config).  
**Legacy scripts:** Present but inactive. Behavioral divergence (`session:execute` blocking) from active scripts.  
**Recommendation:** Add physical file guard in legacy directory.

---

## Routing Health

**dialResolver.js:** Correct and frozen.  
**conferenceManager.js:** Boundary violation (queries ERS tables) — scheduled for Wave 3.  
**ersRingService.js:** P1 violation (inline bgapi) — scheduled for Wave 1.  
**outboundRouter.js:** Does not yet exist — Wave 1 creates it.

---

## IVR Health

**Graph model:** Correct.  
**Versioning:** Correct and frozen (ADR-007).  
**Known bugs:** Five IVR node bugs documented in `IVRArchitecture.md` — all scheduled for Wave 1.  
**Node registry:** Correct pattern.

---

## Reporting Health

**Data model:** ERS reporting data stored correctly at event time.  
**ENS dual-tracking:** F1 Critical — reports must UNION across both tables until Wave 1 completes.  
**Inline SQL:** Technical debt only, not a correctness issue.  
**`mapHangupCauseToStatus` error:** Directly corrupts ERS report accuracy (C1).

---

## Provider Health

**FreeSWITCH ESL connection:** Healthy, auto-reconnects.  
**`enrs_session_uuid` channel variable:** Not yet universally set — Wave 1 task.  
**Provider Layer:** Does not yet exist — Wave 4 creates it.

---

## Top Risks

| # | Risk | Probability | Impact | Wave |
|---|---|---|---|---|
| R1 | `NORMAL_CLEARING → MISSED` corrupts ERS reporting in production | ~~High (every incident)~~ | ~~High~~ | ✅ Fixed |
| R2 | `reconcileAllActiveIncidents` QUEUED path abandons callers | ~~Medium~~ | ~~High~~ | ✅ Fixed |
| R3 | ENS duplicate notifications from status divergence (`PENDING` vs `IN_PROGRESS`) | ~~Medium~~ | ~~High~~ | ✅ Fixed |
| R4 | `conference.*` Socket.IO events leak across tenants | Low (single-tenant now) | High (multi-tenant) | W2 |
| R5 | `ens_campaigns` schema drift between fresh-install and upgrade paths | ~~Low~~ | ~~High~~ | ✅ Fixed |
| R6 | Legacy Lua accidentally loaded in production | Very Low | High | W1 |
| R7 | Three `recording_path` writers cause silent overwrite | Medium | Medium | W1 |

---

## Items to Freeze

The following are frozen as of this review (see `DecisionLog.md` for ADR details):

1. Tenant = security boundary (ADR-001)
2. `ens_campaigns` = authoritative ENS tracking post-Wave 1 (ADR-002)
3. Provider Isolation Principle (ADR-003)
4. Wave Completeness Rule (ADR-004)
5. Additive-only schema migrations (ADR-005)
6. `dialResolver.js` priority order (ADR-006)
7. IVR flow version immutability (ADR-007)
8. Internal API as Lua contract (ADR-008)
9. `enrs_session_uuid` as the platform-wide call correlation key
10. Conference room naming: `{module}_{config_id}_{slot}`
11. Socket event namespaces: `enrs::*` for domain, `{entity}.{action}` for platform/ESL

---

## Items Safe to Remove (future cleanup migrations)

| Item | When | Risk |
|---|---|---|
| `ens_configurations.caller_id` | After confirming no external readers | Low |
| `ens_configurations.blast_clid` | After confirming no external readers | Low |
| `ens_configurations.max_concurrent` | After confirming no readers | Low |
| `ens_configurations.retry_delay_seconds` | After confirming no readers | Low |
| `recordings.conference_name` generated column | After confirming no code reads it | Low |
| `getConfRecordingDir` from `freeSwitchPathService` | Wave 2 | Low |

---

## Items to Deprecate (do not remove yet)

| Item | Replacement | Timeline |
|---|---|---|
| `ens_notifications` + `ens_notification_deliveries` tables | `ens_campaigns` + `ens_campaign_destinations` | Read-only post-Wave 1 |
| `media_files` table | `audio_library` | Close upload route; keep data |
| `media.js` upload route | `mediaLibrary.js` | Add deprecation response header |
| `ers_connect` IVR node type | `transfer` node to ERS number | Label in UI only; no removal |
| `emergency_contacts.gateway_id` string override (legacy name approach) | FK-based `sip_gateway_id` | Post Wave 1 |
| `getByPin` endpoint on contacts | (no replacement; sunset 2026-08-31) | Confirm no Lua callers |

---

## Future Improvements (post-Wave 2)

1. Extract `resolveContacts` to shared utility (H4)
2. Add structured logging (Wave 2)
3. Add health endpoint (Wave 2)
4. Scope `conference.*` events to tenant rooms (Wave 2)
5. Extract `reports.js` SQL to `reportingController.js` (Wave 3)
6. Move `conferenceManager` ERS recording logic to ERS module (Wave 3)
7. Provider Layer wrapping ESL (Wave 4)
8. `gateway_routes` routing policy table (Wave 5)
9. Activate `esl_connections` for multi-site (Wave 6)

---

## Wave 1 Pre-Conditions Checklist

Before any Wave 1 code is written, confirm:

- [x] C1: `mapHangupCauseToStatus` fixed — `NORMAL_CLEARING/SUCCESS → 'JOINED'` (`eslService.js:1058`)
- [x] C2: `ens_campaigns` schema drift resolved — `001_initial_schema.sql` updated to UUID PK matching migration 008; manual psql path now produces the same schema as automated `migrate.js` path
- [x] C3: ENS queue guard fixed — `ensQueueStatus` now checks both `ens_notifications` (IN_PROGRESS + PENDING) and `ens_campaigns` (queued + running)
- [x] C4: `reconcileAllActiveIncidents` QUEUED path fixed — replaced raw SQL with `completeIncidentCore` loop (`eslService.js:2070-2089`)
- [x] All Wave 0 documentation files committed to the repository
- [x] `DecisionLog.md` reviewed and ADRs 1–8 approved
- [x] `PlatformStandards.md` reviewed and approved as mandatory

**Additional Phase 1 cleanups (H-series):**
- [x] H2: `originateCall` conference profile — removed spurious `@default` suffix; target must be `room@profile` from `getConferenceString()` (`eslService.js:1457`)
- [x] H8: Dead `addResponder` export removed from `ersController.js` (had no route, not imported anywhere)
- [ ] H1: Three `recording_path` writers — analysis shows no active race in normal lifecycle; deferred to Wave 1 for consolidation
- [ ] H3: Socket.IO tenant isolation on `conference.*` events — Wave 2 task
- [ ] H4: `resolveContacts` duplication — implementations return different data shapes; not safely mergeable without caller redesign; Wave 1 review
- [ ] H5: ENS status case normalization — Wave 2 cleanup migration
- [ ] H6: Frontend listeners for dead campaign lifecycle events — Wave 1
- [ ] H7: Dual ENS Lua paths — Wave 1 Lua update

---

## Final Architecture Sign-Off

### 1. Is the architecture internally consistent?

**Largely yes, with known exceptions.** The five-layer model, module boundary design, database patterns, IVR architecture, and routing design are internally consistent and correctly specified. The inconsistencies identified are implementation-layer drift accumulated across multiple development phases — not architectural contradictions. All 23 findings are correctable without redesign.

### 2. Is Wave 0 complete?

**Yes.** All 16 architecture documents are written and internally consistent. The decision log captures all frozen decisions. The platform standards are established. The consistency report (this document) is complete.

### 3. Is the platform ready for Wave 1?

**Yes, with conditions.** Wave 1 may begin after the 4 critical findings (C1–C4) are either fixed or have an explicit documented resolution plan approved by the engineering lead. The C findings are scoped work that fits within Wave 1 scope.

### 4. What must be corrected before Wave 1?

| # | Item | Action |
|---|---|---|
| C1 | `NORMAL_CLEARING → MISSED` mapping | ✅ Fixed — `eslService.js mapHangupCauseToStatus` now returns `JOINED` |
| C2 | `ens_campaigns` schema drift | ✅ Fixed — `001_initial_schema.sql` updated to UUID PK + full column set from migration 008 |
| C3 | `PENDING` vs `IN_PROGRESS` status divergence | ✅ Fixed — `ensQueueStatus` now guards both `ens_notifications` statuses and `ens_campaigns` |
| C4 | QUEUED incident path in reconciliation | ✅ Fixed — `reconcileAllActiveIncidents` now calls `completeIncidentCore` for QUEUED orphans |

### 5. What architectural decisions are now frozen?

ADR-001 through ADR-008 (documented in `DecisionLog.md`). Additionally frozen:
- `enrs_session_uuid` as the platform-wide correlation key
- Conference room naming convention: `{module}_{config_id}_{slot}`
- Socket event namespaces: `enrs::*` for domain events, `{entity}.{action}` for ESL/platform events
- `freeSwitchPathService` as the exclusive source for all FS filesystem paths

### 6. What standards become mandatory for future development?

All standards in `PlatformStandards.md` are mandatory. The highest-priority rules:

1. Business modules never import `eslService.js` directly
2. Business modules never construct dial strings or bgapi commands
3. All outbound calls go through `outboundRouter.js` (Wave 1+) and `communicationEngine.js` (Wave 3+)
4. All DB queries include `AND tenant_id = req.user.tenantId` and `AND deleted_at IS NULL`
5. All schema changes are additive only
6. Every wave is independently deployable with no TODO/Wave-N+ comments remaining
7. All Socket.IO domain events use `emitInternal(event, data, tenantId)` — never unscoped `io.emit()`
8. All FreeSWITCH filesystem paths come from `freeSwitchPathService`
9. All conference profile selection goes through `conferenceManager.getConferenceProfile()`
10. Reserved columns (`max_participants`, etc.) must not appear in UI until enforcement code exists

### 7. What should never be changed without an ADR?

- Tenant security boundary model
- `dialResolver.js` gateway resolution priority order
- Internal API endpoint paths or response field names
- IVR flow version immutability model
- Communication Session schema once created in Wave 3
- `enrs_session_uuid` channel variable name
- Conference room naming pattern
- Socket.IO event namespace conventions
- Wave Completeness Rule
- Additive-only migration policy
