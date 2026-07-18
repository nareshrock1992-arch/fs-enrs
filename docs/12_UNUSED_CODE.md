# 12 — Unused Code & Technical Debt

This document identifies dead code, legacy paths, and orphaned schema accumulated across the project's development phases. **Nothing in this document has been changed** — this is an audit only.

---

## Dead Exports

### `services/conferenceManager.js` — `getConferenceString()`
- **Location:** `backend/src/services/conferenceManager.js:76`
- **Issue:** Exported but never imported anywhere in the codebase. The function composes a FreeSWITCH dial string `<room>@<profile>`. The two functions it wraps — `resolveConferenceRoom()` and `getConferenceProfile()` — are actively used, but `getConferenceString()` has zero callers.
- **Action:** Safe to remove the export.

---

## Deprecated Routes

### `GET /api/v1/contacts/by-pin`
- **Location:** `backend/src/controllers/contactController.js:154`
- **Issue:** Endpoint is explicitly marked `DEPRECATED` with `Sunset: Mon, 31 Aug 2026` header. The comment explains it breaks when `ens_contacts` and `ers_responders` are separated (Phase 1 refactor). No auth guard on this route.
- **Action:** Remove after 2026-08-31.

### `POST /api/v1/media/upload`
- **Location:** `backend/src/routes/v1/media.js`
- **Issue:** Comment in the route file says "Use the deployment controller's upload endpoint instead — this route is kept for backwards compatibility (IVR builder file picker)." The route inserts into `media_files` without copying to the FreeSWITCH filesystem — files uploaded here cannot be deployed without an additional step. Creates confusion: two upload endpoints exist, one functional and one partial.
- **Action:** Redirect the IVR builder file picker to `/deployment/audio/upload` and remove this route.

---

## Legacy Controller Code

### Dual ERS Responder Resolution Path
- **Location:** `backend/src/controllers/internal/ersInternalController.js:53–115`
- **Issue:** `resolveErsNumbers()` queries the modern `ers_tier_contacts` / `ers_tier_groups` tables first. If empty, it falls back to two legacy SQL paths:
  1. Old `ers_responders` + `ers_responder_group_members` tables (Phase 6 schema)
  2. Old `emergency_contacts` JOIN via `primary_ers_group_id` / `primary_group_id` FK columns
  
  These columns were migrated away in `009_ers_tier_groups.sql`. The fallback exists to support ERS configurations created before migration 009. Any new deployment starts fresh so these paths should never execute — but they're still compiled.
- **Action:** Verify no pre-migration-009 configs exist in production, then remove the fallback branches.

### Legacy ENS Notification Handlers
- **Location:** `backend/src/controllers/ensController.js:269`
- **Issue:** `listNotifications()` and `createNotification()` are marked `// Notifications (legacy)`. They are still registered routes (`GET /api/v1/ens/notifications`, `POST /api/v1/ens/notifications`) and are reachable, but the reports controller (`GET /api/v1/reports/ens-broadcasts`) provides the same data with richer joins and pagination.
- **Action:** Evaluate whether any frontend page still calls these directly; remove if not.

### ERS queue_hold_audio legacy compat
- **Location:** `backend/src/controllers/ersController.js:31`
- **Issue:** `queue_hold_audio: emptyToNull // legacy compat` — kept in the ERS config schema for old configs that stored a value. The frontend no longer renders a `queue_hold_audio` field.
- **Action:** Can be removed once all old configs are confirmed to have `NULL` in that column.

---

## Orphaned Database Tables

These tables exist in migrations but have **zero references** in any JavaScript file:

### `audio_library`
- **Defined in:** `001_initial_schema.sql:611`
- **Issue:** An early media concept fully replaced by `media_files` + `mediaLibraryController.js`. No controller reads or writes to this table.
- **Action:** Drop in a future migration once confirmed empty in production.

### `notification_templates`
- **Defined in:** `001_initial_schema.sql:189`
- **Issue:** The ENS notification system uses `ens_notifications` instead. `notification_templates` has no JS callers.
- **Action:** Drop in a future migration.

### `ens_campaign_deliveries`
- **Defined in:** `001_initial_schema.sql:343`
- **Issue:** Superseded by `ens_notification_deliveries` (active in reports) and `ens_campaign_destinations` (active in campaign engine). `ens_campaign_deliveries` has no JS callers.
- **Action:** Drop in a future migration.

### `ens_contacts` / `ens_groups` / `ens_group_members`
- **Defined in:** `001_initial_schema.sql`
- **Issue:** Only reference is in the deprecated `GET /contacts/by-pin` comment. The active ENS system uses `ens_configuration_contacts` and `ens_configuration_groups`. 
- **Action:** Drop after the deprecated route is removed.

### `ers_responders` / `ers_responder_group_members`
- **Defined in:** `002_phase6_bugfixes.sql:284`
- **Issue:** Only referenced by the legacy fallback in `ersInternalController.js` (see above). Not used by any UI controller or the ring service.
- **Action:** Drop after removing the legacy fallback.

---

## TODO / FIXME / HACK Comments

| File | Line | Comment |
|---|---|---|
| `controllers/contactController.js` | 154 | `DEPRECATED` — `getByPin`, sunset Aug 2026 |
| `controllers/ensController.js` | 269 | `// Notifications (legacy)` |
| `controllers/ersController.js` | 31 | `// legacy compat` for `queue_hold_audio` |
| `controllers/internal/ersInternalController.js` | 53, 89 | Legacy fallback for old group FK columns |
| `routes/v1/media.js` | ~52 | "Use the deployment controller's upload endpoint instead" |
| `config/index.js` | 34 | "Was referenced here before but never defined" (removed gateway setting) |

---

## Recommended Cleanup Order

1. **Remove `getConferenceString` export** from `conferenceManager.js` — zero-risk, zero callers.
2. **Plan `audio_library`, `notification_templates`, `ens_campaign_deliveries` table drops** — confirm empty in production, add migration 028.
3. **Sunset `GET /contacts/by-pin`** after August 2026.
4. **Consolidate media upload** — point IVR builder to `/deployment/audio/upload`, remove `/media/upload`.
5. **Remove legacy ERS responder fallback** — requires verifying no pre-009 configs exist.
6. **Audit ENS notification routes** — check if any frontend page still calls them before removing.
