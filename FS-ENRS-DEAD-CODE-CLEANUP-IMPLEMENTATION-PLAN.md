# FS-ENRS Dead Code Cleanup — Implementation Plan

**Date:** 2026-08-09  
**Branch:** main (commit 30cc654)  
**Based on:** Phase 1 Audit (FS-ENRS-DEAD-CODE-AND-SCHEMA-AUDIT.md) + Phase 2 Safety Report (FS-ENRS-DEAD-CODE-REMOVAL-SAFETY.md)  
**Source verification:** Completed — key files read directly; conclusions cross-checked against actual source.

---

## FINAL RECOMMENDATION

**READY FOR PARTIAL IMPLEMENTATION**

Three categories of work are ready to start immediately with high confidence:
- **Phase A** (debug instrumentation removal) — zero risk, no migration, one commit
- **Phase B** (legacy ERS report pages) — zero risk, no migration, reads only active tables
- **Phase C** (database dead table/column removal via migration 041) — low risk, FK-safe, verified zero read/write paths

One category requires substantial migration design before implementation begins:
- **Phase F** (ENS notification system retirement) — requires rewriting five active consumers before any table can be dropped

**Why partial and not full:** The ENS notification migration (Phase F) is the largest risk item. Static analysis is sufficient to plan it, but it cannot be implemented without rewriting `dashboardController.js`, the `EnsReport` backend (`/reports/ens`), `ensController.listNotifications`, the UI blast endpoint, and four legacy report pages — all before dropping `ens_notifications`. The current state is a dual-table architecture where UI-triggered blasts write to `ens_notifications` and Lua-triggered blasts write to `ens_campaigns`, while reports read only from `ens_notifications`. This split must be closed before any table is removed.

**What static analysis cannot establish:**
- Whether external monitoring probes `/api/health` (affects Phase G)
- Whether any FreeSWITCH instances in production have outdated Lua scripts that still call `/internal/ens/notifications/*` (required before Phase F endpoints are retired)
- Row counts in deprecated tables that inform the historical data archival decision

---

## Section 1: Executive Summary

**Verified legacy items: 29 distinct items** across code, database tables, database columns, and Lua files.

**Safe to remove immediately (no migration dependency): 15 items**
- 3 debug code blocks (ENS_PROBE, ENS_DEBUG, const D + call sites)
- 2 legacy ERS report pages + their backend endpoints + their API client methods
- 3 legacy Lua files
- 5 dead database tables
- 3 dead database columns
- 1 dead env var reference (FRONTEND_PORT banner reference)

**Requires ENS notification migration first: 9 items**
- ens_notifications table
- ens_notification_deliveries table
- 2 legacy ENS report pages (ReportNotifications, ReportEnsBroadcasts)
- 2 backend legacy ENS report endpoints (/reports/notifications, /reports/ens-broadcasts)
- 2 frontend API client methods (api.reports.notifications, api.reports.ensBroadcasts)
- /internal/ens/notifications/* legacy Lua endpoint group (5 routes)

**ENS notification migration scope:** 5 active consumers must be rewritten before ens_notifications can be retired:
1. `dashboardController.js` — 3 queries (metrics, active, chart)
2. `GET /reports/ens` — active EnsReport backend (NOT a legacy endpoint despite the name)
3. `GET /reports/ens/:uuid` — active EnsReport detail view
4. `ensController.listNotifications` — active `/ens/notifications` endpoint consumed by ENS dashboard UI
5. `ensController.createNotification` — the UI-triggered blast write path

**Estimated scope of ENS notification migration:** Approximately 250 lines of SQL rewrites across 3 backend files, plus frontend validation that EnsReport fields remain consistent. This is a multi-day effort with careful data modelling required.

**Key false positive confirmed:** `conferenceManager.js` is actively used via dynamic imports in `eslService.js` (lines 686, 810) and static import in `ersInternalController.js` (line 8). Do NOT remove it.

---

## Section 2: Verified Cleanup Inventory Table

| Item | Type | Location | Phase 2 Verdict | Proposed Action | Dependencies | Risk | Required Validation |
|---|---|---|---|---|---|---|---|
| ENS_PROBE middleware | JS code | backend/server.js:65-74 | CONFIRMED DEAD | Delete the app.use() block and comment | None | LOW | Confirm log volume drops; no tests reference |
| ENS_DEBUG middleware | JS code | backend/src/routes/internal/ens.js:7-19 | CONFIRMED DEAD | Delete the router.use() block and comment | None | LOW | Confirm no tests assert on ENS_DEBUG log output |
| const D helper + ~10 D() call sites | JS code | backend/src/controllers/internal/ensInternalController.js:10, ~391,393,402,405,408,446 | CONFIRMED DEAD | Remove declaration AND all D() call sites in same commit | Removing declaration without call sites = ReferenceError | MEDIUM | Run backend tests; grep for remaining D( calls |
| checkCredentials() | JS function | backend/server.js:183-217 (approx) | CONFIRMED DEAD | Remove function + its call; preserve boot diagnostic | validateEnvironment() must cover all same checks | LOW | Run startup, check PM2 logs for boot output |
| /api/health legacy probe | API endpoint | backend/server.js:89-92 | CONFIRMED DEAD | Remove inline handler | Verify no external probe targets this URL | LOW | Check nginx config, uptime monitors before removing |
| FRONTEND_PORT | Env var | backend/server.js banner | CONFIRMED DEAD | Remove process.env.FRONTEND_PORT from banner | None | LOW | Visual: check startup banner output |
| ReportIncidents page | React page | frontend/src/pages/reports/ReportIncidents.jsx | CONFIRMED — reads only active ers_incidents | Delete file + route in App.jsx:112 + endpoint + api method | None | LOW | ErsReport still works; no 404 on new path |
| ReportErsIncidents page | React page | frontend/src/pages/reports/ReportErsIncidents.jsx | CONFIRMED — reads only active ers_incidents | Delete file + route in App.jsx:113 + endpoint + api method | None | LOW | Same as above |
| /reports/incidents endpoint | API | backend/src/routes/v1/reports.js:33-56 | CONFIRMED DEAD | Delete route handler | Remove after ReportIncidents page | LOW | No 404 on ErsReport |
| /reports/ers-incidents endpoint | API | backend/src/routes/v1/reports.js:84-141 | CONFIRMED DEAD | Delete route handler | Remove after ReportErsIncidents page | LOW | Same |
| api.reports.incidents | Frontend method | frontend/src/api/client.js | CONFIRMED DEAD | Delete method | Remove after ReportIncidents page | LOW | No broken imports |
| api.reports.ersIncidents | Frontend method | frontend/src/api/client.js | CONFIRMED DEAD | Delete method | Remove after ReportErsIncidents page | LOW | No broken imports |
| blast_call.lua | Lua file | Lua-scripts/legacy/blast_call.lua | CONFIRMED DEAD | Delete file | None — deployment engine never references it | LOW | FreeSWITCH dialplan review |
| dial_911_conference.lua | Lua file | Lua-scripts/legacy/dial_911_conference.lua | CONFIRMED DEAD | Delete file; update Deployment.txt line 144 | Update Deployment.txt | LOW | No production dialplan reference; update docs |
| ENS_retry_playback.lua | Lua file | Lua-scripts/legacy/ENS_retry_playback.lua | CONFIRMED DEAD | Delete file | None | LOW | No dialplan reference |
| ens_contacts | DB table | schema.sql | CONFIRMED DEAD | DROP TABLE CASCADE in migration 041 | Drop ens_group_members first | LOW | Zero-row validation query |
| ens_groups | DB table | schema.sql | CONFIRMED DEAD | DROP TABLE CASCADE in migration 041 | Drop ens_group_members first | LOW | Zero-row validation query |
| ens_group_members | DB table | schema.sql | CONFIRMED DEAD | DROP TABLE in migration 041 (first in sequence) | None | LOW | Zero-row validation query |
| notification_templates | DB table | schema.sql | CONFIRMED DEAD | DROP TABLE in migration 041 | Migration 036 already dropped the FK from ens_configurations | LOW | Zero-row validation query |
| tenant_mappings | DB table | schema.sql | CONFIRMED DEAD | DROP TABLE in migration 041 | No FK references found | LOW | Zero-row validation query |
| ens_configuration_contacts.ens_contact_id | DB column | schema.sql | CONFIRMED DEAD | ALTER TABLE DROP COLUMN in migration 041 | Drop before ens_contacts | LOW | Verify no application writes (confirmed none) |
| ens_configuration_groups.ens_group_id | DB column | schema.sql | CONFIRMED DEAD | ALTER TABLE DROP COLUMN in migration 041 | Drop before ens_groups | LOW | Verify no application writes (confirmed none) |
| media_files.duration_seconds | DB column | schema.sql | CONFIRMED DEAD | ALTER TABLE DROP COLUMN in migration 041 | Note: computed aliases in reports SQL are independent | LOW | Verify canonical duration_sec still works |
| ReportNotifications page | React page | frontend/src/pages/reports/ReportNotifications.jsx | SAFE AFTER MIGRATION | Delete after ens_notifications retired | Phase F migration complete | MEDIUM | EnsReport covers same data via campaigns |
| ReportEnsBroadcasts page | React page | frontend/src/pages/reports/ReportEnsBroadcasts.jsx | SAFE AFTER MIGRATION | Delete after ens_notifications retired | Phase F migration complete | MEDIUM | Campaign destinations cover delivery data |
| /reports/notifications endpoint | API | backend/src/routes/v1/reports.js:11-30 | SAFE AFTER MIGRATION | Delete after ens_notifications retired | Phase F | MEDIUM | Legacy page removed first |
| /reports/ens-broadcasts endpoint | API | backend/src/routes/v1/reports.js:146-199 | SAFE AFTER MIGRATION | Delete after ens_notifications retired | Phase F | MEDIUM | Same |
| api.reports.notifications | Frontend method | frontend/src/api/client.js | SAFE AFTER MIGRATION | Delete after pages removed | Phase F | MEDIUM | No broken import |
| api.reports.ensBroadcasts | Frontend method | frontend/src/api/client.js | SAFE AFTER MIGRATION | Delete after pages removed | Phase F | MEDIUM | Same |
| /internal/ens/notifications/* (5 routes) | API group | backend/src/routes/internal/ens.js:34-38 | SAFE AFTER MIGRATION | Retire after verifying no Lua deployment calls these | Phase F + FreeSWITCH audit | HIGH | Verify no active Lua deployment targets these routes |
| ens_notifications table | DB table | schema.sql | SAFE AFTER MIGRATION | DROP after all read/write paths migrated | All Phase F steps | HIGH | Full Phase F complete |
| ens_notification_deliveries table | DB table | schema.sql | SAFE AFTER MIGRATION | DROP FIRST (child FK), then ens_notifications | Phase F | HIGH | Parent table migration complete |
| conferenceManager.js | JS file | backend/src/services/conferenceManager.js | FALSE POSITIVE — KEEP | Do not remove | N/A | N/A | Phase 2 confirmed: dynamically imported by eslService.js; statically imported by ersInternalController.js |

---

## Section 3: Current Architecture (As-Built)

The system has a split ENS blast architecture that was never fully unified after the campaign engine was introduced in migration 008.

```
UI-triggered ENS blast (current):
  Frontend EnsList/ENSPanel
    → POST /api/v1/ens/notifications
    → ensController.createNotification()
    → INSERT ens_notifications (status=PENDING, total_targets=N)
    → (no outbound calls made — UI blast is record-only, delivery is manual or via legacy Lua)

  Note: ensController.createNotification does NOT call campaignEngine.
  It inserts an ens_notifications row for tracking but does not originate calls.

Lua-triggered ENS blast (current — the primary path):
  Lua ens_blast_trigger.lua
    1. GET /internal/ens/lookup → ens configuration + PIN
    2. POST /internal/ens/verify-pin (if PIN required)
    3. Records message to disk
    4. POST /internal/ens/campaign/start
    → ensInternalController.startCampaign()
    → campaignEngine.createCampaign()
    → INSERT ens_campaigns + ens_campaign_destinations
    → Campaign engine tick (1 s) → originateCampaignCall() → FreeSWITCH

Legacy notification endpoints (still present but not called by current Lua):
  POST   /internal/ens/notifications           → ensInternalController.ensCreateNotification()
  GET    /internal/ens/notifications/queue-status → ensInternalController.ensQueueStatus()
  GET    /internal/ens/notifications/:uuid/pending-contacts → ensInternalController.ensPendingContacts()
  PATCH  /internal/ens/notifications/:uuid/delivery → ensInternalController.ensUpdateDelivery()
  POST   /internal/ens/notifications/:uuid/complete → ensInternalController.ensCompleteNotification()
  These write to ens_notifications and ens_notification_deliveries.

Reporting (current state — active EnsReport reads ens_notifications):
  EnsReport page
    → GET /api/v1/reports/ens              (reports.js:431-475)
    → SELECT FROM ens_notifications (paginated, filtered by tenant via join)
    Returns: notification_uuid, status, triggered_via, caller_number, recording_file,
             total_targets, total_answered, total_no_answer, total_replayed,
             created_at, started_at, completed_at, ens_name, org_name, triggered_by_name

  EnsReport detail
    → GET /api/v1/reports/ens/:notificationUuid (reports.js:478-517)
    → SELECT FROM ens_notifications + ens_notification_deliveries
    Returns: full notification + per-contact delivery rows (contact_number, delivery_status,
             attempt_number, answered_at, hangup_cause, call_uuid, name from emergency_contacts)

  Campaign report (SEPARATE page, separate endpoint):
    CampaignDashboard
      → GET /api/v1/reports/ens-campaigns     (reports.js:524-567)
      → SELECT FROM ens_campaigns (paginated)
      Returns: id, status, triggered_via, trigger_number, recording_file, message_text,
               total_destinations, answered_count, failed_count, completed_count,
               retried_count, campaign_duration_sec, created_at, started_at, completed_at,
               ens_name, org_name, triggered_by_name

    → GET /api/v1/reports/ens-campaigns/:id  (reports.js:570-end)
    → SELECT FROM ens_campaigns + ens_campaign_destinations
    Returns: full campaign + per-destination rows (phone_number, contact_name, status,
             target_type, routing_mode_used, gateway_name, attempt_count, hangup_cause, etc.)

Dashboard (3 queries — all read ens_notifications):
  GET /api/v1/dashboard/metrics    → dashboardController.js:29-35
    → SELECT COUNT FROM ens_notifications WHERE created_at >= CURRENT_DATE
    → Returns: notifications_today (integer count for today)

  GET /api/v1/dashboard/active     → dashboardController.js:172-179
    → SELECT last 5 ens_notifications ORDER BY created_at DESC
    → Returns: recent_notifications array (notification_uuid, status,
               total_targets, total_answered, created_at, ens_name)

  GET /api/v1/dashboard/chart      → dashboardController.js:194-199
    → SELECT date_trunc bucket COUNT from ens_notifications by period
    → Returns: time-series notification count for chart

ENS Notification List (active — feeds ENS dashboard UI):
  GET /api/v1/ens/notifications
    → ensController.listNotifications()
    → SELECT FROM ens_notifications paginated
    → Returns: all notification columns + ens_name

THERE IS NO UNIFIED VIEW. UI blast data is in ens_notifications only.
Lua blast data is in ens_campaigns only. EnsReport shows only UI blast history.
CampaignDashboard shows only Lua blast history. A user cannot see all blasts in one view.
```

---

## Section 4: Target Architecture

After all phases are complete:

```
All ENS triggers → campaign engine → ens_campaigns → ens_campaign_destinations

UI-triggered blast:
  Frontend
    → POST /api/v1/campaigns/trigger (or a new POST /api/v1/ens/blast)
    → campaignController.triggerCampaign() [already exists] or new ensController path
    → campaignEngine.createCampaignByConfigId()
    → INSERT ens_campaigns + ens_campaign_destinations
    → Campaign engine tick → originateCampaignCall() → FreeSWITCH

Lua-triggered blast (unchanged):
  ens_blast_trigger.lua → POST /internal/ens/campaign/start → campaign engine

Reporting (unified):
  EnsReport → GET /api/v1/reports/ens-campaigns (already exists)
  Dashboard  → 3 queries rewritten against ens_campaigns

Endpoints retired:
  DELETE /api/v1/ens/notifications (blast POST)
  DELETE GET /api/v1/ens/notifications (list)
  DELETE /internal/ens/notifications/* (legacy Lua group)
  DELETE /api/v1/reports/ens (old notification-backed report)
  DELETE /api/v1/reports/ens/:uuid (old notification detail)
  DELETE /api/v1/reports/notifications (legacy page)
  DELETE /api/v1/reports/ens-broadcasts (legacy page)

Tables retired:
  DROP TABLE ens_notification_deliveries
  DROP TABLE ens_notifications
```

**Gap analysis — what stands between current and target:**

1. The UI blast path (`ensController.createNotification`) does not create a campaign — it only inserts an `ens_notifications` record. The campaign engine is not involved. This means UI blasts have never been processed by the campaign engine. Moving them requires wiring `createCampaignByConfigId` into the UI blast flow.

2. The UI blast path does not currently require a `recordingFile` — it accepts a `recording_reference` field. The campaign engine requires a recording file or message text. This difference must be resolved before the UI blast can be routed through the campaign engine.

3. Historical `ens_notifications` data will not exist in `ens_campaigns`. The EnsReport page will show empty history after migration unless a data migration populates historical campaign rows. See Section 8.5.

4. The `ens_notification_deliveries` per-contact tracking (one row per contact attempt per notification) maps to `ens_campaign_destinations` (one row per contact per campaign). The FK/join relationship is equivalent but the field names differ significantly. See Section 5.

---

## Section 5: Old → New Data Model Mapping Table

### ens_notifications → ens_campaigns

| Old Structure | Old Field | New Structure | New Field | Equivalent? | Transformation Required |
|---|---|---|---|---|---|
| ens_notifications | id (SERIAL PK) | ens_campaigns | id (UUID PK) | NO — type change | Use ens_campaigns.id as the new primary key; all FK references change |
| ens_notifications | ens_configuration_id | ens_campaigns | ens_configuration_id | YES | Direct copy |
| ens_notifications | notification_uuid (UUID) | ens_campaigns | id (UUID PK) | PARTIAL | ens_campaigns uses UUID as PK directly; no separate uuid column needed |
| ens_notifications | triggered_via ('PHONE','UI','API') | ens_campaigns | triggered_via ('PHONE','UI','API','SCHEDULE') | YES — superset | Direct copy; campaign engine adds 'SCHEDULE' |
| ens_notifications | triggered_by_user_id | ens_campaigns | triggered_by | YES — different name | Rename in query; both FK to users.id |
| ens_notifications | caller_number | ens_campaigns | trigger_number | PARTIAL — different semantics | ens_notifications.caller_number = inbound caller; ens_campaigns.trigger_number = the dialled trigger number. Different concepts. Map trigger_number for reporting but note semantic gap. |
| ens_notifications | recording_file | ens_campaigns | recording_file | YES | Direct copy |
| ens_notifications | recording_reference | ens_campaigns | NO EQUIVALENT | NO | recording_reference was a legacy UI field for referencing a pre-recorded file by name. Campaign engine uses recording_file (path). Need to decide: drop or map to recording_file. |
| ens_notifications | status ('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED') | ens_campaigns | status ('queued','running','paused','completed','cancelled','failed') | PARTIAL — different values, different case | Status mapping required: PENDING→queued, IN_PROGRESS→running, COMPLETED→completed, FAILED→failed, CANCELLED→cancelled. Note: ens_campaigns has no 'PENDING' state; queued is the initial state. |
| ens_notifications | total_targets | ens_campaigns | total_destinations | YES — different name | Rename in queries |
| ens_notifications | total_answered | ens_campaigns | answered_count | YES — different name | Rename in queries |
| ens_notifications | total_no_answer | ens_campaigns | no_answer_count | YES — different name | Rename in queries |
| ens_notifications | total_replayed | ens_campaigns | NO EQUIVALENT | NO | Callback/replay tracking exists via audit_logs and ens_notification_deliveries. Campaign engine has no replay tracking column. New column needed on ens_campaigns, or derive from separate table. |
| ens_notifications | callback_count | ens_campaigns | NO EQUIVALENT | NO | Same as total_replayed — no equivalent. New column or drop. |
| ens_notifications | started_at | ens_campaigns | started_at | YES | Direct copy |
| ens_notifications | created_at | ens_campaigns | created_at | YES | Direct copy |
| ens_notifications | updated_at | ens_campaigns | updated_at | YES | Direct copy |
| ens_notifications | completed_at | ens_campaigns | completed_at | YES | Direct copy |
| ens_notifications | deleted_at | ens_campaigns | NO EQUIVALENT | NO | Campaign engine does not soft-delete campaigns. Either add deleted_at to ens_campaigns or hard-delete (not recommended). |
| ens_notifications | pin_verified_at (in reports query but not in schema.sql) | ens_campaigns | NO EQUIVALENT | UNCLEAR | Field referenced in /reports/ens-broadcasts query but absent from schema.sql CREATE TABLE. May be NULL-safe column added post-schema that is never populated. Verify before migration. |

### ens_notification_deliveries → ens_campaign_destinations

| Old Structure | Old Field | New Structure | New Field | Equivalent? | Transformation Required |
|---|---|---|---|---|---|
| ens_notification_deliveries | id (SERIAL PK) | ens_campaign_destinations | id (BIGSERIAL PK) | YES — type compatible | No transformation needed |
| ens_notification_deliveries | ens_notification_id (FK) | ens_campaign_destinations | campaign_id (FK to ens_campaigns UUID) | NO — FK type changes | All JOIN logic changes |
| ens_notification_deliveries | contact_number | ens_campaign_destinations | phone_number | YES — different name | Rename in queries |
| ens_notification_deliveries | delivery_status ('PENDING','DIALLING','ANSWERED','NO_ANSWER','FAILED','REPLAYED','CANCELLED') | ens_campaign_destinations | status ('queued','dialing','answered','busy','no_answer','failed','completed','expired','skipped') | PARTIAL | Status mapping required: PENDING→queued, DIALLING→dialing, ANSWERED→answered, NO_ANSWER→no_answer, FAILED→failed, REPLAYED→NO EQUIVALENT (add new status or use separate log), CANCELLED→skipped |
| ens_notification_deliveries | attempt_number | ens_campaign_destinations | attempt_count | YES — different name | Rename in queries |
| ens_notification_deliveries | call_uuid | ens_campaign_destinations | call_uuid | YES | Direct copy |
| ens_notification_deliveries | hangup_cause | ens_campaign_destinations | hangup_cause | YES | Direct copy |
| ens_notification_deliveries | answered_at | ens_campaign_destinations | answered_at | YES | Direct copy |
| ens_notification_deliveries | updated_at | ens_campaign_destinations | updated_at | YES | Direct copy |
| (no equivalent) | (not in old model) | ens_campaign_destinations | contact_id (FK emergency_contacts) | NEW FIELD in new model | Richer: new model links to the contact record directly |
| (no equivalent) | (not in old model) | ens_campaign_destinations | contact_name | NEW FIELD | Snapshot of name at time of campaign |
| (no equivalent) | (not in old model) | ens_campaign_destinations | target_type | NEW FIELD | Routing type (extension, mobile, etc.) |
| (no equivalent) | (not in old model) | ens_campaign_destinations | routing_mode_used | NEW FIELD | Which dial mode was used |
| (no equivalent) | (not in old model) | ens_campaign_destinations | gateway_name | NEW FIELD | Which SIP gateway was used |
| (no equivalent) | (not in old model) | ens_campaign_destinations | max_attempts, next_attempt_at, last_attempt_at | NEW FIELDS | Campaign engine retry state |
| (no equivalent) | (not in old model) | ens_campaign_destinations | error_message | NEW FIELD | Richer failure reason |

**Summary of gaps requiring new columns or new logic:**
- `recording_reference` — no equivalent in campaigns; decide whether to add or drop
- `total_replayed` / `callback_count` — no equivalent in campaigns; new columns needed on ens_campaigns if replay tracking must be preserved
- `deleted_at` — not on ens_campaigns; add soft-delete support or accept hard-delete semantics
- `REPLAYED` delivery status — not in campaign destinations; callback replay must be tracked differently (e.g., via audit_logs which is already written by ensInternalController.ensLogCallback)
- `pin_verified_at` — verify if this column exists; if not, drop from reports query

---

## Section 6: Part A — Immediate Low-Risk Cleanup

### A1. ENS_PROBE Middleware

**Files affected:** `backend/server.js`

**Exact location:** Lines 65-74 (inclusive of the surrounding comment lines at 65 and 74):
```
// ── TEMPORARY: global request probe — remove after ENS blast investigation ────
app.use((req, _res, next) => { ... });
// ─────────────────────────────────────────────────────────────────────────────
```

**Action:** Delete all 10 lines (65-74 inclusive). The `app.use()` block fires on every single request. There is no env-var guard. It uses `console.log` (not the structured logger) so it bypasses all log filtering.

**Test references:** None — no test asserts on ENS_PROBE output.

**Deployment references:** None.

**Cleanup sequence:** Single commit.

**Regression tests needed:** Run `npm test` in backend/. Confirm startup and health check routes still respond.

---

### A2. ENS_DEBUG Middleware

**Files affected:** `backend/src/routes/internal/ens.js`

**Exact location:** Lines 7-19 (inclusive of surrounding comment at line 7 and closing line at 20):
```
// ── TEMPORARY DEBUG — remove after ENS blast investigation ───────────────────
router.use((req, _res, next) => { ... });
// ─────────────────────────────────────────────────────────────────────────────
```

**Action:** Delete lines 7-20. The `router.use()` logs the full request body for every POST to `/internal/ens/*`. The `logger` import on line 3 may become unused — verify and remove if so (check whether any other code in the file uses `logger`).

**Current state:** `logger` is imported on line 3 only for this debug middleware. After deletion, the import line `import { logger } from '../../infrastructure/index.js';` becomes unused and should also be removed.

**Test references:** None.

**Regression tests needed:** Run integration tests for internal ENS routes.

---

### A3. const D Helper and All D() Call Sites

**Files affected:** `backend/src/controllers/internal/ensInternalController.js`

**Declaration to remove:** Line 10:
```js
const D = (tag, data, msg) => logger.info({ module: 'ENS_DEBUG', tag, ...data }, `[ENS_DEBUG] ${msg}`);
```

**D() call sites to remove (all within this file):**
Based on Phase 2 Safety Report analysis, D() calls are in these functions:
- `ensCreateNotification`: approximately 6 call sites (~lines 391, 393, 402, 405, 408, 446)
- `ensPendingContacts`: approximately 1-2 call sites
- `ensCompleteNotification`: approximately 1-2 call sites

**CRITICAL:** Remove the declaration and ALL call sites in the same commit. Removing only the declaration causes `ReferenceError: D is not defined` at runtime in the affected functions.

**Verification step before committing:** After edits, grep the file for `D(` to confirm no remaining call sites: `grep -n "D(" backend/src/controllers/internal/ensInternalController.js`

**Test references:** None directly. D() calls are inside active functions so the surrounding logic must keep working.

**Regression tests needed:** Run `npm run test` in backend/. The functions `ensCreateNotification`, `ensPendingContacts`, and `ensCompleteNotification` must still pass their integration tests.

---

### A4. ReportIncidents Page, Route, Endpoint, and API Method

**Rationale:** Backend endpoint reads only `ers_incidents` (active table). ErsReport (`/reports/ers`) provides all the same data. Safe to remove without any table migration.

**Files to change:**
1. `frontend/src/pages/reports/ReportIncidents.jsx` — delete the file entirely
2. `frontend/src/App.jsx` — remove line 21 (`import ReportIncidents`) and line 112 (`<Route path="reports/incidents" .../>`)
3. `backend/src/routes/v1/reports.js` — remove lines 33-56 (the `/incidents` route handler)
4. `frontend/src/api/client.js` — remove the `api.reports.incidents` method

**Test references:** Grep test files for `reports/incidents` and `ReportIncidents` — remove any integration test assertions on this path.

**Cleanup sequence:** Frontend component deletion → App.jsx edits → backend route deletion → API client method removal — all in a single commit.

**Regression tests needed:**
- `GET /api/v1/reports/ers` still returns 200 (the replacement endpoint)
- Navigating to `/reports/incidents` redirects (App.jsx has a catch-all `<Navigate to="/" replace />`)
- ErsReport page still loads and returns data

---

### A5. ReportErsIncidents Page, Route, Endpoint, and API Method

**Same rationale as A4.** Backend endpoint reads `ers_incidents` + `ers_incident_participants` — both active tables. No table migration required.

**Files to change:**
1. `frontend/src/pages/reports/ReportErsIncidents.jsx` — delete the file entirely
2. `frontend/src/App.jsx` — remove line 24 (`import ReportErsIncidents`) and line 113 (`<Route path="reports/ers-incidents" .../>`)
3. `backend/src/routes/v1/reports.js` — remove lines 84-141 (the `/ers-incidents` route handler)
4. `frontend/src/api/client.js` — remove the `api.reports.ersIncidents` method

**Test references:** Same as A4 — grep for `reports/ers-incidents` and `ReportErsIncidents`.

**Regression tests needed:** Same pattern as A4. Confirm ErsReport and `/reports/ers-incidents` endpoint removal do not break existing test suites.

---

### A6. Legacy Lua Files

**Files to delete:**
1. `Lua-scripts/legacy/blast_call.lua` — superseded by `Lua-scripts/ens_blast_trigger.lua`
2. `Lua-scripts/legacy/dial_911_conference.lua` — superseded by `Lua-scripts/ers_conference_bridge.lua`
3. `Lua-scripts/legacy/ENS_retry_playback.lua` — superseded by `Lua-scripts/ens_playback_handler.lua`

**FreeSWITCH reference check result:**
- None of these files are referenced in any generated XML dialplan, docker-compose, or shell script.
- `Deployment.txt` line 144 references `dial_911_conference.lua` in a manual `fs_cli -x "lua ..."` test command. This is documentation, not a production call path.

**Documentation to update when deleting legacy Lua:**
- `Deployment.txt` — line 144: change `dial_911_conference.lua` to `ers_conference_bridge.lua`
- `docs/01_System_Architecture.md` — references to legacy script names
- `docs/02_Backend_Folder_Structure.md` — references to legacy script names
- `docs/03_API_REFERENCE.md` — references to legacy script names
- `docs/08_ESL_AND_FREESWITCH.md` — references to legacy script names

**Cleanup sequence:** Delete all three Lua files. Update Deployment.txt and docs in the same commit.

**Regression tests needed:** Verify FreeSWITCH dialplan generated by the deployment engine still references only the current scripts.

---

### A7. FRONTEND_PORT Env Var Banner Reference

**Files affected:** `backend/server.js`

**Location:** The startup banner code reads `process.env.FRONTEND_PORT` to print it. This variable is not used by Vite (Vite's port is set independently), and it is not in `.env.example`.

**Action:** Remove the `process.env.FRONTEND_PORT` reference from the banner print. The banner itself may be kept; only the FRONTEND_PORT reference is dead.

**Risk:** None — this is a print statement only.

**Regression tests needed:** None — verify the startup banner still prints and does not crash.

---

## Section 7: Part B — Database Cleanup (Single Migration 041)

This migration drops verified-dead tables and columns in a single transaction. The DROP order must respect FK dependencies.

**Migration file:** `backend/src/db/migrations/041_drop_dead_ens_v1_tables.sql`

### B1. ens_group_members

**Current purpose:** Junction table linking ens_contacts to ens_groups. Part of the V1 ENS contact model replaced by emergency_contacts + responder_groups in migration 010.

**Why obsolete:** No application controller reads or writes it. The parent tables (ens_contacts, ens_groups) are also dead.

**FK dependencies:** References ens_contacts(id) and ens_groups(id). Must be dropped BEFORE the parent tables to avoid FK errors (unless using CASCADE, which is included for safety).

**Data implications:** If any rows exist, they are dead data with no application path. Recommend running validation query before migration.

**Validation query:** `SELECT COUNT(*) FROM ens_group_members;` — expected: 0

---

### B2. ens_contacts

**Current purpose:** V1 ENS-specific contact model, replaced by emergency_contacts.

**Why obsolete:** Schema.sql explicitly documents: "DEPRECATED, DO NOT USE". Zero DML references in any controller or service. The only code references are DDL and a comment in contactController.js explaining the B15 bug fix context.

**FK dependencies:** Referenced by ens_group_members(contact_id) and ens_configuration_contacts(ens_contact_id). Drop ens_group_members first; the junction column ens_contact_id is also being dropped in this migration.

**Proposed DROP:** `DROP TABLE IF EXISTS ens_contacts CASCADE;`

**Validation query:** `SELECT COUNT(*) FROM ens_contacts;` — expected: 0

---

### B3. ens_groups

**Current purpose:** V1 ENS-specific group model, replaced by responder_groups.

**Why obsolete:** Same rationale as ens_contacts. Schema.sql explicit deprecation comment.

**FK dependencies:** Referenced by ens_group_members(group_id) and ens_configuration_groups(ens_group_id). Drop ens_group_members first.

**Proposed DROP:** `DROP TABLE IF EXISTS ens_groups CASCADE;`

**Validation query:** `SELECT COUNT(*) FROM ens_groups;` — expected: 0

---

### B4. notification_templates

**Why obsolete:** No controller reads or writes it. The `template_id` FK that referenced it from `ens_configurations` was explicitly dropped in migration 036 (`036_ens_drop_dead_columns`). There are no remaining FKs pointing to this table.

**Data implications:** Table was created in migration 001. Any data in it has no application path.

**Proposed DROP:** `DROP TABLE IF EXISTS notification_templates;`

**Validation query:** `SELECT COUNT(*) FROM notification_templates;` — expected: 0

---

### B5. tenant_mappings

**Why obsolete:** Created in migration 001. Zero references found in any backend controller or service. No FK references from other tables found.

**Proposed DROP:** `DROP TABLE IF EXISTS tenant_mappings;`

**Validation query:** `SELECT COUNT(*) FROM tenant_mappings;` — expected: 0

---

### B6. ens_configuration_contacts.ens_contact_id Column

**Why obsolete:** FK to the dead ens_contacts table. No controller writes this column — the active path uses `emergency_contact_id`. Value is always NULL in practice.

**Proposed ALTER:** `ALTER TABLE ens_configuration_contacts DROP COLUMN IF EXISTS ens_contact_id;`

**Validation query:** `SELECT COUNT(*) FROM ens_configuration_contacts WHERE ens_contact_id IS NOT NULL;` — expected: 0

---

### B7. ens_configuration_groups.ens_group_id Column

**Why obsolete:** FK to the dead ens_groups table. No controller writes this column — the active path uses `responder_group_id`.

**Proposed ALTER:** `ALTER TABLE ens_configuration_groups DROP COLUMN IF EXISTS ens_group_id;`

**Validation query:** `SELECT COUNT(*) FROM ens_configuration_groups WHERE ens_group_id IS NOT NULL;` — expected: 0

---

### B8. media_files.duration_seconds Column

**Why obsolete:** Schema.sql explicitly labels it: "Legacy column from 001 (kept for backward compat, use duration_sec instead)". No controller ever writes it. No controller ever reads it. The canonical column is `duration_sec` (NUMERIC(8,2)).

**Important note:** The string `duration_seconds` appears as a computed alias in reports.js SQL (`EXTRACT(EPOCH FROM ...) AS duration_seconds`) — this is a computed column alias on `ers_incidents`, NOT a reference to `media_files.duration_seconds`. Dropping this column will not break those queries.

**Proposed ALTER:** `ALTER TABLE media_files DROP COLUMN IF EXISTS duration_seconds;`

**Validation query:** `SELECT COUNT(*) FROM media_files WHERE duration_seconds IS NOT NULL;` — expected: 0

---

### Migration 041 Full SQL

```sql
BEGIN;

-- ─── Pre-drop validation (will fail migration if any non-zero count) ───────────
DO $$
DECLARE
  v INT;
BEGIN
  SELECT COUNT(*) INTO v FROM ens_group_members;
  IF v > 0 THEN RAISE EXCEPTION 'ens_group_members has % rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM ens_contacts;
  IF v > 0 THEN RAISE EXCEPTION 'ens_contacts has % rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM ens_groups;
  IF v > 0 THEN RAISE EXCEPTION 'ens_groups has % rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM notification_templates;
  IF v > 0 THEN RAISE EXCEPTION 'notification_templates has % rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM tenant_mappings;
  IF v > 0 THEN RAISE EXCEPTION 'tenant_mappings has % rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM ens_configuration_contacts WHERE ens_contact_id IS NOT NULL;
  IF v > 0 THEN RAISE EXCEPTION 'ens_configuration_contacts has % non-null ens_contact_id rows — manual review required', v; END IF;

  SELECT COUNT(*) INTO v FROM ens_configuration_groups WHERE ens_group_id IS NOT NULL;
  IF v > 0 THEN RAISE EXCEPTION 'ens_configuration_groups has % non-null ens_group_id rows — manual review required', v; END IF;
END $$;

-- ─── Drop dead junction FKs first (before parent tables) ───────────────────────
ALTER TABLE ens_configuration_contacts DROP COLUMN IF EXISTS ens_contact_id;
ALTER TABLE ens_configuration_groups   DROP COLUMN IF EXISTS ens_group_id;

-- ─── Drop dead ENS V1 contact model ────────────────────────────────────────────
-- Order: child first, then parents.
-- CASCADE handles any remaining FK references that were missed in the audit.
DROP TABLE IF EXISTS ens_group_members;
DROP TABLE IF EXISTS ens_contacts CASCADE;
DROP TABLE IF EXISTS ens_groups   CASCADE;

-- ─── Drop orphaned utility tables ─────────────────────────────────────────────
DROP TABLE IF EXISTS notification_templates;
DROP TABLE IF EXISTS tenant_mappings;

-- ─── Drop dead legacy column ──────────────────────────────────────────────────
ALTER TABLE media_files DROP COLUMN IF EXISTS duration_seconds;

-- ─── Record migration ─────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version)
VALUES ('041_drop_dead_ens_v1_tables.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
```

**Migration ordering within the file:** The FK drop columns must precede the DROP TABLE statements for the referenced tables. Specifically, `ens_contact_id` references `ens_contacts` and must be dropped before `DROP TABLE ens_contacts`. The `ens_group_id` references `ens_groups` and must be dropped before `DROP TABLE ens_groups`. `ens_group_members` references both parent tables and must be dropped before them. The migration above is correctly ordered.

---

## Section 8: Part C — ENS Notification Migration (Highest Risk)

### 8.1 The Split Explained

The dual-table state exists because the campaign engine was introduced in migration 008 (V5 — Campaign Engine era) as the new outbound call orchestrator, but the migration of reporting and UI triggers was never completed.

**Older path (ens_notifications):** Created in migration 001. Lua scripts used to call `/internal/ens/notifications` directly, write rows, and update delivery status row-by-row. The current `ens_blast_trigger.lua` was updated to call `/internal/ens/campaign/start` instead, but the legacy notification endpoints were never removed, and the UI blast path (`ensController.createNotification`) was never redirected to use the campaign engine.

**Newer path (ens_campaigns):** Campaign engine manages all outbound call orchestration. Lua triggers via `/internal/ens/campaign/start`. FreeSWITCH ESL events route to `onCallAnswer`/`onCallHangup` in server.js, which update `ens_campaign_destinations`. The canonical outbound blast tracking is now in `ens_campaigns`.

**Which should become canonical:** `ens_campaigns` is the canonical path. It has richer state tracking, retry logic, adaptive throttling, and real-time Socket.IO events. The notification path has no outbound call orchestration — it is a record-only system.

### 8.2 UI-Triggered Blast Path Today

**Code path:** `POST /api/v1/ens/notifications` → `ensController.createNotification()` (ensController.js:343-369)

**What it writes:**
```sql
INSERT INTO ens_notifications
  (ens_configuration_id, triggered_by_user_id, triggered_via,
   recording_reference, status, total_targets)
VALUES ($1, $2, $3, $4, 'PENDING', $5)
```

**What it does NOT do:**
- Does not call the campaign engine
- Does not originate any outbound calls
- Does not write to ens_campaigns
- Does not schedule or manage any delivery

The UI blast is purely a record-insertion. Any actual call delivery was managed by the legacy Lua notification polling path (`/internal/ens/notifications/:uuid/pending-contacts`, `/internal/ens/notifications/:uuid/delivery`), which is also no longer called by current Lua scripts.

**Implication:** The UI blast path today creates a notification record with status PENDING that likely never progresses to IN_PROGRESS because no active code polls it or processes it. The `campaignController.triggerCampaign` endpoint (at `/api/v1/campaigns/:id/trigger` or similar) may be the intended UI path that was supposed to replace `ensController.createNotification`.

### 8.3 Campaign Engine Capabilities

`createCampaignByConfigId` (campaignEngine.js:720-end) provides:
- Config lookup with tenant isolation
- Destination list assembly from emergency_contacts + responder_groups
- Full state machine per destination (queued → dialing → answered/failed → retry)
- Adaptive throttling, max concurrent calls, retry intervals
- Advisory lock for PM2 cluster safety
- Real-time Socket.IO events for every state change
- Recording file or message text payload

**Gaps vs. UI blast path:**
- `recording_reference` field: UI blast accepts this; campaign engine uses `recordingFile`. These must be unified.
- No `pin_required` or `pin_verified_at` tracking in campaign engine (PIN is verified before campaign start by the Lua script, not tracked in the campaign row).
- UI blast accepts `triggered_via = 'API'`; campaign engine accepts 'PHONE','UI','API','SCHEDULE' — superset, no gap.

### 8.4 Migration Steps for UI-Triggered Blast

**Prerequisites:** Sections 8.1-8.3 understood and agreed.

**Step 1: Verify campaignController.triggerCampaign endpoint**
Check if `POST /api/v1/campaigns/:id/trigger` already exists and already calls `createCampaignByConfigId`. If so, the frontend may only need to call this endpoint instead of `POST /api/v1/ens/notifications`.

**Step 2: Align the UI blast API contract**
If the UI needs to trigger a blast with just a configuration ID (no recording — triggers a text-to-speech or pre-configured recording), verify `createCampaignByConfigId` handles this case. It does validate: `if (!recordingFile && !messageAudioUrl && !messageText) { throw error }`.

**Step 3: Update ensController.createNotification (or deprecate it)**
Option A: Redirect `ensController.createNotification` to call `createCampaignByConfigId` and return the campaign ID.
Option B: Deprecate the endpoint with a 301/410 and update the frontend to call the campaigns endpoint.

Option A is preferred because it is non-breaking for the frontend — same URL, same request shape, different backend behavior.

**Step 4: Update ensController.listNotifications**
Redirect to query `ens_campaigns` instead of `ens_notifications`. Match the response shape the frontend expects.

**Step 5: Verify frontend ENS dashboard UI**
The frontend calls `api.ens.notifications()` which maps to `GET /api/v1/ens/notifications`. After Step 4, this returns campaign data. Verify the frontend renders correctly with the new field names.

### 8.5 Historical Data Strategy

**Recommendation: Archival table, not deletion.**

The `ens_notifications` table contains historical blast records from the V1 notification path. These records represent real events that operators may need to reference. Dropping the table without archiving means this history is permanently lost.

**Proposed approach:**
1. At the time of migration, rename `ens_notifications` to `ens_notifications_archived_20260809` (or similar datestamped name).
2. Rename `ens_notification_deliveries` to `ens_notification_deliveries_archived_20260809`.
3. Create new migration that establishes the archived tables as read-only (REVOKE INSERT, UPDATE, DELETE from the application role).
4. Create an admin-only read endpoint that queries the archived tables for historical lookup if needed.
5. After a defined retention period (recommend 12 months minimum), drop the archived tables.

**Alternative (simpler):** Retain the tables with no application writes. Remove all write paths (legacy notification endpoints). Keep read-only access via a historical report endpoint. This is the path of least risk.

**Rollback strategy:**
- Before any migration, take a full `pg_dump` of the `ens_notifications` and `ens_notification_deliveries` tables.
- The archival rename is reversible: rename back + restore application endpoints.
- Application rollback: redeploy the prior version of ensController.js, reports.js, dashboardController.js.

---

## Section 9: ENS Report Migration

### 9.1 Current EnsReport Data Flow

**Frontend:** `EnsReport` page calls `GET /api/v1/reports/ens?page=N&limit=N&from=&to=&status=&org_id=`

**Backend:** `reports.js:431-475`

**SQL executed:**
```sql
SELECT n.id, n.notification_uuid, n.status, n.triggered_via,
       n.caller_number, n.recording_file,
       n.total_targets, n.total_answered, n.total_no_answer, n.total_replayed,
       n.created_at, n.started_at, n.completed_at,
       e.name AS ens_name, e.id AS ens_configuration_id,
       o.name AS org_name, o.id AS organization_id,
       u.full_name AS triggered_by_name
FROM ens_notifications n
JOIN ens_configurations e ON e.id = n.ens_configuration_id
JOIN organizations o ON o.id = e.organization_id
LEFT JOIN users u ON u.id = n.triggered_by_user_id
WHERE n.deleted_at IS NULL AND e.tenant_id = $1
  AND (date/status/org filters)
ORDER BY n.created_at DESC
LIMIT $6 OFFSET $7
```

**Response shape:** `{ notifications: [...rows], total: N, page: N, limit: N }`

### 9.2 Equivalent Query Against ens_campaigns

```sql
-- Replacement query for GET /reports/ens (backed by ens_campaigns)
SELECT c.id::TEXT AS id,               -- NOTE: UUID not INT — frontend must handle
       c.id AS notification_uuid,      -- campaigns use id as the unique identifier
       c.status,                       -- case difference: 'queued' not 'PENDING'
       c.triggered_via,
       c.trigger_number AS caller_number,   -- semantic difference — see Section 5
       c.recording_file,
       c.total_destinations AS total_targets,
       c.answered_count AS total_answered,
       c.no_answer_count AS total_no_answer,
       NULL AS total_replayed,              -- no equivalent — always NULL until new column added
       c.created_at, c.started_at, c.completed_at,
       e.name AS ens_name, e.id AS ens_configuration_id,
       o.name AS org_name, o.id AS organization_id,
       u.full_name AS triggered_by_name
FROM ens_campaigns c
JOIN ens_configurations e ON e.id = c.ens_configuration_id
JOIN organizations o ON o.id = c.organization_id
LEFT JOIN users u ON u.id = c.triggered_by
WHERE e.tenant_id = $1
  AND (date/status/org filters)
ORDER BY c.created_at DESC
LIMIT $6 OFFSET $7
```

### 9.3 Response Contract Issues

The response shape changes in these ways:
- `id` changes from INT (SERIAL) to UUID (TEXT representation). Any frontend code that uses `notification.id` for URL navigation or keying must be updated.
- `notification_uuid` changes from a separate UUID field to the same value as `id`.
- `status` values change case: `PENDING` → `queued`, `IN_PROGRESS` → `running`, etc.
- `total_replayed` becomes NULL (unless a new column is added to ens_campaigns).

**Adapter needed:** The backend can normalize the field names to match the old response shape exactly, allowing the frontend to remain unchanged. This is the recommended approach: produce an adapter layer in reports.js that maps campaign fields to notification field names.

### 9.4 Historical Data

If ens_notifications is archived (not dropped), the `/reports/ens` endpoint can UNION both sources:

```sql
-- UNION query for transitional period (both old and new data)
SELECT notification_uuid, status, triggered_via, caller_number, recording_file,
       total_targets, total_answered, total_no_answer, total_replayed,
       created_at, started_at, completed_at, ens_name, ens_configuration_id,
       org_name, organization_id, triggered_by_name, 'notification' AS source
FROM (/* ens_notifications query */) notifs
UNION ALL
SELECT id::TEXT, status, triggered_via, trigger_number, recording_file,
       total_destinations, answered_count, no_answer_count, NULL,
       created_at, started_at, completed_at, ens_name, ens_configuration_id,
       org_name, organization_id, triggered_by_name, 'campaign' AS source
FROM (/* ens_campaigns query */) campaigns
ORDER BY created_at DESC
LIMIT $N OFFSET $M
```

This provides historical continuity. The `source` column lets the detail view know which table to query for the drilldown.

### 9.5 Migration Steps (Ordered)

1. Update `/reports/ens` backend to query `ens_campaigns` (with UNION for historical data if archiving)
2. Update `/reports/ens/:uuid` backend to query `ens_campaigns` by campaign ID (and fall back to ens_notifications for historical UUIDs if using UNION approach)
3. Verify EnsReport frontend renders correctly with updated response shape (status values, id type)
4. Add adapter layer to normalize field names if frontend cannot be updated simultaneously
5. After validation: remove the UNION leg if ens_notifications is archived; query only ens_campaigns

---

## Section 10: Dashboard Migration

### Dashboard Query 1 — GET /dashboard/metrics → notifications_today

**Current query (dashboardController.js:29-35):**
```sql
SELECT COUNT(n.id)::INT AS n
FROM ens_notifications n
JOIN ens_configurations ec ON ec.id = n.ens_configuration_id
WHERE n.deleted_at IS NULL AND n.created_at >= CURRENT_DATE AND ec.tenant_id = $1
```
**Business metric:** Count of ENS blasts triggered today for this tenant.

**Equivalent against ens_campaigns:**
```sql
SELECT COUNT(c.id)::INT AS n
FROM ens_campaigns c
JOIN ens_configurations ec ON ec.id = c.ens_configuration_id
WHERE c.created_at >= CURRENT_DATE AND ec.tenant_id = $1
```
Note: ens_campaigns has no deleted_at. If soft-delete is needed, add the column first (see Section 5 gap analysis).

**Validation:** Run both queries against production data for the same date range and compare counts. Note that they will differ if any historical ens_notifications rows exist from today (pre-migration data).

---

### Dashboard Query 2 — GET /dashboard/active → recent_notifications

**Current query (dashboardController.js:172-179):**
```sql
SELECT n.notification_uuid, n.status, n.total_targets, n.total_answered,
       n.created_at, e.name AS ens_name
FROM ens_notifications n
JOIN ens_configurations e ON e.id = n.ens_configuration_id
WHERE n.deleted_at IS NULL AND e.tenant_id = $1
ORDER BY n.created_at DESC LIMIT 5
```
**Business metric:** The 5 most recent ENS blasts for this tenant (for the activity feed).

**Equivalent against ens_campaigns:**
```sql
SELECT c.id::TEXT AS notification_uuid,
       c.status,
       c.total_destinations AS total_targets,
       c.answered_count AS total_answered,
       c.created_at,
       e.name AS ens_name
FROM ens_campaigns c
JOIN ens_configurations e ON e.id = c.ens_configuration_id
WHERE e.tenant_id = $1
ORDER BY c.created_at DESC LIMIT 5
```

**Validation:** Compare the 5 most recent rows from both queries. Status values will differ in case.

---

### Dashboard Query 3 — GET /dashboard/chart → notifications time series

**Current query (dashboardController.js:194-199):**
```sql
SELECT date_trunc($1, n.created_at) AS bucket, COUNT(*)::INT AS count
FROM ens_notifications n
JOIN ens_configurations ec ON ec.id = n.ens_configuration_id
WHERE n.created_at >= now() - $2::interval AND n.deleted_at IS NULL AND ec.tenant_id = $3
GROUP BY bucket ORDER BY bucket
```
**Business metric:** Time-series count of ENS blasts for chart rendering (day/week/month buckets).

**Equivalent against ens_campaigns:**
```sql
SELECT date_trunc($1, c.created_at) AS bucket, COUNT(*)::INT AS count
FROM ens_campaigns c
JOIN ens_configurations ec ON ec.id = c.ens_configuration_id
WHERE c.created_at >= now() - $2::interval AND ec.tenant_id = $3
GROUP BY bucket ORDER BY bucket
```

**Validation:** Plot both series for the same period. Pre-migration data in ens_notifications will not appear in the campaign chart until data migration is done.

---

## Section 11: ensController.listNotifications Migration

**Current endpoint:** `GET /api/v1/ens/notifications`

**Request parameters:** `page` (integer, default 1), `limit` (integer, default 50)

**Response fields (current):** All columns of `ens_notifications` plus `ens_name` from `ens_configurations`

**Filtering:** Tenant isolation via `ens_configurations.tenant_id`

**Pagination:** LIMIT/OFFSET

**Status calculation:** None — returns raw status from ens_notifications

**Frontend consumer:** `api.ens.notifications()` used by the ENS dashboard UI (EnsList or similar panel)

**Equivalent implementation against campaign tables:**
```sql
SELECT c.*,
       e.name AS ens_name
FROM ens_campaigns c
JOIN ens_configurations e ON e.id = c.ens_configuration_id
WHERE e.tenant_id = $3
ORDER BY c.created_at DESC
LIMIT $1 OFFSET $2
```

**Field name changes the frontend must handle:**
- `total_destinations` replaces `total_targets`
- `answered_count` replaces `total_answered`
- `no_answer_count` replaces `total_no_answer`
- `id` is now UUID not INT
- `notification_uuid` field does not exist in ens_campaigns (id IS the uuid)

**Migration steps:**
1. Update `ensController.listNotifications` to query ens_campaigns
2. Add a response adapter that maps campaign field names to the old notification field names (to avoid a simultaneous frontend change)
3. Test that the frontend ENS dashboard still renders correctly
4. After frontend updated: remove the adapter layer and use campaign field names directly

---

## Section 12: ReportNotifications and ReportEnsBroadcasts

### ReportNotifications

**Route:** `/reports/notifications` (App.jsx:111)
**Backend:** `GET /api/v1/reports/notifications` (reports.js:11-30)
**DB tables:** `ens_notifications` (JOIN ens_configurations, organizations, users)
**What it shows:** Flat list of all ENS notifications with status, trigger info, and basic counts
**Equivalent in campaign architecture:** `GET /api/v1/reports/ens-campaigns` already exists and shows the same data from ens_campaigns
**Recommendation:** REMOVE after ens_notifications migration — `EnsReport` at `/reports/ens` (rewritten to use campaigns) replaces it

### ReportEnsBroadcasts

**Route:** `/reports/ens-broadcasts` (App.jsx:114)
**Backend:** `GET /api/v1/reports/ens-broadcasts` (reports.js:146-199)
**DB tables:** `ens_notifications`, `ens_notification_deliveries`, `audit_logs`
**What it shows:** Full per-notification detail with per-contact delivery rows and playback access log
**Equivalent in campaign architecture:** `GET /api/v1/reports/ens-campaigns/:id` shows per-campaign detail with per-destination rows. The playback access log is still queryable from `audit_logs` (same table, no migration needed).
**Recommendation:** REMOVE after ens_notifications migration — `CampaignDashboard` at `/ens/campaigns` backed by `/reports/ens-campaigns/:id` replaces it

---

## Section 13: Legacy API Retirement (/internal/ens/notifications/*)

All routes are defined in `backend/src/routes/internal/ens.js:34-38`:

| Route | Controller Function | Writes | Reads | Status |
|---|---|---|---|---|
| GET /internal/ens/notifications/queue-status | ensInternalController.ensQueueStatus | None | ens_notifications | Legacy — no active Lua caller |
| POST /internal/ens/notifications | ensInternalController.ensCreateNotification | ens_notifications | None | Legacy write path — no active Lua caller (current Lua uses campaign/start) |
| GET /internal/ens/notifications/:uuid/pending-contacts | ensInternalController.ensPendingContacts | None | ens_notifications + emergency_contacts | Legacy — no active Lua caller |
| PATCH /internal/ens/notifications/:uuid/delivery | ensInternalController.ensUpdateDelivery | ens_notification_deliveries | None | Legacy — no active Lua caller |
| POST /internal/ens/notifications/:uuid/complete | ensInternalController.ensCompleteNotification | ens_notifications | None | Legacy — no active Lua caller |

**Which Lua script calls these:** NONE. The current `ens_blast_trigger.lua` calls `POST /internal/ens/campaign/start`. The legacy notification endpoints were the V1 Lua integration path. Phase 2 Safety Report confirmed the blast trigger Lua uses the campaign path.

**Required verification before retirement:** Inspect deployed FreeSWITCH instances to confirm no outdated Lua scripts are installed that still call these endpoints. Check both the standard Lua script directory and any site-specific overrides. If any outdated deployments exist, they must be updated to the current `ens_blast_trigger.lua` before these endpoints are removed.

**Retirement sequence:**
1. Verify via FreeSWITCH Lua directory audit (not possible via static analysis)
2. Remove the 5 routes from `backend/src/routes/internal/ens.js:34-38`
3. Remove the corresponding controller functions from `ensInternalController.js`
4. Remove associated D() call sites (already removed in Phase A if Phase A was done first)

---

## Section 14: Lua Migration

**Current production Lua scripts do NOT call legacy notification endpoints.** All three active scripts use campaign or callback paths:

| Lua Script | Current Calls | Legacy Notification Calls | Action Needed |
|---|---|---|---|
| `Lua-scripts/ens_blast_trigger.lua` | GET /internal/ens/lookup, POST /internal/ens/verify-pin, POST /internal/ens/campaign/start | None | No change needed |
| `Lua-scripts/ens_playback_handler.lua` | GET /internal/ens/lookup, GET /internal/ens/campaigns/latest, POST /internal/ens/callbacks | None | No change needed |
| `Lua-scripts/ers_conference_bridge.lua` | GET /internal/ers/lookup, POST /internal/ers/incidents, POST /internal/ers/incidents/:uuid/complete, etc. | None | No change needed |

**FreeSWITCH reload/deployment considerations:**
- The three active Lua scripts do not require changes for any cleanup phase in this plan.
- Deleting the legacy directory (`Lua-scripts/legacy/`) does not affect FreeSWITCH operation since these files are not referenced in any dialplan.
- If the Deployment.txt reference to `dial_911_conference.lua` is updated, no FreeSWITCH reload is needed — it is a documentation file.

---

## Section 15: Test Migration

Tests that reference legacy tables or endpoints must be updated or removed when the corresponding items are retired.

| Test File | References | Action |
|---|---|---|
| `backend/src/__tests__/integration/internal-api.test.js` | ens_notifications (cleanup DELETE statements, assertion queries) | When ens_notifications is retired: rewrite to clean ens_campaigns, update assertions to campaign data |
| `backend/src/__tests__/integration/phase1-regression.test.js` | ens_notifications (cleanup DELETE statements) | Same — update cleanup to use ens_campaigns |
| Any test that calls `POST /api/v1/ens/notifications` | UI blast endpoint | When endpoint is retired: update to call campaign endpoint or remove test |
| Any test that calls `GET /api/v1/reports/notifications` | Legacy report endpoint | When endpoint is retired: remove test or rewrite to use `/reports/ens-campaigns` |
| Any test that calls `/internal/ens/notifications/*` | Legacy Lua endpoints | When endpoints are retired: remove these test cases |

**Principle:** Do not modify tests during Phases A-C. Tests that touch ens_notifications will continue to pass as long as the table exists. Test migration is part of Phase F work only.

---

## Section 16: Migration Ordering (Dependency-Aware)

```
Phase A: Debug instrumentation removal
  Items: ENS_PROBE, ENS_DEBUG, const D + call sites
  Blocked by: Nothing
  Unlocks: Cleaner logs for all subsequent testing
  Commit: One commit

Phase B: Legacy ERS report page pair
  Items: ReportIncidents, ReportErsIncidents (pages + routes + endpoints + API methods)
  Blocked by: Nothing (reads only active tables)
  Unlocks: Reduced dead code in frontend and backend
  Commit: One commit

Phase C: Database dead table/column removal (migration 041)
  Items: ens_contacts, ens_groups, ens_group_members, notification_templates,
         tenant_mappings, ens_configuration_contacts.ens_contact_id,
         ens_configuration_groups.ens_group_id, media_files.duration_seconds
  Blocked by: Nothing (all verified dead with zero consumers)
  Unlocks: Schema cleanup; FK graph simplification
  Commit: One commit (migration file + schema.sql comments update)

Phase D: Startup deduplication
  Items: checkCredentials() function + its invocation
  Blocked by: Confirming validateEnvironment() boot diagnostic is preserved
  Unlocks: Cleaner startup code
  Commit: One commit

Phase E: Legacy Lua archive deletion
  Items: Lua-scripts/legacy/ directory (3 files) + Deployment.txt update + docs update
  Blocked by: Phase A recommended first (to avoid logs noise while verifying)
  Unlocks: Cleaner Lua-scripts/ directory
  Commit: One commit (files deletion + documentation updates)

Phase F1: EnsReport backend migration
  Items: Rewrite GET /reports/ens and GET /reports/ens/:uuid to read from ens_campaigns
  Blocked by: Nothing technically; requires Phase 8 design decisions (UNION or not)
  Unlocks: Phase F2, F3, F4, F5
  Commit: One commit (backend only)

Phase F2: Dashboard migration
  Items: Rewrite 3 queries in dashboardController.js
  Blocked by: Phase F1 (verify campaign engine is producing usable data for all tenants)
  Unlocks: Phase F3
  Commit: One commit

Phase F3: ensController blast path migration
  Items: Rewrite createNotification to call createCampaignByConfigId; rewrite listNotifications
  Blocked by: Phase F1, Phase F2 (confirm campaign data is reliable before redirecting writes)
  Unlocks: Phase F4, F5, F6
  Commit: One commit

Phase F4: Legacy ENS report page pair
  Items: ReportNotifications, ReportEnsBroadcasts (pages + routes + endpoints + API methods)
  Blocked by: Phase F1, F2, F3 complete; EnsReport must serve campaign data correctly
  Unlocks: Phase F5
  Commit: One commit

Phase F5: Legacy internal notification endpoints
  Items: /internal/ens/notifications/* (5 routes + controller functions)
  Blocked by: Phase F3 (write path redirected); FreeSWITCH Lua audit completed
  Unlocks: Phase F6
  Commit: One commit

Phase F6: Test migration
  Items: Update integration tests from ens_notifications to ens_campaigns
  Blocked by: Phase F5 (all notification paths retired)
  Unlocks: Phase F7
  Commit: One or more commits per test file

Phase F7: Database table retirement
  Items: DROP TABLE ens_notification_deliveries, DROP TABLE ens_notifications
         (or RENAME to archived tables)
  Blocked by: Phase F1 through F6 complete; all tests passing
  Unlocks: Schema cleanup complete
  Commit: One migration file

Phase G: Legacy /api/health probe removal
  Items: Remove inline /api/health handler from server.js
  Blocked by: External monitoring audit (not possible via static analysis)
  Can run in parallel with Phase F series if external audit is completed
  Commit: One commit
```

---

## Section 17: Validation Strategy

### Phase A Validation
- **Static:** Grep for `ENS_PROBE`, `ENS_DEBUG`, `const D =`, `D(` in the edited files — must return zero hits
- **Backend tests:** `cd backend && npm test` — all tests must pass
- **Log validation:** Check PM2/stdout that [ENS_PROBE] entries no longer appear on server start

### Phase B Validation
- **Static:** Verify App.jsx no longer imports or routes ReportIncidents/ReportErsIncidents
- **Backend tests:** `npm test` — all tests pass
- **Frontend tests:** Navigate to `/reports/incidents` — must redirect to `/` (catch-all route)
- **ErsReport validation:** `/reports/ers` still loads and returns data
- **API tests:** `GET /api/v1/reports/ers` returns 200; `GET /api/v1/reports/incidents` returns 404

### Phase C Validation
Pre-migration:
- Run validation queries from Section 7 — all must return 0 rows
- Take `pg_dump` backup of affected tables before running migration

Post-migration:
- `\dt ens_contacts` in psql — must not exist
- `\dt ens_groups` — must not exist
- `\dt ens_group_members` — must not exist
- `\dt notification_templates` — must not exist
- `\dt tenant_mappings` — must not exist
- `\d ens_configuration_contacts` — `ens_contact_id` column must not appear
- `\d ens_configuration_groups` — `ens_group_id` column must not appear
- `\d media_files` — `duration_seconds` column must not appear
- `cd backend && npm run migrate` on a fresh DB — must complete cleanly
- `cd backend && npm test` — all tests pass (no test references these dead tables)

### Phase F Validation (per step)
- **F1 (reports):** EnsReport page loads and shows data; `/reports/ens` returns same total count as before (campaigns + notifications if UNION); response shape matches what frontend expects
- **F2 (dashboard):** Dashboard loads; `notifications_today` count is correct; chart renders; recent_notifications shows latest blasts
- **F3 (blast path):** POST to blast endpoint creates an ens_campaigns row; campaign engine begins dialing; Socket.IO events fire; Campaign dashboard shows the new campaign
- **F4 (legacy pages):** Navigating to `/reports/notifications` redirects; `/reports/ens-broadcasts` redirects
- **F5 (legacy endpoints):** `GET /internal/ens/notifications/queue-status` returns 404; test all 5 routes return 404
- **F6 (tests):** `npm test` — all tests pass with updated assertions
- **F7 (tables):** psql `\dt ens_notifications` — not found; `\dt ens_notification_deliveries` — not found

### Security / Tenant Isolation Checks
- After F1: verify `/reports/ens` cannot return campaigns from another tenant (query `e.tenant_id = $1` must be present)
- After F2: verify dashboard queries scope via tenant join (no cross-tenant data leakage)
- After F3: verify `createCampaignByConfigId` with `tenantId = req.user.tenantId` correctly rejects configurations from other tenants

---

## Section 18: Rollback Strategy

### Phase A Rollback
- Git revert the commit. No DB changes. No downtime required.

### Phase B Rollback
- Git revert the commit. Restore the 4 deleted frontend files from git history. No DB changes.

### Phase C Rollback
- **Before migration:** `pg_dump` backup of affected tables (they are expected to be empty, but confirm).
- **After migration:** If rollback is needed, restore from the pg_dump. Write a reverse migration (042_rollback_drop_dead_tables.sql) that recreates the tables and columns with their original DDL.
- **Application rollback:** Git revert the migration file commit. Run the reverse migration on the database. Rollback migration.js tracking: `DELETE FROM schema_migrations WHERE version = '041_drop_dead_ens_v1_tables.sql'`.

### Phase F Rollback (any step)
- **Before any Phase F step:** `pg_dump` the entire database (or at minimum ens_notifications, ens_notification_deliveries, ens_campaigns, ens_campaign_destinations).
- **F1 rollback:** Revert reports.js to query ens_notifications. No DB change.
- **F2 rollback:** Revert dashboardController.js. No DB change.
- **F3 rollback:** Revert ensController.js. No DB change. Any blasts triggered via campaign engine during F3 will remain in ens_campaigns; no rollback of campaign data is needed.
- **F4 rollback:** Restore frontend pages from git history.
- **F5 rollback:** Restore the 5 internal routes and their controller functions.
- **F7 rollback:** If ens_notifications was RENAMED (not dropped), rename back. If dropped: restore from pg_dump. Write reverse migration.

---

## Section 19: Risk Register

| Risk | Component | Impact | Probability | Mitigation |
|---|---|---|---|---|
| Report regression — EnsReport shows no data after migration | reports.js, EnsReport page | HIGH — operators lose blast history view | MEDIUM — migration is non-trivial | Use UNION query during transition; validate row counts before and after |
| Historical data loss — ens_notifications dropped without archival | ens_notifications | HIGH — permanent loss of historical blast records | LOW — if archival recommendation is followed | Rename to archived table; do not DROP until 12-month retention period |
| Campaign behavior change — UI blast no longer creates ens_notifications row | ensController.js | MEDIUM — blast tracking changes; old bookmarks to notification UUIDs break | MEDIUM | Redirect blast to campaign; confirm campaign ID propagates to all UI components |
| FreeSWITCH regression — legacy Lua script on an unaudited deployment calls /internal/ens/notifications/* | Internal API | HIGH — ENS blasts fail silently on that deployment | LOW — current Lua uses campaign/start | Audit all FreeSWITCH Lua deployments before retiring notification endpoints |
| Lua regression — legacy Lua files deleted but still referenced in an old dialplan | Lua-scripts/legacy/ | HIGH — FreeSWITCH fails to execute the Lua script | LOW — deployment engine does not reference these | Search FreeSWITCH dialplan directory before deleting; confirm no `<action application="lua" data="blast_call.lua"/>` entries |
| Tenant isolation regression — new campaign queries missing tenant_id scope | dashboardController.js, reports.js | HIGH — cross-tenant data leakage | LOW — ens_campaigns scopes via ens_configurations.tenant_id | Validate every replacement query includes tenant filter; write negative test (assert tenant B cannot see tenant A's campaigns) |
| Dashboard calculation regression — notifications_today count changes after migration | dashboardController.js | MEDIUM — metric on dashboard becomes unreliable during transition | MEDIUM — pre-migration notifications are in different table | Use UNION with archived table during transition period; document expected count change |
| API contract regression — EnsReport response shape changes (id type, status case) | reports.js, EnsReport | MEDIUM — frontend breaks on field name mismatch | MEDIUM | Add response adapter in reports.js; test frontend before removing adapter |
| Frontend regression — legacy API methods removed before pages | client.js | MEDIUM — pages that call the method throw a runtime error | LOW — if removal order is respected (pages first) | Follow cleanup sequence strictly: page → route → endpoint → API method |
| Migration rollback failure — ens_notifications dropped without adequate backup | ens_notifications | HIGH — unrecoverable data loss | LOW — if pg_dump is taken first | Require pg_dump confirmation before executing DROP; test restore procedure |
| ReferenceError from remaining D() call sites | ensInternalController.js | HIGH — ENS internal API crashes on every request | MEDIUM — easy to miss call sites | After edit, grep for `D(` in the file; must be zero |

---

## Section 20: Files Expected to Change

### Phase A
- `backend/server.js` — remove ENS_PROBE block (lines 65-74), remove checkCredentials() (Phase D)
- `backend/src/routes/internal/ens.js` — remove ENS_DEBUG block (lines 7-19), remove unused logger import
- `backend/src/controllers/internal/ensInternalController.js` — remove const D (line 10) and all D() call sites

### Phase B
- `frontend/src/pages/reports/ReportIncidents.jsx` — DELETE FILE
- `frontend/src/pages/reports/ReportErsIncidents.jsx` — DELETE FILE
- `frontend/src/App.jsx` — remove 2 imports, 2 route entries
- `frontend/src/api/client.js` — remove api.reports.incidents, api.reports.ersIncidents methods
- `backend/src/routes/v1/reports.js` — remove /incidents and /ers-incidents route handlers

### Phase C
- `backend/src/db/migrations/041_drop_dead_ens_v1_tables.sql` — NEW FILE (migration)
- `backend/src/db/schema.sql` — update comments to remove DEPRECATED notes (optional but recommended)

### Phase D
- `backend/server.js` — remove checkCredentials() function and its call

### Phase E
- `Lua-scripts/legacy/blast_call.lua` — DELETE FILE
- `Lua-scripts/legacy/dial_911_conference.lua` — DELETE FILE
- `Lua-scripts/legacy/ENS_retry_playback.lua` — DELETE FILE
- `Deployment.txt` — update line 144 reference
- `docs/01_System_Architecture.md` — update Lua script references
- `docs/02_Backend_Folder_Structure.md` — update Lua script references
- `docs/03_API_REFERENCE.md` — update Lua script references
- `docs/08_ESL_AND_FREESWITCH.md` — update Lua script references

### Phase F
- `backend/src/routes/v1/reports.js` — rewrite /ens and /ens/:uuid; remove /notifications and /ens-broadcasts
- `backend/src/controllers/dashboardController.js` — rewrite 3 queries
- `backend/src/controllers/ensController.js` — rewrite createNotification and listNotifications
- `backend/src/routes/internal/ens.js` — remove 5 notification routes
- `backend/src/controllers/internal/ensInternalController.js` — remove 5 controller functions
- `frontend/src/pages/reports/ReportNotifications.jsx` — DELETE FILE
- `frontend/src/pages/reports/ReportEnsBroadcasts.jsx` — DELETE FILE
- `frontend/src/App.jsx` — remove 2 imports, 2 route entries
- `frontend/src/api/client.js` — remove api.reports.notifications, api.reports.ensBroadcasts methods
- `backend/src/__tests__/integration/internal-api.test.js` — update ens_notifications references
- `backend/src/__tests__/integration/phase1-regression.test.js` — update ens_notifications references
- `backend/src/db/migrations/042_archive_ens_notifications.sql` — NEW FILE (archival migration)

### Phase G
- `backend/server.js` — remove /api/health inline handler (lines 89-92)

---

## Section 21: Files That Must NOT Change

| File | Reason |
|---|---|
| `backend/src/services/conferenceManager.js` | FALSE POSITIVE — actively used via dynamic import in eslService.js and static import in ersInternalController.js |
| `backend/src/services/campaignEngine.js` | Core campaign engine — active, no cleanup required |
| `backend/src/services/eslService.js` | Core ESL integration — active |
| `backend/src/controllers/internal/ensInternalController.js` | Only the D() items are removed — the surrounding functions (ensLookup, verifyPin, startCampaign, etc.) are active and must not be changed until Phase F |
| `Lua-scripts/ens_blast_trigger.lua` | Active production script |
| `Lua-scripts/ens_playback_handler.lua` | Active production script |
| `Lua-scripts/ers_conference_bridge.lua` | Active production script |
| `backend/src/db/schema.sql` (the tables themselves) | Only comments should be updated; no DDL changes to active tables |
| `ens_notifications` table (the DB table) | Must not be dropped until Phase F is complete |
| `ens_notification_deliveries` table | Same |
| `backend/src/routes/v1/reports.js` (the /ens-campaigns endpoints) | Active campaign report endpoints — these replace the legacy endpoints, do not touch |
| `backend/src/controllers/campaignController.js` | Active — manages campaign lifecycle from UI |
| `backend/src/infrastructure/` | Health, Redis, logger infrastructure — active |
| All files under `backend/src/controllers/internal/` EXCEPT ensInternalController.js D() items | Active internal API controllers |

---

## Section 22: Proposed Commit Structure

```
Commit 1: "chore: remove TEMPORARY ENS debug instrumentation"
  - backend/server.js (remove ENS_PROBE block)
  - backend/src/routes/internal/ens.js (remove ENS_DEBUG block + unused logger import)
  - backend/src/controllers/internal/ensInternalController.js (remove const D + all D() calls)
  Dependencies: None
  Reversible: Yes — git revert

Commit 2: "chore: remove legacy ERS report pages (read only active tables)"
  - frontend/src/pages/reports/ReportIncidents.jsx (delete)
  - frontend/src/pages/reports/ReportErsIncidents.jsx (delete)
  - frontend/src/App.jsx (remove 2 imports + 2 routes)
  - frontend/src/api/client.js (remove incidents + ersIncidents methods)
  - backend/src/routes/v1/reports.js (remove /incidents + /ers-incidents handlers)
  Dependencies: None
  Reversible: Yes — git revert + restore deleted files

Commit 3: "feat(db): migration 041 — drop dead ENS V1 tables and legacy columns"
  - backend/src/db/migrations/041_drop_dead_ens_v1_tables.sql (new file)
  Dependencies: None (all tables verified dead)
  Reversible: Yes — reverse migration + pg_dump restore

Commit 4: "chore: remove checkCredentials() startup duplicate"
  - backend/server.js (remove checkCredentials function + call)
  Dependencies: Confirm validateEnvironment() covers all same checks
  Reversible: Yes — git revert

Commit 5: "chore: delete legacy Lua archive and update documentation"
  - Lua-scripts/legacy/ (delete 3 files)
  - Deployment.txt (update line 144)
  - docs/*.md (update script name references)
  Dependencies: None
  Reversible: Yes — git revert + restore deleted files

Commit 6: "feat(reports): rewrite ENS report to read from ens_campaigns"
  - backend/src/routes/v1/reports.js (/ens and /ens/:uuid)
  Dependencies: Campaign engine producing data for all tenants
  Reversible: Yes — git revert
  Note: Run in production with UNION first if historical data must be preserved

Commit 7: "feat(dashboard): migrate dashboard metrics to ens_campaigns"
  - backend/src/controllers/dashboardController.js
  Dependencies: Commit 6 validated in production
  Reversible: Yes — git revert

Commit 8: "feat(ens): redirect UI blast through campaign engine"
  - backend/src/controllers/ensController.js (createNotification + listNotifications)
  Dependencies: Commits 6, 7 validated
  Reversible: Yes — git revert

Commit 9: "chore: remove legacy ENS report pages and notification endpoints"
  - frontend/src/pages/reports/ReportNotifications.jsx (delete)
  - frontend/src/pages/reports/ReportEnsBroadcasts.jsx (delete)
  - frontend/src/App.jsx (remove 2 imports + 2 routes)
  - frontend/src/api/client.js (remove notifications + ensBroadcasts methods)
  - backend/src/routes/v1/reports.js (remove /notifications + /ens-broadcasts handlers)
  Dependencies: Commit 8 validated; EnsReport working on campaign data
  Reversible: Yes — git revert + restore deleted files

Commit 10: "chore: retire legacy internal ENS notification endpoints"
  - backend/src/routes/internal/ens.js (remove 5 notification routes)
  - backend/src/controllers/internal/ensInternalController.js (remove 5 controller functions)
  Dependencies: Commit 9; FreeSWITCH Lua audit completed
  Reversible: Yes — git revert

Commit 11: "test: update integration tests from ens_notifications to ens_campaigns"
  - backend/src/__tests__/integration/internal-api.test.js
  - backend/src/__tests__/integration/phase1-regression.test.js
  Dependencies: Commit 10
  Reversible: Yes — git revert

Commit 12: "feat(db): migration 042 — archive ens_notifications tables"
  - backend/src/db/migrations/042_archive_ens_notifications.sql (new file)
  Dependencies: All Phase F commits validated; pg_dump backup taken
  Reversible: Rename back + restore from pg_dump

Commit 13 (optional): "chore: remove legacy /api/health probe"
  - backend/server.js (remove /api/health inline handler)
  Dependencies: External monitoring audit completed
  Reversible: Yes — git revert
```

---

## Section 23: Final Definition of Done

The dead code cleanup is complete when ALL of the following are true:

**Code cleanup:**
- [ ] No `ENS_PROBE` or `ENS_DEBUG` markers in any source file
- [ ] No `const D =` debug helper in ensInternalController.js
- [ ] No `D(` call sites in ensInternalController.js
- [ ] `ReportIncidents.jsx` and `ReportErsIncidents.jsx` do not exist
- [ ] `ReportNotifications.jsx` and `ReportEnsBroadcasts.jsx` do not exist
- [ ] `checkCredentials()` does not exist in server.js
- [ ] `api.reports.notifications`, `api.reports.incidents`, `api.reports.ersIncidents`, `api.reports.ensBroadcasts` do not exist in client.js

**Database cleanup:**
- [ ] `ens_contacts`, `ens_groups`, `ens_group_members` tables do not exist
- [ ] `notification_templates`, `tenant_mappings` tables do not exist
- [ ] `ens_configuration_contacts.ens_contact_id` column does not exist
- [ ] `ens_configuration_groups.ens_group_id` column does not exist
- [ ] `media_files.duration_seconds` column does not exist
- [ ] `ens_notifications` and `ens_notification_deliveries` are retired (archived or dropped)

**API cleanup:**
- [ ] `/api/v1/reports/incidents` returns 404
- [ ] `/api/v1/reports/ers-incidents` returns 404
- [ ] `/api/v1/reports/notifications` returns 404
- [ ] `/api/v1/reports/ens-broadcasts` returns 404
- [ ] `/internal/ens/notifications/*` (all 5 routes) return 404

**Lua cleanup:**
- [ ] `Lua-scripts/legacy/` directory does not exist

**Functional correctness:**
- [ ] EnsReport page (`/reports/ens`) loads and shows all ENS blasts (from campaign engine)
- [ ] CampaignDashboard (`/ens/campaigns`) loads and shows campaign detail
- [ ] Dashboard metrics show correct `notifications_today` count from ens_campaigns
- [ ] Dashboard chart renders ENS blast timeline correctly from ens_campaigns
- [ ] Dashboard active panel shows recent ENS blasts from ens_campaigns
- [ ] UI-triggered blast creates an `ens_campaigns` row and the campaign engine dials out
- [ ] Lua-triggered blast continues to work (ens_blast_trigger.lua → /internal/ens/campaign/start)
- [ ] ErsReport page (`/reports/ers`) loads correctly (independent of ENS migration)
- [ ] All backend tests pass: `cd backend && npm test`

---

## ITEMS APPROVED FOR FIRST CLEANUP BATCH

These items have HIGH confidence, zero migration dependency, and can be implemented in the first sprint of cleanup work:

1. **ENS_PROBE middleware** (server.js:65-74) — single block deletion
2. **ENS_DEBUG middleware** (internal/ens.js:7-19) + unused logger import
3. **const D helper + all D() call sites** (ensInternalController.js:10 + ~10 call sites)
4. **ReportIncidents page + route + endpoint + API method** (4 files touched)
5. **ReportErsIncidents page + route + endpoint + API method** (4 files touched)
6. **Lua-scripts/legacy/** directory (3 files deleted + docs updated)
7. **Migration 041** (drops 5 tables and 3 columns)
8. **FRONTEND_PORT banner reference** (1 line in server.js)

Expected effort: 1-2 focused sessions. Zero downtime. Independently reversible.

---

## ITEMS BLOCKED BY MIGRATION

These items cannot be touched until the ENS notification migration (Phase F) is complete:

1. `ens_notifications` table — active reads by EnsReport, dashboard (3 queries), ensController.listNotifications
2. `ens_notification_deliveries` table — active reads by EnsReport detail view
3. `ReportNotifications.jsx` page and `/reports/notifications` endpoint — reads ens_notifications
4. `ReportEnsBroadcasts.jsx` page and `/reports/ens-broadcasts` endpoint — reads ens_notifications + ens_notification_deliveries
5. `api.reports.notifications` and `api.reports.ensBroadcasts` frontend methods
6. `/internal/ens/notifications/*` legacy endpoint group — requires FreeSWITCH audit first

Phase F is estimated to require: 2-4 developer-days of implementation plus validation time.

---

## ITEMS THAT MUST REMAIN

These items were flagged as candidates at some point but must not be removed:

| Item | Reason |
|---|---|
| `conferenceManager.js` | False positive — actively used via dynamic import in eslService.js and static import in ersInternalController.js |
| `ens_notifications` / `ens_notification_deliveries` | Active reads by EnsReport, dashboard, and ensController.listNotifications — not safe until Phase F complete |
| `esl_connections` table | Written by eslService.js heartbeat; drives ESL liveness tracking |
| `audit_logs` table | Written by internal controllers; read by reports |
| `config_versions` / `config_audit_log` | Platform Config Center (Phase 7) — active |
| All three production Lua scripts in `Lua-scripts/` root | Active FreeSWITCH integration |
| `responder_groups` / `responder_group_members` | Canonical group model — active (distinct from dead ens_groups) |
| `emergency_contacts` | Canonical contact model — active |
| `checkCredentials()` (until Phase D) | Still runs at startup; Phase D validates validateEnvironment() covers all same checks first |
| `/api/health` probe (until Phase G) | External monitoring may target this URL; requires audit before removal |
