# FS-ENRS Dead Code Cleanup — Implementation Result

**Date:** 2026-08-09  
**Branch:** main (base commit: 30cc654)  
**Phases implemented:** A, B, C, D  
**Implemented by:** Claude Code (controlled implementation — Phases A–D only)

---

## 1. Implementation Summary

All four approved phases were implemented successfully. Changes are limited to:
- Removal of temporary debug instrumentation (Phase A)
- Removal of two redundant ERS report pages and their backend endpoints (Phase B)
- Deletion of three legacy Lua files and one documentation line update (Phase C)
- Database migration 041 removing five dead tables and three dead columns (Phase D)

No changes were made to campaign execution logic, the ENS notification architecture, active reporting, or any FreeSWITCH/ESL paths.

---

## 2. Files Deleted

| File | Phase | Reason |
|---|---|---|
| `frontend/src/pages/reports/ReportIncidents.jsx` | B | Legacy ERS report page; redundant with active ErsReport |
| `frontend/src/pages/reports/ReportErsIncidents.jsx` | B | Legacy ERS detail report; redundant with active ErsReport |
| `Lua-scripts/legacy/blast_call.lua` | C | Superseded by `ens_blast_trigger.lua`; not in any active dialplan |
| `Lua-scripts/legacy/dial_911_conference.lua` | C | Superseded by `ers_conference_bridge.lua`; not in any active dialplan |
| `Lua-scripts/legacy/ENS_retry_playback.lua` | C | Superseded by `ens_playback_handler.lua`; not in any active dialplan |

---

## 3. Files Modified

| File | Phase | Change |
|---|---|---|
| `backend/server.js` | A | Removed `ENS_PROBE` global middleware block (lines 65–74 in original) |
| `backend/src/routes/internal/ens.js` | A | Removed `ENS_DEBUG` router middleware block; removed now-unused `logger` import |
| `backend/src/controllers/internal/ensInternalController.js` | A | Removed `const D` declaration; removed all 10 `D(...)` call sites in `startCampaignByConfig` and `ensCreateNotification` |
| `frontend/src/App.jsx` | B | Removed `ReportIncidents` and `ReportErsIncidents` imports and their two route declarations |
| `backend/src/routes/v1/reports.js` | B | Removed `GET /reports/incidents` handler; removed `GET /reports/ers-incidents` handler |
| `frontend/src/api/client.js` | B | Removed `api.reports.incidents()` and `api.reports.ersIncidents()` methods |
| `Deployment.txt` | C | Line 144: updated `dial_911_conference.lua` → `ers_conference_bridge.lua` in manual test command |

---

## 4. Database Migration Created

**File:** `backend/src/db/migrations/041_remove_obsolete_ens_v1_objects.sql`

**Objects removed:**

| Object | Type | Reason |
|---|---|---|
| `ens_configuration_contacts.ens_contact_id` | Column | FK to dead `ens_contacts`; dead path |
| `ens_configuration_groups.ens_group_id` | Column | FK to dead `ens_groups`; dead path |
| `ens_group_members` | Table | ENS V1 — child of ens_contacts and ens_groups |
| `ens_contacts` | Table | ENS V1 — superseded by emergency_contacts |
| `ens_groups` | Table | ENS V1 — superseded by responder_groups |
| `notification_templates` | Table | Created migration 001; FK dropped by migration 036; zero app references |
| `tenant_mappings` | Table | Created migration 001; zero app references |
| `media_files.duration_seconds` | Column | Legacy alias; canonical column is `duration_sec` |

**Safety guards:** The migration includes `DO $$ ... $$` precondition blocks that COUNT(*) each table before dropping it. If any supposedly-empty table contains rows, the transaction is aborted with an explanatory error message — no silent data loss.

**Drop ordering:** FK columns in junction tables → `ens_group_members` (child FKs) → `ens_contacts` → `ens_groups` → `notification_templates` → `tenant_mappings` → `media_files.duration_seconds`.

**Migration has NOT been run against any database.** It must be applied and validated in a staging environment before production.

---

## 5. Objects NOT Removed (Explicitly Preserved)

| Object | Status | Reason |
|---|---|---|
| `ens_notifications` | **UNTOUCHED** | Still actively read by EnsReport, dashboard, and listNotifications |
| `ens_notification_deliveries` | **UNTOUCHED** | Dependency of ens_notifications consumers |
| `conferenceManager.js` | **UNTOUCHED** | FALSE POSITIVE — actively used via dynamic imports in eslService.js and static import in ersInternalController.js |
| `checkCredentials()` | **UNTOUCHED** | Out of scope — deferred for controlled decision |
| `/api/health` | **UNTOUCHED** | Out of scope — external monitoring dependency unverified |
| `ReportNotifications` | **UNTOUCHED** | Depends on ens_notifications (Phase F migration required) |
| `ReportEnsBroadcasts` | **UNTOUCHED** | Depends on ens_notifications (Phase F migration required) |
| `/internal/ens/notifications/*` | **UNTOUCHED** | Legacy API — retire only after ENS notification migration |
| `campaignEngine.js` | **UNTOUCHED** | Active production code — not touched |
| `campaignController.js` | **UNTOUCHED** | Active production code — not touched |
| `ens_blast_trigger.lua` | **UNTOUCHED** | Active Lua script |
| `ens_playback_handler.lua` | **UNTOUCHED** | Active Lua script |
| `ers_conference_bridge.lua` | **UNTOUCHED** | Active Lua script |

---

## 6. Validation Results

### Static reference scan (Phase A)
- `ENS_PROBE`: **CLEAN** — no references in `backend/src/` or `backend/server.js`
- `ENS_DEBUG`: **CLEAN** — no references in `backend/src/`
- `const D =` debug helper: **CLEAN** — no remaining call sites in `ensInternalController.js`
- Remaining `const d =` matches are Zod parse assignments (`const d = Schema.parse(...)`) — unrelated, correct

### Static reference scan (Phase B)
- `ReportIncidents` / `ReportErsIncidents`: **CLEAN** in frontend/src and backend/src
- `reports/incidents` / `reports/ers-incidents`: remaining references are only in migration file comments (016, 028) — historical artifacts, correct to keep

### Static reference scan (Phase C)
- `blast_call.lua`, `dial_911_conference.lua`, `ENS_retry_playback.lua`: remaining references are only in `docs/` narrative documentation and the audit report files — not operational paths
- `Lua-scripts/legacy/` directory: verified empty after deletion

### Active Lua scripts: **UNTOUCHED** — confirmed present
- `Lua-scripts/ens_blast_trigger.lua` ✓
- `Lua-scripts/ens_playback_handler.lua` ✓
- `Lua-scripts/ers_conference_bridge.lua` ✓

### Git diff review
- Modified files: 7 (all Phase A/B/C)
- Deleted files: 5 (2 frontend pages, 3 Lua legacy)
- New files: 1 (migration 041)
- Unrelated files changed: 0

### Backend tests
**NOT RUN** — npm not available in the current sandbox environment. Must be run locally:
```
cd backend && npm test
```

### Frontend build
**NOT RUN** — npm not available in the current sandbox environment. Must be run locally:
```
cd frontend && npm run build
```

### Migration 041
**NOT RUN** — must be applied to a staging database before production:
```
cd backend && node src/db/migrate.js
```
Then validate with:
```sql
SELECT to_regclass('public.ens_contacts');         -- expect NULL
SELECT to_regclass('public.ens_groups');            -- expect NULL
SELECT to_regclass('public.ens_group_members');     -- expect NULL
SELECT to_regclass('public.notification_templates'); -- expect NULL
SELECT to_regclass('public.tenant_mappings');       -- expect NULL

-- Verify retained tables
SELECT to_regclass('public.ens_notifications');              -- expect non-NULL
SELECT to_regclass('public.ens_notification_deliveries');    -- expect non-NULL
SELECT to_regclass('public.ens_campaigns');                  -- expect non-NULL
SELECT to_regclass('public.ens_campaign_destinations');      -- expect non-NULL

-- Verify canonical column retained
SELECT column_name FROM information_schema.columns
WHERE table_name = 'media_files' AND column_name = 'duration_sec'; -- expect 1 row

-- Verify legacy column gone
SELECT column_name FROM information_schema.columns
WHERE table_name = 'media_files' AND column_name = 'duration_seconds'; -- expect 0 rows
```

---

## 7. Unexpected Findings

None. All changes matched audit document predictions. The one item flagged for additional care — the `duration_seconds` column — was verified as a physical column distinct from the SQL computed alias `EXTRACT(...)::INT AS duration_seconds` used in reports; the physical column is confirmed unused.

---

## 8. Remaining Architecture Work

The following items were explicitly NOT implemented in this batch and remain for future phases:

| Item | Phase | Work Required |
|---|---|---|
| ENS dashboard migration | E | Rewrite 3 dashboard queries from ens_notifications to ens_campaigns |
| EnsReport migration | E | Rewrite GET /reports/ens and GET /reports/ens/:uuid to read ens_campaigns |
| ensController.listNotifications migration | E | Rewrite GET /ens/notifications to read ens_campaigns |
| UI blast write path migration | F | Move ensController.createNotification to campaign engine |
| ReportNotifications removal | G | After ens_notifications fully migrated |
| ReportEnsBroadcasts removal | G | After ens_notifications fully migrated |
| /internal/ens/notifications/* API retirement | H | After verifying no Lua deployment calls legacy path |
| Legacy Lua notification path retirement | H | After FreeSWITCH audit confirms no active Lua targets /notifications |
| ens_notifications table removal | J | After all 5 active consumers migrated |
| ens_notification_deliveries table removal | J | After parent table retired |

---

## 9. Recommended Next Phase

**Phase E — ENS Notification Consumer Migration**

Prerequisite: Phases A–D verified in staging. Migration 041 applied cleanly.

Scope:
1. Rewrite the three `dashboardController.js` queries against `ens_notifications` to equivalent queries against `ens_campaigns` / `ens_campaign_destinations`
2. Rewrite `GET /reports/ens` and `GET /reports/ens/:uuid` (reports.js lines 431–517) to read `ens_campaigns` — preserve the response contract so `EnsReport.jsx` requires no frontend change
3. Rewrite `ensController.listNotifications` to read `ens_campaigns`

This phase requires careful business-logic equivalence verification: the field mapping between old and new tables (documented in the Phase 3 plan, Section 5) has six fields with no direct equivalent (`recording_reference`, `total_replayed`, `callback_count`, `deleted_at`, `REPLAYED` delivery status, `pin_verified_at`). These gaps must be resolved before Phase E begins.

Do NOT begin Phase E until this implementation result is reviewed and Phases A–D are validated in staging.
