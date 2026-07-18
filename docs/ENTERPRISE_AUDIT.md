# Enterprise Architecture Audit — fs-enrs

**Date:** 2026-07-18  
**Auditor:** Lead Architect Review  
**Scope:** Complete repository — backend, frontend, ESL, database, security, Socket.IO, reporting, media library, monitoring, dashboard  
**Status:** Pre-fix audit. No code has been modified.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Security Issues](#2-critical-security-issues)
3. [Architecture Issues](#3-architecture-issues)
4. [ERS Lifecycle Bugs](#4-ers-lifecycle-bugs)
5. [Conference Naming — Static vs Dynamic](#5-conference-naming--static-vs-dynamic)
6. [Auto Recording](#6-auto-recording)
7. [Monitoring and Dashboard](#7-monitoring-and-dashboard)
8. [Reporting Module](#8-reporting-module)
9. [Media Library](#9-media-library)
10. [Socket.IO](#10-socketio)
11. [Database](#11-database)
12. [Frontend UI/UX](#12-frontend-uiux)
13. [API Surface](#13-api-surface)
14. [Dead Code and Technical Debt](#14-dead-code-and-technical-debt)
15. [Architecture Recommendations](#15-architecture-recommendations)
16. [Implementation Roadmap](#16-implementation-roadmap)

---

## 1. Executive Summary

The fs-enrs platform has a solid architectural foundation: event-driven ESL integration, multi-tenant structure, a well-designed IVR builder, and a correct core ERS conference flow. However, **the system is not production-ready** in its current state. Five categories of issues block customer deployment:

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 5 | 5 | 4 | — |
| Conference naming / ERS lifecycle | 4 | 3 | 2 | 2 |
| Recording | 3 | 1 | 2 | — |
| Multi-tenant data isolation | 2 | 2 | 3 | 1 |
| Reporting (broken pages) | 4 | — | 3 | 2 |
| Database integrity | 3 | 5 | 6 | 4 |
| Frontend | — | 4 | 8 | 6 |

**The most serious issues:**
- Socket.IO broadcasts all emergency events (caller numbers, conference rooms, responder names) to all tenants simultaneously — a hard multi-tenant data leakage.
- DYNAMIC conference mode is completely broken — rejoin fails, occupancy checks return wrong values, ring deduplication breaks.
- Auto recording does not write `ers_incidents.recording_path` — monitoring, reports, and playback all show no recording for auto-recorded incidents.
- Three report pages (Notifications, Incidents, Contact Usage) always show empty tables due to field name mismatches and response shape errors.
- SIP gateway and ESL passwords are stored in plaintext in the database.
- The unauthenticated `/contacts/by-pin` endpoint exposes all contact PII to anyone who can guess a short numeric PIN.

---

## 2. Critical Security Issues

### SEC-1 [CRITICAL] — `/contacts/by-pin` Endpoint is Unauthenticated

**File:** `backend/src/routes/v1/contacts.js:11`

`router.get('/by-pin', ctrl.getByPin)` is mounted **before** `router.use(requireAuth)`. Any HTTP client can call this endpoint without a token. It returns full contact records (names, mobile numbers, extension numbers, emails, roles) for any caller who supplies any ENS PIN. ENS PINs are typically 4–6 digit numeric codes — enumerable in under a minute. This is a P0 data exfiltration vulnerability.

**Fix:** Move the route after `router.use(requireAuth)` or add `requireAuth` explicitly. The endpoint is marked `Sunset: Mon, 31 Aug 2026` and should be removed entirely now.

---

### SEC-2 [CRITICAL] — Socket.IO emits all emergency events to all tenants

**File:** `backend/src/services/socketService.js:9`, `backend/src/services/eslService.js:589`

```js
// socketService.js
export function emitInternal(event, data) {
  if (_io) _io.emit(event, data);  // ALL connected sockets
}

// eslService.js
function emit(event, data) {
  if (io) io.emit(event, data);    // ALL connected sockets
}
```

Every ESL event — `conference.member.joined`, `conference.member.talking`, `conference.floor.changed`, `enrs::ers_incident_created`, `enrs::ens_delivery`, etc. — is broadcast globally to every authenticated session regardless of tenant. In a multi-tenant deployment:
- Tenant A's operator sees Tenant B's emergency conference room names, caller phone numbers, and responder join/leave events in real time.
- The `user:{id}` and `role:{role}` Socket.IO rooms created at authentication (socketService.js:37-38) are **never used** for any targeted emission.

Additionally, `socket.emit('esl.status', eslStatus())` fires on every new connection **before** `authenticate` is received (socketService.js:29), leaking the FreeSWITCH host and port to unauthenticated WebSocket connections.

**Fix:** Emit to tenant-scoped rooms. Each socket must join a `tenant:{tenantId}` room on authenticate. All `emitInternal` and ESL event emissions must resolve the tenant from the event payload and emit to `tenant:{tenantId}` only. For conference events, the room-to-tenant mapping must be maintained in a side table (conference room → tenant_id) populated on incident creation.

---

### SEC-3 [CRITICAL] — SIP Gateway and ESL Passwords Stored in Plaintext

**Files:** `backend/src/db/migrations/015_sip_gateways.sql` (column `password VARCHAR(255)`), `feature_flags` seed (`esl_connections.password DEFAULT 'ClueCon'`)

SIP gateway credentials and the FreeSWITCH event socket password are stored as plaintext in the PostgreSQL database. Anyone with database read access (DBA, backup restore, SQL injection) retrieves live SIP credentials.

**Fix:** Encrypt at-rest using AES-256-GCM with a key from the environment (`DB_ENCRYPTION_KEY`). Or use a secrets manager reference (Vault, AWS Secrets Manager) and store only the reference path. At minimum, mask the password field in all API responses.

---

### SEC-4 [CRITICAL] — ESL Command Injection via `audio_path` and `dial_string`

**Files:** `backend/src/controllers/monitoringController.js:303,321`, `backend/src/controllers/ersController.js:789`

`audio_path` and `dial_string` from request bodies are passed directly into FreeSWITCH ESL commands:
```js
confPlay(room, audio_path)     // → conference <room> play <audio_path>
confInvite(room, dial_string)  // → conference <room> bgdial <dial_string>
```

No allowlist validation or escaping is applied. A SUPERVISOR-role user (not just ADMIN) can supply:
- `audio_path` containing shell metacharacters or ESL subcommands
- `dial_string` routing to arbitrary external PSTN numbers at company expense

**Fix:** `audio_path` must be resolved against known media file IDs in the database — never accept raw filesystem paths from clients. `dial_string` must be validated against an allowlist pattern (E.164 number or `user/<extension>`) before reaching the ESL layer.

---

### SEC-5 [CRITICAL] — Weak Default Credentials Ship in Source

**File:** `backend/src/config/index.js:17,31`

```js
password: process.env.DB_PASSWORD || 'changeme'   // DB password
password: process.env.ESL_PASSWORD || 'ClueCon'   // ESL password (publicly known default)
```

The startup JWT-secret validation (`server.js:90-98`) only checks JWT secrets in production. No validation prevents deployment with default database or ESL passwords. The `ClueCon` password is the globally known FreeSWITCH default and is trivially guessed.

**Fix:** Add startup checks for `DB_PASSWORD`, `ESL_PASSWORD` in production. Fail fast with a clear error message. Remove the `|| 'changeme'` defaults entirely.

---

### SEC-6 [HIGH] — Caller ID Name ESL Injection

**File:** `backend/src/services/ersRingService.js:100`

```js
`origination_caller_id_name='${callerIdentity.name.replace(/'/g, '')}'`
```

Single-quote stripping is the only sanitization. A name like `` foo}originate_timeout=0,evil_var= `` breaks the channel variable block. ESL variable injection can alter call behavior.

**Fix:** Percent-encode or bracket-escape the entire name value using ESL's escaping rules. Do not use string interpolation for ESL channel variable values.

---

### SEC-7 [HIGH] — ENS/ERS PINs Stored and Compared in Plaintext

**Files:** `ens_configurations.pin`, `ers_configurations.pin`; comparison at `ensInternalController.js:127`

PINs are short numeric codes stored in plaintext and compared with `===`. Anyone with DB read access or who intercepts an API payload sees the raw PIN.

**Fix:** Hash PINs with bcrypt at rest. Compare using `bcrypt.compare()`. Use `timingSafeEqual` for the byte comparison after hashing.

---

### SEC-8 [HIGH] — Missing Tenant Isolation on ERS/ENS Data Endpoints

**File:** `backend/src/controllers/ersController.js:480` (`listIncidents`)

```sql
WHERE i.deleted_at IS NULL AND ($1::text IS NULL OR i.status = $1)
-- No tenant_id filter
```

An OPERATOR from Tenant A can read ERS incidents, ERS configurations, and monitoring data from Tenant B by simply iterating IDs. The same gap exists in `monitoringController.getConferences` (line 75). JWT payload contains `tenantId` but it is not applied to these queries.

**Fix:** Add `AND ec.tenant_id = $N` or `AND i.tenant_id = $N` to every query that reads ERS/ENS/incident data. Use `req.user.tenantId` — never trust the request body.

---

### SEC-9 [HIGH] — JWT Token Accepted in URL Query Parameter

**File:** `backend/src/middleware/auth.js:25` (`requireAuthOrToken`)

Access tokens appear in server logs, proxy logs, browser history, and `Referer` headers when passed as `?token=` query parameters. This applies to audio stream and download endpoints.

**Fix:** For media streaming, issue short-lived signed tokens (15-minute expiry, signed by a media-specific key) that are opaque to the access token. These tokens should encode only `mediaId` + `exp` and be validated by the stream endpoint without exposing the full session JWT.

---

### SEC-10 [MEDIUM] — `/uploads` Static Directory Served Without Authentication

**File:** `backend/server.js:65`

```js
app.use('/uploads', express.static('./uploads'))
```

All uploaded audio files (media library, ENS recordings) are accessible without authentication. Anyone who discovers or guesses a filename can download it.

**Fix:** Remove the static middleware. Route all file access through authenticated controller endpoints (`/api/v1/media-library/:id/stream` and `/api/v1/recordings/:id/stream`) which verify ownership before serving.

---

## 3. Architecture Issues

### ARCH-1 [HIGH] — No Repository / Data-Access Layer

Raw SQL is scattered across controllers, service files, route files, and `campaignEngine.js`. The same table (`ers_incidents`) is queried independently in at least 8 files. Schema changes require hunting every occurrence manually.

Affected files: `ersController.js`, `ersInternalController.js`, `eslService.js`, `campaignEngine.js`, `ersRingService.js`, `reports.js`, `monitoringController.js`, `recordingController.js`.

**Recommendation:** Introduce a repository layer at `backend/src/repositories/` with one file per entity: `IncidentRepository.js`, `CampaignRepository.js`, `RecordingRepository.js`, etc. All SQL lives in repositories; controllers and services call repository methods. This is the single most impactful architectural improvement.

---

### ARCH-2 [HIGH] — Circular Imports Resolved via Dynamic `import()` in Hot Event Paths

**File:** `backend/src/services/eslService.js:625,673,782,813,879`

```js
import('./conferenceManager.js').then(({ getConference }) => { ... })
import('../controllers/recordingController.js').then(({ upsertRecordingStart }) => { ... })
import('../controllers/internal/ersInternalController.js').then(({ trackParticipant }) => { ... })
```

Dynamic imports inside `handleEvent` — which fires on every FreeSWITCH event — add async microtask overhead and obscure the dependency graph. If any of these dynamic imports rejects (e.g., module load error), it creates an unhandled rejection on a hot code path.

**Fix:** Break the circular dependency at design level. ESL service should emit events on a local `EventEmitter`; `conferenceManager`, `ersInternalController`, and `recordingController` should subscribe. ESL service has no business directly calling recording controller methods.

---

### ARCH-3 [HIGH] — Business Logic in Route Files

**Files:** `backend/src/routes/v1/reports.js`, `backend/src/routes/v1/users.js`, `backend/src/routes/v1/settings.js`

All report queries, user CRUD handlers, and settings CRUD handlers are inline in the route files with no controller layer. This is inconsistent with the rest of the codebase and untestable in isolation.

---

### ARCH-4 [MEDIUM] — Two Separate ENS Data Systems Coexist Without Reconciliation

**Technical debt (TD-5):** `ensInternalController.js` inserts into `ens_notifications` + `ens_notification_deliveries`. `campaignEngine.js` uses `ens_campaigns` + `ens_campaign_destinations`. These are two separate systems with different schemas, different delivery state machines, and no cross-referencing. Code paths that expect `ens_campaigns` will fail silently on legacy databases where only `ens_notifications` exists.

---

### ARCH-5 [MEDIUM] — No Startup Config Validation

**File:** `backend/server.js`

Only JWT secrets are validated at startup. `DB_PASSWORD`, `ESL_PASSWORD`, `INTERNAL_API_KEY`, `CORS_ORIGIN`, and `FS_RECORDINGS_DIR` receive no validation. The app boots with insecure defaults silently.

---

### ARCH-6 [MEDIUM] — `campaignEngine` Singleton With No Test Reset Mechanism

**File:** `backend/src/services/campaignEngine.js:39`

Module-level `campaignState` Map and `engineTimer` are never reset between test runs. Tests that import `campaignEngine` share state, causing flaky tests and incorrect isolation.

---

## 4. ERS Lifecycle Bugs

### ERS-1 [CRITICAL] — TOCTOU Race: Two Simultaneous Callers Both Get Slot 1

**File:** `backend/src/controllers/internal/ersInternalController.js:205–221`

```js
const activeConferences = activeResult.rows[0]?.active_count ?? 0;
const slot              = activeConferences + 1;
const groupType         = activeConferences === 0 ? 'primary' : 'secondary';
```

This `COUNT(*)` has no row lock. Two concurrent `ersLookup` calls both see `active_conferences=0`, both receive `slot=1` and `primary_bridge_number`. Both callers join the same conference room name. FreeSWITCH merges them, creating a conference where two separate emergency callers are in the same room — a critical safety failure.

**Fix:** Wrap the slot assignment in a `SELECT ... FOR UPDATE SKIP LOCKED` on `ers_configurations` or use a PostgreSQL advisory lock on `config_id`. The slot must be atomic with the incident creation.

---

### ERS-2 [CRITICAL] — `resolveRoom` Returns Wrong Room for DYNAMIC Conferences

**File:** `backend/src/controllers/internal/ersInternalController.js:740–747`

`resolveRoom` — used by `completeIncidentCore`, `ersOverflowPoll`, `ersTierStatus`, `tierLiveStatus`, and `ersRejoinLookup` — computes the room from `primary_bridge_number` or a deterministic fallback. It has no awareness of `conference_type`. When `conference_type=DYNAMIC`, the actual FreeSWITCH room is a generated name stored in `ers_incidents.conference_room`, but `resolveRoom` returns the static bridge number.

**Consequence:** For DYNAMIC conferences:
- `tierLiveStatus` always reports `{ occupied: false }` → every redial creates a new incident
- `ersOverflowPoll` promotes queued callers into already-occupied tiers
- `ersRejoinLookup` always returns `{ authorized: false }` → rejoin is completely non-functional
- Conference recording, monitoring, and completion all operate on the wrong room

**Fix:** `resolveRoom` must query `ers_incidents.conference_room WHERE incident_uuid = ...` for DYNAMIC conferences, not recompute from bridge numbers. The stored value is the only source of truth.

---

### ERS-3 [CRITICAL] — Caller Redial Into STATIC Conference Joins Wrong Room

**File:** `backend/src/controllers/internal/ersInternalController.js` (lookup path)

When a caller redials while their STATIC conference is active, `ersLookup` counts `active_conferences=1`, assigns `slot=2`, and returns the secondary bridge number. The caller joins a new empty secondary conference instead of the active primary. The primary conference (with responders) continues without the emergency caller.

The `allow_rejoin` flag is returned but there is no server-side check in the standard Lua path (`ersLookup` → `ersCreateIncident`) to detect an existing active incident for this caller's number.

**Fix:** `ersLookup` must check for an existing ACTIVE incident where `caller_number` matches. If found, return `{ rejoin: true, conference_room: existing_room }` instead of slot-assigning a new conference.

---

### ERS-4 [CRITICAL] — Queue Position Race Condition

**Files:** `backend/src/controllers/internal/ersInternalController.js:1043`, `backend/src/controllers/ersController.js:543`

```sql
SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM ers_queues WHERE status = 'QUEUED'
```

Two concurrent enqueue operations both read the same MAX and produce duplicate position values. `withTransaction` wrapping does not prevent this without a `SELECT ... FOR UPDATE` on `ers_queues`.

**Fix:** Use `SELECT MAX(position) + 1 FROM ers_queues WHERE ers_configuration_id = $1 FOR UPDATE` or use a sequence per configuration.

---

### ERS-5 [HIGH] — `startRingAll` Not Deduplicated in DYNAMIC Mode

**File:** `backend/src/services/ersRingService.js:36`

```js
const activeRings = new Map(); // keyed by room name
if (activeRings.has(room)) return { started: false };
```

For DYNAMIC conferences, every `ersRingAll` call generates a new room name. `activeRings.has(room)` is always false. A caller who redials twice quickly spawns two concurrent ring-all loops, dialing all responders simultaneously from both loops. Responders receive back-to-back duplicate calls.

---

### ERS-6 [HIGH] — `syncTierGroups` / `syncTierContacts` Not Transactional

**File:** `backend/src/controllers/ersController.js:84–104`

Both helpers do `DELETE ... WHERE config_id = $1` then individual INSERTs. They are called via `Promise.all` without a shared `withTransaction`. If any INSERT fails, the tier is left empty. A config update could delete all responders from a tier and then fail to reinsert them — leaving the ERS configuration with no responders at runtime.

---

### ERS-7 [HIGH] — Observer Role Not Representable in `ers_incident_participants`

**File:** migration 016

```sql
role VARCHAR(16) NOT NULL DEFAULT 'responder'
  CHECK (role IN ('initiator', 'responder'))
```

`ers_incident_responders.status` allows `'OBSERVER'` but `ers_incident_participants` has no `'observer'` role. Observers are inserted as `'responder'`. The caller who triggered the emergency is also inserted as `'responder'` during the ring-all rejoin path (`ersInternalController.js:845`). Reports cannot distinguish initiators, responders, and observers.

---

### ERS-8 [MEDIUM] — `MODERATOR_JOIN` Recording Trigger Silently Ignored

**Files:** `backend/src/services/conferenceManager.js`, `backend/src/controllers/ersController.js:41`

`recording_trigger='MODERATOR_JOIN'` is accepted by the Zod schema, DB CHECK, and API. No code in `conferenceManager.js` or `eslService.js` implements this trigger. A configuration with this value will never auto-record. No error or warning is logged.

---

### ERS-9 [MEDIUM] — `ers_incident_ended` Event Missing `status` Field

**File:** `backend/src/controllers/internal/ersInternalController.js:414`

```js
emitInternal('enrs::ers_incident_ended', {
  incident_uuid: incidentUuid,
  ended_at: new Date().toISOString(),
  // status field missing
});
```

Frontend cannot distinguish normal completion (`COMPLETED`) from cancellation (`CANCELLED`) on this event. `cancelQueuedIncident` in `ersController.js:712` correctly includes `status: 'CANCELLED'` — the internal complete path should match.

---

### ERS-10 [MEDIUM] — `deleteConfiguration` Has No Active Incident Check or Tenant Guard

**File:** `backend/src/controllers/ersController.js:347`

An admin can soft-delete an ERS configuration while an active incident is in progress. The ring loop continues referencing the deleted config — `resolveTierResponders` returns empty arrays for deleted configs, leaving the active emergency conference with no responders to ring if a retry is needed. No tenant check is present.

---

## 5. Conference Naming — Static vs Dynamic

### CONF-1 [CRITICAL] — Three Competing Room Resolution Functions

| Function | Location | Awareness of DYNAMIC? |
|---|---|---|
| `resolveConferenceRoom` | `conferenceManager.js:96` | Yes (handles both modes) |
| `resolveRoom` (async, DB) | `ersInternalController.js:740` | **No** — always returns static/deterministic room |
| `roomFromBridgeNumber` | `ersInternalController.js:733` | **No** |

`resolveRoom` is called in all high-frequency paths (completion, overflow, rejoin, tier status, monitoring) and is wrong for DYNAMIC mode.

**Required architecture:** One function. `getConferenceRoom(incidentUuidOrConfigId, tier)` that:
1. If the incident exists: return `ers_incidents.conference_room` (the stored room name — correct for both modes)
2. If no incident yet: use `conferenceManager.resolveConferenceRoom(cfg, slot)` to compute the room

---

### CONF-2 [HIGH] — STATIC Mode: No Duplicate Incident Guard at the DB Layer

A `UNIQUE` constraint on `(ers_configuration_id, group_type, status='ACTIVE')` would prevent two simultaneous ACTIVE primary incidents for the same config. Currently a partial unique index does not exist, and the race (ERS-1) allows duplicate incidents.

---

### CONF-3 [HIGH] — DYNAMIC Mode: `tier_live_status` Always Reports Free

**Root cause:** See ERS-2. `tierLiveStatus` calls `resolveRoom` → gets wrong room → `getConferenceMemberCount` returns 0 → tier always reports unoccupied. This causes cascading secondary failures: queue overflow promotion creates a second ring loop into an already-occupied conference.

---

### CONF-4 [MEDIUM] — DYNAMIC Room Name Generated at Lookup Time With 1-Second Collision Window

**File:** `ersInternalController.js:229`

DYNAMIC room names use `epoch_seconds.toString(16).slice(-7)`. Two lookups within the same second for the same config and tier produce identical room names.

**Fix:** Use `crypto.randomUUID().slice(0, 8)` for the suffix instead of epoch seconds.

---

## 6. Auto Recording

### REC-1 [CRITICAL] — Auto Recording Does Not Write `ers_incidents.recording_path`

**File:** `backend/src/services/conferenceManager.js:171–207`

`startAutoRecording` calls `confRecord(confName, recPath)` then waits for the ESL `start-recording` event. The ESL handler calls `upsertRecordingStart(...)` which writes to the `recordings` table — **not** to `ers_incidents.recording_path`.

Three systems depend on `ers_incidents.recording_path`:
- `monitoringController.getConferences` (line 63): returns `recording_path` in the conference object — shows `null` in monitoring UI
- Reports query `recording_path` for playback links in incident detail reports — shows no recording
- `ersPlaybackAuthorize` (line 1000): queries `WHERE recording_path IS NOT NULL` — playback authorization fails

**Fix:** After `upsertRecordingStart`, also run:
```sql
UPDATE ers_incidents SET recording_path = $1 WHERE conference_room = $2 AND status = 'ACTIVE'
```

---

### REC-2 [CRITICAL] — Dual Recording When Both `record_conferences` and `recording_enabled=AUTO` Are Set

**Files:** `backend/src/services/ersRingService.js:150–164`, `backend/src/services/conferenceManager.js`

`ersRingService` has its own independent recording trigger: when `cfg.record_conferences=true` and the first responder joins, it issues `conference <room> record <path1>`. `conferenceManager.js` auto-recording path issues the same command to a different path. FreeSWITCH receives two `conference record` commands and writes two concurrent recordings.

**Fix:** `record_conferences` (Lua-driven, old system) and `recording_enabled`/`recording_mode` (backend-driven, new system) must be mutually exclusive. Add a migration to CHECK that both cannot be true simultaneously, or unify into a single recording control path.

---

### REC-3 [CRITICAL] — Recording State Lost After ESL Reconnect

**File:** `backend/src/services/eslService.js` (`seedConferenceRegistry`)

`seedConferenceRegistry` uses `confXmlListAll`. FreeSWITCH's XML list does not include recording state. After a backend restart mid-recording, `recordingState` is seeded as `'OFF'` for all conferences. The UI shows "not recording" even while FreeSWITCH actively writes to disk. No reconciliation mechanism exists.

**Fix:** After seeding members from XML, query `recordings WHERE status='RECORDING' AND conference_room=confName` and restore `recording=true, recordingState='ACTIVE'` in the in-memory registry.

---

### REC-4 [HIGH] — `CONFERENCE_CREATED` Auto-Record Trigger Races the Incident Insert

**File:** `backend/src/services/conferenceManager.js:127–145`

`maybeAutoRecord` queries `ers_incidents WHERE conference_room=$1 AND status='ACTIVE'`. For STATIC conferences, the `conference-create` ESL event fires the instant the caller enters FreeSWITCH — before Lua has called `ersCreateIncident`. The incident does not exist yet; `maybeAutoRecord` returns early and recording is skipped with no retry.

**Fix:** Either:
- Use `FIRST_PARTICIPANT` trigger instead (fires after incident creation in the normal flow), or
- Retry `maybeAutoRecord` with a 1-second delay if no incident is found on `CONFERENCE_CREATED`

---

### REC-5 [MEDIUM] — `recordingStartTimers` Leaks on Conference Destroy Before Timeout

**File:** `backend/src/services/eslService.js:157`

`recordingStartTimers` Map entry is never removed when a conference is destroyed before the 5-second timer fires. `recordingStartTimers.has(confName)` returns `true` for 5 seconds after conference destroy, which blocks any new recording start for the same room name within that window (STATIC conferences with fixed room names are affected).

---

## 7. Monitoring and Dashboard

### MON-1 [HIGH] — Dashboard `active_conferences` Count Is Not Tenant-Scoped

**File:** `backend/src/controllers/dashboardController.js:47`

```js
Promise.resolve({ rows: [{ n: getConferenceSnapshot().length }] })
```

`getConferenceSnapshot()` returns all conferences from the global registry regardless of tenant. On a multi-tenant system, every tenant's dashboard shows the combined conference count across all tenants.

---

### MON-2 [HIGH] — `metrics.active_conferences` Reducer Mutation Is Dead Code

**File:** `frontend/src/pages/Dashboard.jsx:107`

The reducer updates `state.metrics.active_conferences` on ERS events. The dashboard UI reads `Object.keys(activeIncidents).length` for the "Active Incidents" card — never `metrics.active_conferences`. The reducer mutations are dead code and diverge silently.

---

### MON-3 [HIGH] — Dashboard Does Not Distinguish PRIMARY vs SECONDARY Conferences

**File:** `backend/src/controllers/dashboardController.js:74`

When an ERS incident escalates from primary to secondary, two active incidents exist for one emergency call. The dashboard shows count=2 with no visual distinction. The `group_type` field is in the API response but not labeled or separated in the UI.

---

### MON-4 [MEDIUM] — `joinedAt` Is Always Null for Members Present at Backend Restart

**File:** `backend/src/services/eslService.js:1433`

Members seeded from XML at startup have `joinedAt: null` because FreeSWITCH's XML list does not include join timestamps. The monitoring UI shows `—` for join time permanently for these participants.

**Fix:** When seeding, cross-reference `ers_incident_participants.joined_at` by matching `raw_number` to the seeded member's caller number.

---

### MON-5 [MEDIUM] — Talk Time Not Accumulated

No `talkStartedAt` is stored when `start-talking` fires. No duration is computed when `stop-talking` fires. The in-memory `MemberRecord` has no `talkSecs`. "Talk time" per participant cannot be computed without code changes.

---

### MON-6 [MEDIUM] — Volume OUT Control Missing From UI

**File:** `frontend/src/pages/Monitoring.jsx:474`

All volume controls call `api.monitoring.volume(room, id, 'in', level)` — the `'out'` direction is never used. The `api.monitoring.volume` client method accepts a `direction` argument; `confVolumeOut` exists in the backend. The UI provides no way to adjust output volume. Operators cannot lower the volume of a loud background noise on a responder's line.

---

### MON-7 [MEDIUM] — Energy Level and `confPlay` Missing From UI

`api.monitoring.energy` and `api.monitoring.playAudio` are defined in the API client but have no UI control in `Monitoring.jsx`. The monitoring page can play TTS (`confSay`) but cannot play an audio file from the media library.

---

### MON-8 [LOW] — `canHear` / `canSpeak` Not Shown in Participant Table

**File:** `frontend/src/pages/Monitoring.jsx`

`getConferenceSnapshot()` includes `canHear` and `canSpeak` per participant. These differ semantically from `deaf` and `muted` in FreeSWITCH. Not surfaced to the operator.

---

## 8. Reporting Module

### RPT-1 [CRITICAL] — `ReportNotifications` Always Shows Empty Table

**File:** `frontend/src/pages/reports/ReportNotifications.jsx`

Backend returns `res.json(rows)` — a plain array. Frontend destructures `data.notifications || []`. `data.notifications` is `undefined` on a plain array; `|| []` produces an empty table for every response regardless of data.

---

### RPT-2 [CRITICAL] — `ReportIncidents` Always Shows Empty Table

Same shape mismatch: backend returns `res.json(rows)`, frontend reads `.incidents || []`.

---

### RPT-3 [CRITICAL] — `ReportContactUsage` All Columns Blank

**File:** `frontend/src/pages/reports/ReportContactUsage.jsx`

| Frontend field | Backend column | Match? |
|---|---|---|
| `r.phone` | `c.mobile_number` | ❌ |
| `r.group_count` | (not returned) | ❌ |
| `r.ens_count` | `ens_direct_configs` | ❌ |
| `r.notification_count` | `ers_incidents` | ❌ |

All four display columns are blank. CSV export is equally broken.

---

### RPT-4 [CRITICAL] — `ReportIncidents` Status Filter Uses Wrong Enum

**File:** `frontend/src/pages/reports/ReportIncidents.jsx`

Dropdown value `IN_PROGRESS` does not exist in `ers_incidents.status CHECK ('ACTIVE','COMPLETED','QUEUED','FAILED','CANCELLED')`. Filtering by `IN_PROGRESS` always returns zero rows. Correct value: `ACTIVE`.

---

### RPT-5 [HIGH] — `ReportNotifications` Status Filter Partially Broken

`SENT` and `CANCELLED` are not valid `ens_notifications.status` values. Filtering on these returns zero rows.

---

### RPT-6 [HIGH] — `contact-usage` Query Has No LIMIT

`GET /reports/contact-usage` returns the entire contact table. On a tenant with thousands of contacts, this causes slow responses and client-side memory pressure.

---

### RPT-7 [HIGH] — `ReportNotifications` `title` Field Does Not Exist

`ens_notifications` has no `title` column. Frontend falls back to `r.title || r.id` — always shows the UUID.

---

### RPT-8 [HIGH] — No Server-Side Pagination on Any Report

All five report endpoints use hard `LIMIT 200`/`LIMIT 500` with no `page`/`offset` parameters and no `total` count returned. On a production system with years of data, reports are silently truncated.

---

### RPT-9 [MEDIUM] — No Export on ERS Incident Detail or ENS Broadcast Reports

`ReportErsIncidents` and `ReportEnsBroadcasts` — the most data-rich reports — have no export at all. The two simpler reports (notifications, incidents) have basic client-side CSV covering only visible columns.

---

### RPT-10 [MEDIUM] — `recording_path` Shown as Raw Filesystem Path

`ReportErsIncidents.jsx` displays `recording_path` as a raw string. No playback button, no download link. The recording endpoint exists and the recordings table has the needed metadata.

---

## 9. Media Library

### MEDIA-1 [RESOLVED] — Stream Endpoint Auth Fixed

The `router.use(requireAuth)` global middleware blocking `?token=` auth has been removed. `streamMedia()` MIME default changed to `audio/wav`. Stream auth now works correctly.

---

### MEDIA-2 [HIGH] — SUPERVISOR Role Can See Upload Button But Gets 403

**File:** `frontend/src/pages/media/MediaLibrary.jsx`, `backend/src/routes/v1/mediaLibrary.js`

The UI shows the Upload button for `role === 'ADMIN' || role === 'SUPERVISOR'`. The backend upload route uses `adminOnly` middleware. SUPERVISOR users see the button and get a 403 on click. Either the backend should accept `adminOrSuper` or the frontend should gate on `adminOnly`.

---

### MEDIA-3 [MEDIUM] — Waveform Cache Never Hits

**File:** `backend/src/controllers/mediaLibraryController.js`

`record.waveform_peaks` is a JSONB column. If the `pg` client is not configured with `json` type parsers, the column is returned as a string. `Array.isArray(record.waveform_peaks)` returns `false` and waveform peaks are recomputed from disk on every request, defeating the cache.

**Fix:** Register a pg type parser for JSONB, or use `JSON.parse(record.waveform_peaks)` before the `Array.isArray` check.

---

### MEDIA-4 [MEDIUM] — `.alaw` / `.ulaw` Accepted in UI But Rejected by Backend

Frontend `<input accept>` includes `.alaw` and `.ulaw`. Backend `AUDIO_EXTS` array does not include these extensions. Uploads fail with "Unsupported file type" after the user selects the file.

---

### MEDIA-5 [MEDIUM] — `mime_type` Not Persisted in Database

`media_files` has no `mime_type` column. Content-Type is derived at runtime from file extension mapping. A file renamed with a wrong extension is served with the wrong MIME type. A file with an extension not in `MIME_MAP` receives `audio/wav` as the default regardless of actual content.

---

## 10. Socket.IO

### SOCK-1 [CRITICAL] — No Tenant Isolation (See SEC-2)

All events broadcast to all connected clients. Covered under Security.

---

### SOCK-2 [HIGH] — Conference Registry Not Cleared on ESL Disconnect

**File:** `backend/src/services/eslService.js`

When ESL disconnects, `isConn = false` but the `conferenceRegistry` Map is not cleared. Monitoring clients continue to see stale conferences and participants. During any outage, the monitoring page shows conferences that may have ended, with participants who have left.

**Fix:** On ESL disconnect, emit `conference.registry.stale` to all sockets and clear the in-memory registry. On reconnect, the 800ms seed restores correct state.

---

### SOCK-3 [HIGH] — Concurrent ESL Reconnects Create Double Event Processing Window

**File:** `backend/src/services/eslService.js:994`

On rapid reconnect cycles, the old `conn` object may still emit `esl::event` briefly while the new one is also connected. `handleEvent` fires twice per event. For `add-member` events this causes duplicate `conference.member.joined` socket emissions and duplicate participant DB inserts (guarded, but the join event itself is not idempotent from the client's perspective).

---

### SOCK-4 [HIGH] — Concurrent `seedConferenceRegistry` Calls Not Mutex-Protected

On rapid ESL reconnect cycles, multiple seed calls run concurrently. Each seed emits `conference.created` + `conference.member.joined` for all active rooms. Monitoring clients receive duplicate creation events for conferences already in their state.

---

### SOCK-5 [MEDIUM] — `energy-level` Updates Never Reach Clients

**File:** `backend/src/services/eslService.js:787`

The `energy-level` ESL action updates the in-memory registry but intentionally emits no socket event. Energy values are only current after the 30-second seed cycle. Operators clicking the energy adjust button see no live feedback.

---

## 11. Database

### DB-1 [CRITICAL] — ens_campaigns Primary Key Type Split

**Migration 001 vs 008:** `001_initial_schema.sql` creates `ens_campaigns` with `id BIGSERIAL`. Migration `008_campaign_engine.sql` tries `CREATE TABLE IF NOT EXISTS ens_campaigns` with `id UUID`. On databases that ran 001 first, migration 008's create is silently skipped. Migration 008 then creates `ens_campaign_destinations` with `campaign_id UUID REFERENCES ens_campaigns(id)` — FK type mismatch (UUID vs integer). Migration 008 fails on all legacy installs. Legacy databases have `ens_campaign_deliveries` but not `ens_campaign_destinations`. All controllers use `ens_campaign_destinations` — these controllers fail at runtime on legacy installs.

**Fix:** A migration to detect the old BIGINT `ens_campaigns` schema and either convert to UUID or create `ens_campaign_destinations` with BIGINT FK.

---

### DB-2 [CRITICAL] — `ers_queues.incident_id NOT NULL ... ON DELETE SET NULL` Contradiction

**Migration 001:** `incident_id INT NOT NULL REFERENCES ers_incidents ON DELETE SET NULL`. NOT NULL combined with SET NULL is a contradiction — the FK trigger sets the field to NULL, violating NOT NULL. If any `ers_incidents` row is deleted (not soft-deleted), PostgreSQL will raise an error trying to set NULL on a NOT NULL column.

---

### DB-3 [CRITICAL] — `recordings.campaign_id` Has No FK Constraint

**File:** migration 026

```sql
campaign_id UUID  -- comment: "ENS: ens_notifications.notification_uuid"
```

No `REFERENCES` clause. ENS campaign-to-recording linking is entirely application-enforced. Orphaned recording rows with non-existent campaign IDs accumulate silently.

---

### DB-4 [HIGH] — Missing Composite Index on `ers_incidents(conference_room, status)`

`conference_room` is queried on every FreeSWITCH ESL event (member join, leave, recording start). At scale this is a sequential table scan per event. No index on `conference_room` exists in any migration.

**Required index:**
```sql
CREATE INDEX CONCURRENTLY idx_ers_incidents_conf_room
  ON ers_incidents (conference_room, status)
  WHERE deleted_at IS NULL;
```

---

### DB-5 [HIGH] — Missing Composite Index on `ers_incidents(tenant_id, status, deleted_at)`

The most common query pattern (dashboard, monitoring, reports) filters on all three. A composite partial index is required for multi-tenant scale:

```sql
CREATE INDEX CONCURRENTLY idx_ers_incidents_tenant_status
  ON ers_incidents (tenant_id, status, started_at DESC)
  WHERE deleted_at IS NULL;
```

---

### DB-6 [HIGH] — `schema.sql` Has 8 Known Divergences From Migration Chain

`schema.sql` is not the live source of truth. Fresh installs and legacy-upgrade installs produce structurally different databases:
1. `tenants.slug` — in 001, absent from schema.sql
2. `users` account-lockout columns — absent from schema.sql base
3. `organizations` contact fields — absent from schema.sql base
4. `ens_notifications.status` CHECK — missing `'CANCELLED'`
5. `ens_notification_deliveries.delivery_status` CHECK — missing `'DIALLING'`
6. `ens_notifications.triggered_by_user_id` — absent from schema.sql
7. `media_files` type CHECK — missing `'IVR_PROMPT'`
8. `locations.address` — absent from schema.sql

**Fix:** Regenerate `schema.sql` from a fresh migration run. Add a CI check that compares `schema.sql` against the migration output.

---

### DB-7 [HIGH] — `users.tenant_id` Is Nullable With No NOT NULL Enforcement

Any user row with `tenant_id IS NULL` is invisible to all tenant-scoped queries. No migration enforces NOT NULL after the backfill in migration 011.

---

### DB-8 [HIGH] — No Archival Strategy for High-Growth Tables

Tables that grow without bound and have no cleanup job:
- `audit_logs` — one row per audited API call
- `ens_notification_deliveries` / `ens_campaign_destinations` — one row per contact per blast
- `recordings` — no size cap, no automated archival
- `ers_incident_participants` — unbounded for long-running conferences

**Recommendation:** PostgreSQL table partitioning by `created_at` for `audit_logs` and `ens_campaign_destinations`. Add an archival job that moves rows older than `AUDIT_RETENTION_DAYS` to cold storage.

---

### DB-9 [MEDIUM] — `er_incident_participants.rejoined_at` Single Field Cannot Represent Multiple Rejoins

Reports claim full rejoin history. The schema supports only one rejoined_at timestamp per participant per incident. The third rejoin overwrites the second.

**Required:**
```sql
CREATE TABLE ers_participant_sessions (
  id              BIGSERIAL PRIMARY KEY,
  participant_id  INT NOT NULL REFERENCES ers_incident_participants(id),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  session_number  INT NOT NULL DEFAULT 1
);
```

---

### DB-10 [MEDIUM] — Connection Pool Has No `statement_timeout`

**File:** `backend/src/db/pool.js`

No `statement_timeout` is set. A long-running unindexed query (e.g., an audit_logs scan) holds a pool connection indefinitely, exhausting the 20-connection pool and blocking all subsequent requests.

**Fix:** Add `statement_timeout: 30000` to the pool config. Add query-level timeout override for known long-running jobs.

---

### DB-11 [LOW] — Orphaned / Unused Tables

| Table | Status |
|---|---|
| `ens_contacts` | Deprecated, no controller reads it |
| `ens_groups` | Deprecated |
| `ens_group_members` | Deprecated |
| `audio_library` | Orphaned — superseded by `media_files` |
| `notification_templates` | No CRUD controller implemented |
| `ens_campaign_deliveries` | Legacy — superseded by `ens_campaign_destinations` |

---

## 12. Frontend UI/UX

### UI-1 [HIGH] — `allow_rejoin` Field Not Rendered in ERS Config Form

**File:** `frontend/src/pages/ers/ErsConfigList.jsx`

`allow_rejoin` is in the `EMPTY` state constant (default: `true`) and in the edit form's data mapping, but there is no `<input type="checkbox">` rendered for it. Operators can never change this setting via the UI.

---

### UI-2 [HIGH] — No Conference Controls on ErsLive Page

**File:** `frontend/src/pages/ers/ErsLive.jsx`

`api.ers.confKick`, `api.ers.confMute`, and `api.ers.confPlay` exist in the client but are not used. ErsLive shows responder status chips but provides no way to mute, kick, or play audio to conference participants. The full conference control panel only exists in the standalone Monitoring page.

---

### UI-3 [HIGH] — No Manual ENS Blast Trigger in UI

**File:** `frontend/src/pages/ens/`

There is no "Trigger Blast" button on the ENS list page. `api.ens.trigger()` exists in the client and the backend has `POST /ens/notifications`. A dispatcher cannot fire a notification from the web UI without calling a phone number.

---

### UI-4 [HIGH] — No Cancel Incident Button in ErsLive

`api.ers.cancelIncident(uuid)` exists in the client but is not called anywhere in the frontend. ErsLive has a "Complete" button only.

---

### UI-5 [MEDIUM] — Error Handling: `catch {}` Silent in Critical Pages

| Page | Error handling |
|---|---|
| ReportNotifications | `catch {}` — silent |
| ReportIncidents | `catch {}` — silent |
| ReportContactUsage | No error state at all |
| ErsLive | `catch {}` — silent |
| ErsConfigList | `catch {}` — silent |
| EnsList | `catch {}` — silent |
| IvrList | `console.error(e)` — not shown in UI |

Operators have no feedback when API calls fail. On a network error, pages appear to load successfully (empty tables, no spinner).

---

### UI-6 [MEDIUM] — `window.confirm` / `window.alert` / `window.prompt` Used Throughout

Blocking native dialogs are used for: delete confirmations (EnsList, ErsConfigList, IvrList, MediaLibrary), flow naming (`window.prompt` in IvrList), and error alerts. These are inconsistent with the design system's modal/banner pattern used in CampaignDashboard and MediaLibrary.

---

### UI-7 [MEDIUM] — Missing `limit: 1000` on List Calls That Populate Dropdowns

| API call | Page | Missing limit? |
|---|---|---|
| `api.ens.list()` | EnsList | Yes |
| `api.ers.list()` | ErsConfigList | Yes |
| `api.ivr.list()` | IvrList | Yes |
| `api.users.list()` | UserManagement | Yes |

Default limit is 20 rows on most list endpoints. A tenant with 30 ENS configurations sees a truncated dropdown without any indication of missing items.

---

### UI-8 [MEDIUM] — No Code Splitting / Lazy Loading

No `React.lazy()` or dynamic `import()` observed. All pages — including the IVR builder (which pulls in canvas-rendering dependencies) — are bundled synchronously. First contentful paint for simple pages is penalized by the full bundle.

---

### UI-9 [MEDIUM] — ENS Broadcast "Completed Today" Stat Is Wrong

**File:** `frontend/src/pages/ens/CampaignDashboard.jsx`

"Completed Today" counts campaigns in the current paginated result set with `status === 'completed'`. It does not filter by date. With the filter set to "All Time", this shows total completed campaigns across all time labeled as "Today".

---

### UI-10 [LOW] — `MediaLibrary.jsx` Is 1,067 Lines With Five Components

`WaveformCanvas`, `AudioPlayer`, `UploadModal`, `FileDetail`, `MediaLibraryBoundary`, `MediaLibraryInner` are all in a single file. Should each be extracted to `frontend/src/components/media/`.

---

### UI-11 [LOW] — No Error Boundary Except on MediaLibrary

A runtime render error on any other page (ErsLive, IvrBuilder, etc.) propagates to the root and crashes the entire app.

---

## 13. API Surface

### API-1 [HIGH] — `listIncidents` Response Is a Bare Array; Other Endpoints Return Objects

`GET /ers/incidents` returns `[]`. `GET /ers/configurations` returns `{ configurations: [], total, page, limit }`. Inconsistent envelope structure makes client-side error detection unreliable (empty array vs error cannot be distinguished without checking HTTP status).

---

### API-2 [HIGH] — Mixing UUID and Integer ID Params Across Related Endpoints

`GET /ers/incidents/:uuid/detail` expects UUID.  
`GET /ers/incidents/:id/responders` expects integer ID.  
`POST /ers/incidents/:uuid/complete` expects UUID.  

Clients cannot determine the expected ID type without reading source.

---

### API-3 [MEDIUM] — `deleteConfiguration` Returns 204 for Non-Existent IDs

```js
await query(`UPDATE ers_configurations SET deleted_at = now() WHERE id = $1`, [id]);
res.sendStatus(204);
```

No `RETURNING *` check. If the ID doesn't exist, 204 is returned. Idiomatic REST requires 404 for unknown resources.

---

### API-4 [MEDIUM] — `updateTierGroups` Has No Zod Validation

**File:** `backend/src/controllers/ersController.js:457`

`req.body` is destructured with no schema. Non-array values produce `.map(Number)` → `[NaN]` → bad DB row silently.

---

### API-5 [MEDIUM] — `SELECT *` in Production Query Paths

Used in: `recordingController.js:185`, `deploymentController.js:252`, `mediaLibraryController.js:598`, `organizationController.js:47`. Silent payload expansion when new columns are added, including sensitive fields.

---

### API-6 [LOW] — Stale API Client Methods

`api.mediaLibrary.waveformUrl(id)` — constructs a token URL never used by the frontend (player calls `api.mediaLibrary.waveform(id)` instead). Dead code in `client.js`.

The legacy `api.deployment.listAudio`, `scanAudio`, `uploadAudio`, `deployAudio`, `deleteAudio` methods remain in the client. If the IVR builder no longer uses them, they are stale.

---

## 14. Dead Code and Technical Debt

### DC-1 — `requireInternalKey` in `rbac.js` — Dead Export, Insecure Implementation

**File:** `backend/src/middleware/rbac.js:27`

Exported but never imported. Implements an insecure timing-unsafe version of the internal key check. The correct implementation is in `internalAuth.js`. This dead export should be removed before someone accidentally wires it up.

---

### DC-2 — Deprecated `/contacts/by-pin` Endpoint (Also a Security Issue)

**File:** `backend/src/routes/v1/contacts.js:11`

Marked `Sunset: Mon, 31 Aug 2026`. Has no authentication (SEC-1). Should be removed now.

---

### DC-3 — `resolveEnsContacts` Duplicated Between `ensInternalController` and `campaignEngine`

Both contain near-identical SQL for contact resolution. The `campaignEngine` version has diverged (missing the mobile+extension dual-channel logic added to `ensInternalController`). ENS calls made through the campaign engine miss the dual-channel dial logic.

---

### DC-4 — Phone Normalization Logic Repeated in 8+ Files

`String(x).replace(/\D/g, '').slice(-9)` is duplicated in `eslService.js`, `ersInternalController.js`, `ersController.js`, `ersRingService.js`, and others. No shared utility function.

---

### DC-5 — `deterministicRoom` Exported But Never Imported

**File:** `backend/src/controllers/internal/ersInternalController.js:752`

Dead export.

---

### DC-6 — Legacy ERS Responder Path Active With Silent Error Swallowing

**File:** `backend/src/controllers/internal/ersInternalController.js:89`

```js
}).catch(() => ({ rows: [] }))
```

References `ers_responders` and `ers_responder_group_members` (legacy tables). If these tables don't exist, the catch returns empty arrays — silently causing Lua to ring nobody with no log entry.

---

### DC-7 — `ens_notifications` vs `ens_campaigns` — Two ENS Systems

`ensInternalController.js` inserts into `ens_notifications`. `campaignEngine.js` uses `ens_campaigns`. No reconciliation. `ensQueueStatus` queries `ens_notifications` which may be empty if all activity is in `ens_campaigns`. The endpoint is broken on fresh installs (where the campaign system is active) — it always returns `can_proceed: true`.

---

### DC-8 — Hardcoded `interval '48 hours'` in Reconciliation Sweep

**File:** `backend/src/services/eslService.js:1669`

Not configurable. An orphaned incident more than 48 hours old (e.g., from a weekend outage discovered Monday) is never reconciled.

---

## 15. Architecture Recommendations

### R-1: Repository Layer

Create `backend/src/repositories/` with files per entity. All SQL moved to repositories. Controllers call repository methods. This enables:
- Single location for schema changes
- Testability via mock repositories
- Consistent tenant scoping applied in one place

### R-2: Event Bus for ESL → Service Communication

Replace circular dynamic imports with an internal `EventEmitter` bus:
```
ESL event → eslService emits on bus → conferenceManager, ersInternalController, recordingController subscribe
```

ESL service becomes a pure event source with no knowledge of domain logic.

### R-3: Tenant-Scoped Socket.IO Rooms

```js
// On authenticate:
socket.join(`tenant:${user.tenantId}`);

// All emissions:
io.to(`tenant:${tenantId}`).emit(event, data);
```

Conference events must carry `tenantId`. The `conferenceRegistry` must store `tenantId` per conference (populated from the incident's `tenant_id` at creation time).

### R-4: Unified Conference Room Resolution

```js
// Single function, single source of truth
async function getIncidentConferenceRoom(incidentUuid) {
  const { rows: [row] } = await query(
    `SELECT conference_room FROM ers_incidents WHERE incident_uuid = $1 AND deleted_at IS NULL`,
    [incidentUuid]
  );
  return row?.conference_room ?? null;
}
```

All six callers of `resolveRoom` should call this instead.

### R-5: Unified Recording Control

Remove `record_conferences` boolean from the ERS ring flow. The single recording control path is:
1. `ers_configurations.recording_enabled` + `recording_mode` + `recording_trigger`
2. Managed entirely by `conferenceManager.js`
3. `upsertRecordingStart` always updates both `recordings` table AND `ers_incidents.recording_path`

### R-6: Config Validation at Startup

```js
// server.js startup
const required = ['DB_PASSWORD', 'ESL_PASSWORD', 'INTERNAL_API_KEY', 'JWT_SECRET'];
const insecureDefaults = { DB_PASSWORD: 'changeme', ESL_PASSWORD: 'ClueCon' };

if (config.env === 'production') {
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
    if (insecureDefaults[key] && process.env[key] === insecureDefaults[key]) {
      throw new Error(`${key} is using an insecure default value`);
    }
  }
}
```

---

## 16. Implementation Roadmap

### Phase 1 — Critical Bug Fixes (Deploy Blockers)

These issues must be resolved before any customer deployment.

| # | Issue | File(s) | Effort |
|---|---|---|---|
| 1.1 | Remove unauthenticated `/contacts/by-pin` | `routes/v1/contacts.js` | 1h |
| 1.2 | Add tenant isolation to Socket.IO emissions | `socketService.js`, `eslService.js`, `server.js` | 2d |
| 1.3 | Fix conference room resolution for DYNAMIC mode | `ersInternalController.js` (resolveRoom) | 1d |
| 1.4 | Fix TOCTOU race in slot assignment (advisory lock) | `ersInternalController.js:205` | 4h |
| 1.5 | Fix caller redial joining wrong room in STATIC mode | `ersInternalController.js` (ersLookup) | 4h |
| 1.6 | Fix auto-recording not writing `ers_incidents.recording_path` | `conferenceManager.js`, `eslService.js` | 4h |
| 1.7 | Fix dual-recording when both record flags enabled | `ersRingService.js` | 2h |
| 1.8 | Fix 3 broken report pages (response shapes, field names, status enums) | `reports.js`, 3 jsx files | 4h |
| 1.9 | Fix `contact-usage` missing LIMIT | `reports.js` | 30m |
| 1.10 | Add startup validation for insecure defaults | `server.js` | 2h |
| 1.11 | Fix queue position race with SELECT FOR UPDATE | `ersInternalController.js:1043` | 2h |
| 1.12 | Add missing indexes: `conference_room`, `(tenant_id, status)` | New migration 028 | 2h |
| 1.13 | Fix `syncTierGroups` inside single transaction | `ersController.js` | 2h |
| 1.14 | Fix `media_files.waveform_peaks` cache (JSON.parse) | `mediaLibraryController.js` | 30m |
| 1.15 | Fix SUPERVISOR upload 403 mismatch (backend → `adminOrSuper`) | `routes/v1/mediaLibrary.js` | 30m |

---

### Phase 2 — Backend Improvements

| # | Issue | Effort |
|---|---|---|
| 2.1 | Extract repository layer (`IncidentRepository`, `CampaignRepository`, `RecordingRepository`) | 1w |
| 2.2 | Replace dynamic imports with event bus in `eslService.js` | 3d |
| 2.3 | Unified `getIncidentConferenceRoom(uuid)` replaces all `resolveRoom` callers | 4h |
| 2.4 | Implement `MODERATOR_JOIN` recording trigger | 4h |
| 2.5 | Add `status` field to `ers_incident_ended` event | 30m |
| 2.6 | Add active incident check before `deleteConfiguration` | 2h |
| 2.7 | Implement `ESC-9` tenant isolation on ERS/ENS data queries | 1d |
| 2.8 | Add Zod validation to `updateTierGroups` and `member_id` fields | 2h |
| 2.9 | Encrypt SIP gateway passwords at rest | 1d |
| 2.10 | Remove legacy `/uploads` static middleware | 1h |
| 2.11 | Add `statement_timeout` to DB pool | 30m |
| 2.12 | Fix `ens_campaigns` primary key split migration (028 repair migration) | 4h |
| 2.13 | Regenerate `schema.sql` to match migration chain | 2h |
| 2.14 | Fix `ers_queues.incident_id NOT NULL + ON DELETE SET NULL` contradiction | 1h |
| 2.15 | Add `recordings.campaign_id` FK constraint | 1h |
| 2.16 | Eliminate `record_conferences` + `recording_enabled` dual-path | 4h |
| 2.17 | Add `mime_type` column to `media_files` | Migration + 2h |
| 2.18 | Remove dead code: `requireInternalKey` in rbac.js, `deterministicRoom`, stale API client methods | 2h |
| 2.19 | Unify phone normalization into `backend/src/utils/phone.js` | 2h |
| 2.20 | Add missing `limit: 1000` to all list calls populating dropdowns | 2h |

---

### Phase 3 — Monitoring Improvements

| # | Issue | Effort |
|---|---|---|
| 3.1 | Talk time accumulation: store `talkStartedAt` on START-TALKING, compute on STOP-TALKING | 4h |
| 3.2 | Restore `joinedAt` for seeded members via cross-reference with `ers_incident_participants` | 4h |
| 3.3 | Add Volume OUT button to participant controls | 2h |
| 3.4 | Add Play Audio File control (via `confPlay`) | 4h |
| 3.5 | Add energy display next to volume controls | 2h |
| 3.6 | Clear conference registry on ESL disconnect; notify clients | 2h |
| 3.7 | Fix Dashboard `active_conferences` tenant scope | 2h |
| 3.8 | Distinguish PRIMARY vs SECONDARY incidents in Dashboard | 4h |
| 3.9 | Fix "Completed Today" stat in CampaignDashboard | 1h |
| 3.10 | Add `allow_rejoin` checkbox to ERS config form | 1h |
| 3.11 | Add conference controls to ErsLive (mute, kick, play) | 1d |
| 3.12 | Add Cancel Incident button to ErsLive | 2h |
| 3.13 | Add Manual ENS Blast Trigger button to ENS list | 4h |
| 3.14 | Add error boundaries to all pages | 4h |
| 3.15 | Replace `window.confirm` / `window.alert` / `window.prompt` with modal components | 1d |
| 3.16 | Fix silent `catch {}` in all report and ERS/ENS pages | 4h |

---

### Phase 4 — Reporting Improvements

| # | Issue | Effort |
|---|---|---|
| 4.1 | Extract `reportController.js` from inline route handlers | 4h |
| 4.2 | Add server-side pagination to all 5 report endpoints | 4h |
| 4.3 | Add `configuration_id` and `sort` filters to ERS and ENS reports | 4h |
| 4.4 | Surface time-to-first-answer, conference duration, queue wait time in ERS detail report | 4h |
| 4.5 | Add recording playback + download to ERS incident detail report | 4h |
| 4.6 | Add ENS delivery rate %, trigger method, answer timestamps to ENS broadcast report | 4h |
| 4.7 | Server-side CSV export for ERS incidents and ENS broadcasts | 1d |
| 4.8 | Implement ring attempt logging table + API | `ers_ring_attempts` table + 1d |
| 4.9 | Implement per-session rejoin tracking | `ers_participant_sessions` table + 1d |
| 4.10 | Implement ENS per-attempt delivery history | `ens_delivery_attempts` table + 1d |
| 4.11 | Add audit trail write points (view, playback, download, complete events) | 1d |
| 4.12 | Add print-friendly CSS to all report pages | 4h |

---

### Phase 5 — UI Improvements

| # | Issue | Effort |
|---|---|---|
| 5.1 | Add React.lazy() / Suspense code splitting for IVR builder and reports | 4h |
| 5.2 | Standardize loading states across all pages (skeleton → spinner hierarchy) | 1d |
| 5.3 | Add empty state messages to ReportContactUsage | 1h |
| 5.4 | Fix `limit: 1000` missing on list calls in ENS, ERS, IVR, Users | 2h |
| 5.5 | Split `MediaLibrary.jsx` into per-component files | 4h |
| 5.6 | Consistent success toast notifications across all create/edit/delete operations | 1d |
| 5.7 | Add incident detail drill-down from ErsLive | 1d |
| 5.8 | Add notification history per ENS config | 1d |
| 5.9 | Add `.alaw` / `.ulaw` to backend `AUDIO_EXTS` or remove from UI accept | 1h |

---

### Phase 6 — Performance and Scalability

| # | Issue | Effort |
|---|---|---|
| 6.1 | Add all missing indexes (migration 028) | 4h |
| 6.2 | Add `statement_timeout` and query-level timeouts | 2h |
| 6.3 | Table partitioning for `audit_logs` by month | 1d |
| 6.4 | Archival job for `ens_campaign_destinations` and `ens_notification_deliveries` | 1d |
| 6.5 | Short-lived signed media tokens (replace `?token=` with opaque tokens) | 1d |
| 6.6 | Add `pg` JSONB type parser registration to pool | 1h |
| 6.7 | Add analytics endpoints + KPI dashboard | `GET /reports/analytics/*` + 1w |
| 6.8 | PDF/XLSX export server-side | `pdfkit` / `exceljs` + 3d |
| 6.9 | Confine `INTERNAL_API_KEY` rate limiting to named IP ranges | 4h |
| 6.10 | Implement `ers_participant_sessions` multi-session rejoin tracking | 1d |

---

## Appendix: Severity Index

| ID | Title | Severity |
|---|---|---|
| SEC-1 | Unauthenticated `/contacts/by-pin` | CRITICAL |
| SEC-2 | Socket.IO no tenant isolation | CRITICAL |
| SEC-3 | SIP/ESL passwords in plaintext | CRITICAL |
| SEC-4 | ESL command injection via audio_path / dial_string | CRITICAL |
| SEC-5 | Weak default credentials ship in source | CRITICAL |
| SEC-6 | Caller ID name ESL injection | HIGH |
| SEC-7 | PINs stored plaintext | HIGH |
| SEC-8 | Missing tenant isolation on ERS/ENS data queries | HIGH |
| SEC-9 | JWT in URL query param | HIGH |
| SEC-10 | `/uploads` static dir unauthenticated | MEDIUM |
| ARCH-1 | No repository layer | HIGH |
| ARCH-2 | Circular imports via dynamic import in hot path | HIGH |
| ARCH-3 | Business logic in route files | MEDIUM |
| ARCH-4 | Two ENS systems without reconciliation | MEDIUM |
| ARCH-5 | No startup config validation | MEDIUM |
| ERS-1 | TOCTOU race — slot assignment | CRITICAL |
| ERS-2 | resolveRoom wrong for DYNAMIC mode | CRITICAL |
| ERS-3 | Caller redial joins wrong STATIC room | CRITICAL |
| ERS-4 | Queue position race condition | CRITICAL |
| ERS-5 | Ring-all deduplication broken for DYNAMIC | HIGH |
| ERS-6 | syncTierGroups not transactional | HIGH |
| ERS-7 | Observer role not representable | HIGH |
| ERS-8 | MODERATOR_JOIN trigger silently ignored | MEDIUM |
| ERS-9 | incident_ended event missing status | MEDIUM |
| ERS-10 | deleteConfiguration no active incident check | MEDIUM |
| CONF-1 | Three competing room resolution functions | CRITICAL |
| CONF-2 | No DB unique constraint for duplicate ACTIVE incidents | HIGH |
| CONF-3 | tierLiveStatus always reports free for DYNAMIC | HIGH |
| CONF-4 | DYNAMIC room name 1-second collision window | MEDIUM |
| REC-1 | Auto-record doesn't write recording_path | CRITICAL |
| REC-2 | Dual recording when both flags enabled | CRITICAL |
| REC-3 | Recording state lost after ESL reconnect | CRITICAL |
| REC-4 | CONFERENCE_CREATED trigger races incident insert | HIGH |
| REC-5 | recordingStartTimers leaks on conference destroy | MEDIUM |
| MON-1 | Dashboard conference count not tenant-scoped | HIGH |
| MON-2 | metrics.active_conferences reducer is dead code | HIGH |
| MON-3 | PRIMARY vs SECONDARY not distinguished in dashboard | HIGH |
| MON-4 | joinedAt null for seeded members | MEDIUM |
| MON-5 | Talk time not accumulated | MEDIUM |
| MON-6 | Volume OUT missing from UI | MEDIUM |
| MON-7 | Energy level and confPlay missing from UI | MEDIUM |
| RPT-1 | ReportNotifications always empty (shape mismatch) | CRITICAL |
| RPT-2 | ReportIncidents always empty (shape mismatch) | CRITICAL |
| RPT-3 | ReportContactUsage all columns blank | CRITICAL |
| RPT-4 | ReportIncidents wrong status enum | CRITICAL |
| RPT-5 | ReportNotifications status filter broken | HIGH |
| RPT-6 | contact-usage no LIMIT | HIGH |
| RPT-7 | Notification title field doesn't exist | HIGH |
| RPT-8 | No server-side pagination on any report | HIGH |
| RPT-9 | No export on detail reports | MEDIUM |
| RPT-10 | recording_path shown as raw path | MEDIUM |
| MEDIA-1 | Stream auth fixed | RESOLVED |
| MEDIA-2 | SUPERVISOR upload 403 mismatch | HIGH |
| MEDIA-3 | Waveform cache never hits (JSON.parse) | MEDIUM |
| MEDIA-4 | .alaw/.ulaw accepted in UI, rejected by backend | MEDIUM |
| MEDIA-5 | mime_type not persisted in DB | MEDIUM |
| SOCK-1 | No tenant isolation (see SEC-2) | CRITICAL |
| SOCK-2 | Registry not cleared on ESL disconnect | HIGH |
| SOCK-3 | Double event processing on rapid reconnect | HIGH |
| SOCK-4 | Concurrent seed not mutex-protected | HIGH |
| SOCK-5 | Energy updates never reach clients | MEDIUM |
| DB-1 | ens_campaigns PK type split | CRITICAL |
| DB-2 | ers_queues NOT NULL + ON DELETE SET NULL contradiction | CRITICAL |
| DB-3 | recordings.campaign_id no FK | CRITICAL |
| DB-4 | Missing index on conference_room | HIGH |
| DB-5 | Missing composite index on (tenant_id, status) | HIGH |
| DB-6 | schema.sql 8 divergences from migration chain | HIGH |
| DB-7 | users.tenant_id nullable, not enforced | HIGH |
| DB-8 | No archival strategy for high-growth tables | HIGH |
| DB-9 | rejoined_at single field | MEDIUM |
| DB-10 | No statement_timeout on pool | MEDIUM |
| DB-11 | 6 orphaned/unused tables | LOW |
| UI-1 | allow_rejoin not rendered in form | HIGH |
| UI-2 | No conference controls on ErsLive | HIGH |
| UI-3 | No manual ENS blast trigger | HIGH |
| UI-4 | No cancel incident button | HIGH |
| UI-5 | Silent catch {} in critical pages | MEDIUM |
| UI-6 | window.confirm/alert/prompt throughout | MEDIUM |
| UI-7 | Missing limit:1000 on list calls | MEDIUM |
| UI-8 | No code splitting | MEDIUM |
| UI-9 | "Completed Today" stat is wrong | MEDIUM |
| UI-10 | MediaLibrary.jsx 1,067 lines | LOW |
| UI-11 | No error boundaries except MediaLibrary | LOW |
