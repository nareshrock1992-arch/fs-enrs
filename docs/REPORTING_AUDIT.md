# Reporting Module — Complete Architecture Audit

**Date:** 2026-07-18  
**Scope:** Full audit of ERS and ENS reporting — routes, controllers, frontend pages, database schema, and gap analysis against enterprise emergency management system standards.  
**Status:** Pre-implementation audit. No code has been changed.

---

## Executive Summary

The current reporting module is a five-endpoint stub with serious correctness bugs, no controller layer, and major gaps relative to enterprise emergency management standards. Three of the five frontend report pages are non-functional due to field name mismatches and response shape errors. The underlying data model has much of the needed data — the gap is almost entirely in query design, API surface, and frontend presentation.

---

## 1. Current Implementation Inventory

### Backend

All report logic lives inline in a single route file:

```
backend/src/routes/v1/reports.js
```

There is no `reportController.js`. Five endpoints defined:

| Endpoint | Purpose | Limit | Issues |
|---|---|---|---|
| `GET /reports/notifications` | ENS notification history | 500 | Status enums wrong; response not wrapped |
| `GET /reports/incidents` | ERS incident summary | 500 | Status filter uses `IN_PROGRESS` (wrong) |
| `GET /reports/contact-usage` | Contact activity summary | **none** | Field names mismatch frontend; missing LIMIT |
| `GET /reports/ers-incidents` | ERS incident detail | 200 | Thin — no ring attempts, call stats, audit trail |
| `GET /reports/ens-broadcasts` | ENS broadcast detail | 200 | No retry history, no acknowledgement tracking |

### Frontend Pages

| File | Route | Status |
|---|---|---|
| `ReportNotifications.jsx` | ENS notification list | **Broken** — response shape mismatch, wrong field names |
| `ReportIncidents.jsx` | ERS incident summary | **Broken** — status filter enum mismatch (`IN_PROGRESS` never matches) |
| `ReportContactUsage.jsx` | Contact usage | **Broken** — all 4 column fields undefined (name mismatch) |
| `ReportErsIncidents.jsx` | ERS incident detail | Partially works — displays incidents but missing most enterprise fields |
| `ReportEnsBroadcasts.jsx` | ENS broadcast detail | Partially works — shows delivery rows but missing retry, ack, channel data |

---

## 2. Active Bugs (Data Never Reaches the User)

### Bug 1 — `ReportContactUsage.jsx`: All Columns Blank

**Frontend reads:**
```js
r.phone          r.group_count    r.ens_count    r.notification_count
```

**Backend returns:**
```js
r.mobile_number  r.ens_direct_configs  r.ens_group_configs  r.ers_incidents
```

Zero fields align. Every row in the Contact Usage report shows empty cells and zero counts.

---

### Bug 2 — `ReportNotifications.jsx`: Table Always Empty

**Frontend:**
```js
const rows = data.notifications || [];   // ← destructures .notifications
```

**Backend `listNotifications()`:**
```js
res.json({ rows });   // ← returns { rows: [...] }, no .notifications key
```

`data.notifications` is always `undefined`. The `|| []` fallback gives an empty table every time regardless of actual data.

---

### Bug 3 — `ReportNotifications.jsx`: `title` Column Does Not Exist

Frontend renders `r.title || r.id`. The `ens_notifications` table has no `title` column. Falls back to the numeric ID as display text — never the actual notification name.

---

### Bug 4 — `ReportIncidents.jsx`: Status Filter Returns Zero Results

**Frontend dropdown options:**
```
IN_PROGRESS  COMPLETED  CANCELLED  QUEUED
```

**`ers_incidents.status` CHECK constraint:**
```sql
CHECK (status IN ('ACTIVE','COMPLETED','QUEUED','FAILED','CANCELLED'))
```

`IN_PROGRESS` is not a valid status. Any filter on that option returns zero rows. The correct value is `ACTIVE`.

---

### Bug 5 — `ReportNotifications.jsx`: Status Filter Partially Broken

**Frontend dropdown options:** `PENDING`, `SENT`, `FAILED`, `CANCELLED`

**`ens_notifications.status` schema:** `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`

`SENT` does not exist. `CANCELLED` does not exist in this table (it's on `ens_campaigns`, not `ens_notifications`). Filtering on these returns zero results.

---

### Bug 6 — `contact-usage` Query: No Row Limit

The SQL for `/reports/contact-usage` has no `LIMIT` clause. On a tenant with thousands of contacts it can return unbounded results, causing slow responses and client-side memory pressure.

---

## 3. ERS Reporting — Gap Analysis

### 3.1 What Exists

| Data | DB Table | Captured? |
|---|---|---|
| Incident created / ended timestamps | `ers_incidents.started_at`, `ended_at` | ✅ |
| Conference room name | `ers_incidents.conference_room` | ✅ |
| Caller number and name | `ers_incidents.caller_number`, `caller_name` | ✅ |
| Incident UUID | `ers_incidents.incident_uuid` | ✅ |
| ERS configuration name | `ers_configurations.name` (via JOIN) | ✅ |
| Organization name | `organizations.name` (via JOIN) | ✅ |
| Incident status | `ers_incidents.status` | ✅ |
| Responder join time | `ers_incident_participants.joined_at` | ✅ |
| Responder leave time | `ers_incident_participants.left_at` | ✅ |
| Responder rejoin timestamp | `ers_incident_participants.rejoined_at` | ✅ (single field) |
| Responder role (initiator/responder) | `ers_incident_participants.role` | ✅ |
| Contact name | `emergency_contacts` via JOIN | ✅ |
| Recording path | `ers_incidents.recording_path` | ✅ |
| Recording file in `recordings` table | `recordings.incident_uuid` FK | ✅ |
| Tier (primary/secondary) | `ers_incidents.group_type` | ✅ |
| Queue entry time | `ers_incidents.queued_at` | ✅ |
| Queue dequeue time | `ers_incidents.dequeued_at` | ✅ |

### 3.2 What Is Missing

#### 3.2.1 Ring Attempt History — **Not Captured**

**What it is:** A per-responder log of every originate attempt (wave number, timestamp, dial string, hangup cause). The ring-all service fires multiple waves; currently no row is written per attempt.

**Why it matters:** Emergency managers need to know which responders were attempted, at what time, in which wave, and why they didn't answer (BUSY, NO_ANSWER, REJECTED). This is required for post-incident review and responder accountability audits.

**Data availability:** The `startRingAll()` loop in `ersRingService.js` has wave and per-contact originate calls. None of this is persisted. The ESL `CHANNEL_HANGUP` event carries `hangup_cause`.

**Gap:** A new table `ers_ring_attempts` is needed:
```sql
CREATE TABLE ers_ring_attempts (
  id              BIGSERIAL PRIMARY KEY,
  incident_id     INT NOT NULL REFERENCES ers_incidents(id),
  contact_id      INT REFERENCES emergency_contacts(id),
  dial_number     VARCHAR(50),
  wave_number     INT NOT NULL DEFAULT 1,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  hangup_cause    VARCHAR(50),
  answered        BOOLEAN NOT NULL DEFAULT false,
  answer_time_ms  INT
);
```

**API change:** `POST /internal/ers/ring-attempts` called from `ersRingService.js` per originate + per hangup.

---

#### 3.2.2 Answer Time (Time-to-First-Answer) — **Partially Missing**

**What it is:** The elapsed seconds from `incident.started_at` to the first `ers_incident_participants.joined_at`.

**Why it matters:** The most critical KPI in emergency response — how long did it take for someone to pick up? Regulatory and SLA requirements typically mandate this be under 60 seconds.

**Data availability:** Both `started_at` and `joined_at` exist. The value can be computed in SQL as `EXTRACT(EPOCH FROM (MIN(p.joined_at) - i.started_at))`.

**Gap:** Not surfaced in any current report. Needs to be a computed column in `GET /reports/ers-incidents`.

---

#### 3.2.3 Conference Duration vs. Incident Duration — **Conflated**

**What it is:** The conference exists from the moment the caller joins until the last member leaves. The incident clock starts when the caller dials in. These are different: the caller may hold the line without anyone answering for minutes.

**Gap:** `ended_at - started_at` currently measures incident duration. Conference-active duration (from first responder join to last member leave) is not computed. Needs to be derived from `MIN(joined_at)` and `MAX(left_at)` in `ers_incident_participants`.

---

#### 3.2.4 Rejoin History (Multiple Rejoins) — **Single Field Only**

**What it is:** A responder may disconnect and reconnect multiple times during a long incident. The current `ers_incident_participants.rejoined_at` captures only a single rejoined_at timestamp.

**Why it matters:** Reliability audit — repeated disconnections suggest a network problem. Some regulatory frameworks require logging every session boundary.

**Gap:** The `rejoined_at` field on `ers_incident_participants` stores only the last rejoin. A separate `ers_participant_sessions` table is needed for multiple sessions:
```sql
CREATE TABLE ers_participant_sessions (
  id            BIGSERIAL PRIMARY KEY,
  participant_id INT NOT NULL REFERENCES ers_incident_participants(id),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at       TIMESTAMPTZ,
  rejoin_number INT NOT NULL DEFAULT 1
);
```
Alternatively, rejoin count (`rejoin_count` already exists on `ers_incident_responders`) plus session timestamps stored as a JSONB array.

---

#### 3.2.5 Caller Hold Time (Pre-Answer Wait) — **Not Captured**

**What it is:** The time from `incident.started_at` to `MIN(p.joined_at)` where `p.role = 'responder'`. This is how long the emergency caller waited before a responder joined.

**Gap:** Computable from existing data, just not in any current query.

---

#### 3.2.6 Recording Playback and Download Links — **Not in Report UI**

**What it is:** Inline audio player + download button for the incident recording.

**Data availability:** `recordings` table has the file, `recordings/:id/stream` and `recordings/:id/download` endpoints exist. The `incident_uuid` FK links them.

**Gap:** `ReportErsIncidents.jsx` shows `recording_path` as a raw file path string. No playback button, no download link. The recording metadata (duration, file size) is in `recordings.duration_sec` and `recordings.file_size_bytes` but not fetched.

**API change:** The `GET /reports/ers-incidents` query needs to LEFT JOIN `recordings` on `incident_uuid` to return `recordings.id`, `duration_sec`, `file_size_bytes`, `status`.

---

#### 3.2.7 Audit Trail — **Not Implemented**

**What it is:** A chronological log of who accessed, played, or modified each incident record — operator name, action, timestamp, IP address.

**Why it matters:** HIPAA, ISO 22301, and most national emergency management frameworks require a tamper-evident audit trail for incident records.

**Data availability:** An `audit_logs` table is referenced in the ENS broadcast report query (`WHERE action = 'ers_playback_attempt'`) — it exists in the DB. Write points for ERS are missing.

**Gap:** No writes to `audit_logs` on: incident view, recording playback, incident complete, recording download. The `audit_logs` table structure needs to be confirmed, then write calls added to `ersController.getIncident()`, `streamRecording()`, and `completeIncidentExternal()`.

---

#### 3.2.8 Export (PDF, Excel, CSV, JSON) — **CSV Only, Partially**

**What it is:** One-click export of a report to a common interchange format.

**Data availability:** All data is queryable. 

**Gap:** The current CSVs in `ReportIncidents.jsx` and `ReportContactUsage.jsx` are client-side JavaScript array-to-CSV conversions that only export what is currently loaded (max 500 rows) and only a subset of columns. No PDF, no Excel (XLSX), no JSON export. No server-side streaming export for large datasets.

---

#### 3.2.9 Conference-Level Statistics — **Not in Any Report**

**What it is:** Per-incident aggregate stats: total participants, total responders who answered, total who were attempted, average ring time, total conference duration, member overlap count.

**Gap:** None of these are computed or surfaced. Must be derived queries added to the report API.

---

#### 3.2.10 Filters, Search, Sorting, Pagination — **Basic / Broken**

| Feature | ERS Incidents | ERS Summary |
|---|---|---|
| Date range filter | ✅ | ✅ |
| Status filter | Broken (wrong enum) | Broken (wrong enum) |
| Organization filter | ✅ | ✅ |
| ERS Configuration filter | ❌ Missing | ❌ Missing |
| Conference room search | ❌ Missing | ❌ Missing |
| Caller number search | ❌ Missing | ❌ Missing |
| Column sorting | ❌ Missing | ❌ Missing |
| Server-side pagination | ❌ (fixed limit 200/500) | ❌ |
| Total count returned | ❌ | ❌ |

---

#### 3.2.11 Print-Friendly Layout — **Not Implemented**

**Gap:** No `@media print` CSS, no print button. The accordion-based layout in `ReportErsIncidents.jsx` does not expand all rows on print, making it useless for physical records.

---

## 4. ENS Reporting — Gap Analysis

### 4.1 What Exists

| Data | DB Location | Captured? |
|---|---|---|
| Campaign UUID, status | `ens_campaigns` | ✅ |
| Total destinations, answered, failed counts | `ens_campaigns` | ✅ |
| Recording file path | `ens_campaigns.recording_file` | ✅ |
| Started / completed timestamps | `ens_campaigns` | ✅ |
| Per-contact delivery status | `ens_campaign_destinations.status` | ✅ |
| Per-contact phone number | `ens_campaign_destinations.contact_number` | ✅ |
| Attempt count per contact | `ens_campaign_destinations.attempt_count` | ✅ |
| Hangup cause | `ens_campaign_destinations.hangup_cause` | ✅ |
| Answer timestamp | `ens_campaign_destinations.answered_at` | ✅ |
| Call UUID | `ens_campaign_destinations.call_uuid` | ✅ |
| Next retry scheduled | `ens_campaign_destinations.next_attempt_at` | ✅ |
| Triggered by (number) | `ens_campaigns.trigger_number` | ✅ |
| Triggered via | `ens_campaigns.triggered_via` | ✅ |

### 4.2 What Is Missing

#### 4.2.1 Retry History Per Contact — **Not Surfaced**

**What it is:** For each contact, a row per call attempt (attempt 1: NO_ANSWER → attempt 2: ANSWERED). The current report shows the final `attempt_count` but not the per-attempt log.

**Data availability:** `ens_campaign_destinations` has `attempt_count` and `hangup_cause` for the final attempt. Individual attempt history is not stored — only the current state is overwritten.

**Gap:** A separate `ens_delivery_attempts` table is needed:
```sql
CREATE TABLE ens_delivery_attempts (
  id            BIGSERIAL PRIMARY KEY,
  destination_id INT NOT NULL REFERENCES ens_campaign_destinations(id),
  attempt_number INT NOT NULL,
  call_uuid     VARCHAR(50),
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hangup_cause  VARCHAR(50),
  answered      BOOLEAN NOT NULL DEFAULT false,
  answered_at   TIMESTAMPTZ
);
```
The campaign engine writes a row on every `bgapi originate` + `CHANNEL_HANGUP` pair.

---

#### 4.2.2 Acknowledgement Tracking — **Not Implemented**

**What it is:** For ENS blasts that require the recipient to press a DTMF key to confirm receipt, tracking who acknowledged and when.

**Why it matters:** Life-safety broadcasts (evacuation, shelter-in-place) must have a confirmed receipt audit. Unacknowledged contacts need re-notification or manual follow-up.

**Data availability:** Nothing exists. The blast Lua script currently only plays the recording — no DTMF confirmation flow.

**Gap:** Requires:
1. Lua enhancement: capture DTMF after playback, POST result to new `/internal/ens/acknowledge` endpoint
2. New column on `ens_campaign_destinations`: `acknowledged_at TIMESTAMPTZ`, `ack_dtmf VARCHAR(1)`
3. `GET /reports/ens-broadcasts/:id/acknowledgements` — list of who confirmed
4. `ack_rate` aggregate on broadcast summary

---

#### 4.2.3 Channel Statistics — **Not Implemented**

**What it is:** Breakdown of delivery by channel type — extension dial vs. gateway/mobile. Which gateway carried the most successful deliveries. Which hangup causes dominated.

**Data availability:** `ens_campaign_destinations.call_uuid` + FreeSWITCH CDR (if stored) has channel info. The dial string resolution (extension vs. gateway) happens in `dialResolver.js` — the gateway name could be logged.

**Gap:** The campaign engine's `originateCampaignCall()` knows which gateway was used. This should be stored on `ens_campaign_destinations.gateway_name VARCHAR(100)`.

---

#### 4.2.4 Contact Statistics — **Minimal**

**What it is:** Per-contact delivery rate across all campaigns — how reliable is each contact's phone number? Which contacts consistently fail?

**Data availability:** `ens_campaign_destinations` has all per-contact results across all campaigns.

**Gap:** `/reports/contact-usage` does provide some ENS stats but the field names are wrong (Bug 1) and the query doesn't include per-contact delivery rate (answered / total attempts).

---

#### 4.2.5 Playback Audit Log — **Partially Implemented, Not Surfaced**

**What it is:** When a contact calls back to hear the playback (`ENS_retry_playback.lua`), that access should be logged and shown in the report.

**Data availability:** The `ens-broadcasts` report backend already queries `audit_logs WHERE action = 'ers_playback_attempt'` — but no Lua script or controller currently writes to `audit_logs`. The query returns zero rows.

**Gap:** `ENS_retry_playback.lua` needs to POST a log entry to a new `/internal/ens/playback-log` endpoint that writes to `audit_logs`.

---

#### 4.2.6 Broadcast Duration / Send Rate — **Not Computed**

**What it is:** Total elapsed time from first call to last call. Calls-per-minute throughput. This shows whether the system performed under load.

**Gap:** Computable from `MIN(attempted_at)` and `MAX(answered_at OR next_attempt_at)` on `ens_delivery_attempts` once that table exists.

---

#### 4.2.7 Export Support — **Client-Side CSV Only**

Same gap as ERS: no XLSX, no PDF, no server-side streaming export.

---

## 5. Cross-Cutting Gaps

### 5.1 No Shared `reportController.js`

All SQL is inline in the route file. There is no separation of concerns. Adding any new query requires editing the route file, which is both an architectural smell and a testability barrier.

**Recommendation:** Extract all query logic to `src/controllers/reportController.js`. The routes file should contain only middleware and handler references.

### 5.2 No Server-Side Pagination

All five endpoints use a hard `LIMIT` (200–500). There is no `total` count returned, no `page`/`limit` query params accepted, no cursor. On a system that has run for a year, these limits will silently truncate real data.

**Recommendation:** Every list endpoint should return `{ data: [...], total: N, page: N, limit: N }` and accept `?page=&limit=&sort=&dir=` query params.

### 5.3 No Column Sorting

No report supports `ORDER BY` other than the hardcoded default. Operators can't sort by duration, by answer time, by delivery count, or by any other column.

### 5.4 No Full-Text Search

No endpoint supports searching by caller number, responder name, conference room, recording file name, or any text field.

### 5.5 No Export Infrastructure

There is no shared export service. CSV conversion is done ad-hoc in each frontend component and covers only visible columns in the current page load.

**Recommendation:** A server-side `GET /reports/:type/export?format=csv|xlsx|json` endpoint that streams the full dataset (no pagination cap) with all columns.

### 5.6 No Print Layout

No `@media print` CSS exists anywhere in the reports pages.

---

## 6. Data Available But Not Used

The following data exists in the database and is captured by the backend but is not surfaced in any report:

| Data | Table.Column | Not Used In |
|---|---|---|
| Queue wait time (queued → dequeued) | `ers_incidents.queued_at`, `dequeued_at` | All ERS reports |
| Cancellation time | `ers_incidents.cancelled_at` | All ERS reports |
| Responder rejoin count | `ers_incident_responders.rejoin_count` | ERS detail report |
| Responder join method | `ers_incident_responders.joined_via` | ERS detail report |
| ERS recording duration / file size | `recordings.duration_sec`, `file_size_bytes` | ERS detail report |
| Recording status | `recordings.status` | ERS detail report |
| Campaign recording file | `ens_campaigns.recording_file` | ENS broadcast report |
| ENS contact answer timestamp | `ens_campaign_destinations.answered_at` | ENS detail report |
| ENS next retry scheduled | `ens_campaign_destinations.next_attempt_at` | ENS detail report |
| ENS trigger method | `ens_campaigns.triggered_via` | ENS summary |
| ENS triggering number | `ens_campaigns.trigger_number` | ENS summary |
| Number of max allowed retries | `ens_campaign_destinations.max_attempts` | ENS detail |

---

## 7. Implementation Roadmap

### Phase 1 — Critical Bug Fixes (No DB changes required)

These are correctness bugs. Nothing works until these are fixed.

**Priority 1.1 — Fix field name mismatches in `contact-usage`**
- Update the SQL query in `reports.js` to alias columns as `phone`, `group_count`, `ens_count`, `notification_count` to match frontend expectations — OR update the frontend to use the backend's actual column names. The frontend column names are more descriptive; recommend aligning the SQL aliases to match.
- Add `LIMIT 500` to the query.

**Priority 1.2 — Fix `ReportNotifications.jsx` response shape**
- Backend `listNotifications()` returns `{ rows: [...] }`. Frontend expects `{ notifications: [...] }`.
- Fix the backend to return `{ notifications: rows }` — or fix the frontend to read `data.rows`. Prefer fixing the backend to be consistent with other report endpoints (which return named arrays).

**Priority 1.3 — Fix status enum values**
- `ReportIncidents.jsx`: Change `IN_PROGRESS` → `ACTIVE` in the dropdown.
- `ReportNotifications.jsx`: Remove `SENT`, change `CANCELLED` → `IN_PROGRESS`/`COMPLETED` to match actual schema.

**Priority 1.4 — Add `ens_notifications.name` or fall back gracefully**
- The `ens_notifications` table has no `name`/`title` column. Either: add the column (populate from `ens_configurations.name` at insert time), or display `ens_name` from the JOIN to `ens_configurations` instead of `r.title`.

**Priority 1.5 — Fix `contact-usage` response / field mapping**
- Backend returns `ens_direct_configs`, `ens_group_configs`, `ers_incidents`, `mobile_number`. Update frontend to use these exact names, or alias in the SQL query.

**Priority 1.6 — Extract `reportController.js`**
- Move all inline query handlers from `routes/v1/reports.js` into `src/controllers/reportController.js`.
- This is a prerequisite for all Phase 2 work and should be done before any feature additions.

---

### Phase 2 — Enterprise Reporting Enhancements

These additions use data that **already exists** in the database. No schema changes required for most of these.

**Priority 2.1 — ERS Detail Report: Surface existing data**

Enhance `GET /reports/ers-incidents` to include:
- `time_to_first_answer_sec`: `EXTRACT(EPOCH FROM (MIN(p.joined_at) - i.started_at))` from `ers_incident_participants`
- `conference_duration_sec`: `EXTRACT(EPOCH FROM (MAX(p.left_at) - MIN(p.joined_at)))` 
- `caller_hold_time_sec`: same as time_to_first_answer for the caller
- `queue_wait_time_sec`: `EXTRACT(EPOCH FROM (i.dequeued_at - i.queued_at))` (nullable)
- `responder_count`: total joined
- `attempted_count`: total attempted (from `ers_incident_responders`)
- `answer_rate_pct`: `100.0 * responder_count / NULLIF(attempted_count, 0)`
- `rejoin_count`: SUM of `ers_incident_responders.rejoin_count`
- Recording fields: JOIN `recordings r ON r.incident_uuid = i.incident_uuid` → `r.id AS recording_id`, `r.duration_sec`, `r.file_size_bytes`, `r.status AS recording_status`

**Priority 2.2 — ERS Detail Report: Participant timeline**

Existing `ers_incident_participants` data is fetched but not displayed as a meaningful timeline. Enhance the frontend sub-table to show:
- Role badge (INITIATOR / RESPONDER)
- Join time (absolute + relative to incident start)
- Leave time
- Duration in conference
- Rejoin flag + rejoin timestamp + rejoin count
- Contact name + number (resolved via `emergency_contacts` JOIN)
- `joined_via` value

**Priority 2.3 — ENS Broadcast Report: Surface existing data**

Enhance `GET /reports/ens-broadcasts` to include per-contact rows from `ens_campaign_destinations`:
- Answered timestamp
- Next retry scheduled
- Max attempts configured
- Whether max attempts reached
- Call UUID (for cross-reference)

Add broadcast-level aggregates:
- `delivery_rate_pct`: `100.0 * total_answered / NULLIF(total_destinations, 0)`
- `avg_answer_time_sec`: mean time from `started_at` to first `answered_at` across all destinations
- `triggered_via`, `trigger_number` on the broadcast header
- Recording playback link (JOIN `recordings r ON r.ens_notification_id = n.id` or via `ens_campaigns.recording_file`)

**Priority 2.4 — Add server-side pagination to all report endpoints**

Replace fixed `LIMIT` with:
```js
const page   = Math.max(1, Number(req.query.page)  || 1);
const limit  = Math.min(200, Number(req.query.limit) || 50);
const offset = (page - 1) * limit;
```

Return:
```json
{ "data": [...], "total": 1234, "page": 2, "limit": 50 }
```

Run a separate `COUNT(*)` query (or use `COUNT(*) OVER()` window function).

**Priority 2.5 — Add missing filters**

ERS Incidents:
- `?configuration_id=` — filter by ERS config
- `?conference_room=` — exact or ILIKE match
- `?caller_number=` — exact or partial match
- `?sort=started_at|duration|answer_time&dir=asc|desc`

ENS Broadcasts:
- `?configuration_id=` — filter by ENS config
- `?status=` — using correct enum values
- `?triggered_via=lua|api`
- `?sort=started_at|delivery_rate|total_destinations&dir=asc|desc`

Contact Usage:
- `?organization_id=`
- `?limit=&page=`
- `?sort=total_incidents|total_campaigns|answer_rate`

**Priority 2.6 — ERS Recording playback in report**

Update `ReportErsIncidents.jsx` to:
- Fetch recording metadata by joining `recordings` in the API response
- Render an `<audio>` element with `src="/api/v1/recordings/:id/stream?token=..."` when a recording exists
- Show duration, file size
- Add download button → `/recordings/:id/download?token=...`

**Priority 2.7 — CSV Export: Comprehensive columns**

Current frontend CSV exports cover only ~4 columns (what's visible in the table). Add a server-side export endpoint:

```
GET /reports/ers-incidents/export?format=csv&from=&to=&configuration_id=
GET /reports/ens-broadcasts/export?format=csv&from=&to=&configuration_id=
```

Streams full dataset (no pagination cap). CSV includes all header columns (incident ID, UUID, config name, org, caller, room, started, ended, duration, answer time, responder count, recording). No XLSX dependency required for Phase 2 — use the `csv` npm package or manual string building.

---

### Phase 3 — Advanced Analytics and New Data Capture

These require **schema changes** (new tables or columns) and changes to backend services.

**Priority 3.1 — Ring Attempt Logging**

**New table:** `ers_ring_attempts` (schema above in §3.2.1)

**Write point:** `ersRingService.startRingAll()` — after each `originateLeg()` call, insert a row with `wave_number`, `attempted_at`, `dial_number`, `contact_id`. On `CHANNEL_HANGUP` ESL event, update with `hangup_cause`, `answered`.

**New API endpoint:** `GET /reports/ers-incidents/:uuid/ring-attempts` — paginated list of all originate attempts for an incident.

**Report enhancement:** New "Ring Attempts" tab in `ReportErsIncidents` showing the ring wave timeline: Wave 1 → 3 contacts → none answered → Wave 2 → 3 contacts → 1 answered.

---

**Priority 3.2 — Multiple Rejoin Sessions**

**New table:** `ers_participant_sessions` (schema above in §3.2.4)

**Write point:** `ersInternalController.ersUpdateResponder()` — on `REJOINED` status, insert a new session row rather than overwriting `rejoined_at`.

**Report enhancement:** Expand the participant timeline to show all sessions as sub-rows.

---

**Priority 3.3 — ENS Delivery Attempt History**

**New table:** `ens_delivery_attempts` (schema above in §4.2.1)

**Write point:** `campaignEngine.js` — on every originate + hangup pair, write a row.

**Report enhancement:** "Attempt History" accordion per contact in the ENS broadcast report.

---

**Priority 3.4 — ENS Acknowledgement Tracking**

**Schema change:** Add `acknowledged_at TIMESTAMPTZ`, `ack_dtmf VARCHAR(1)` to `ens_campaign_destinations`.

**Lua change:** `blast_call.lua` optionally captures DTMF after playback and POSTs to `/internal/ens/acknowledge`.

**New endpoint:** `POST /internal/ens/acknowledge` — writes `acknowledged_at` and `ack_dtmf`.

**Report enhancement:** Acknowledgement rate column on broadcast summary; acknowledgement log tab showing who confirmed.

---

**Priority 3.5 — Audit Trail**

**Assumed existing:** `audit_logs` table (referenced in existing ens-broadcasts query).

**Write points needed:**
- `ersController.getIncident()` → log `VIEW_INCIDENT`
- `recordingController.streamRecording()` → log `PLAYBACK_RECORDING`
- `recordingController.downloadRecording()` → log `DOWNLOAD_RECORDING`
- `ersController.completeIncidentExternal()` → log `COMPLETE_INCIDENT`
- `ENS_retry_playback.lua` → POST to `/internal/ens/playback-log`

**New API endpoint:** `GET /reports/ers-incidents/:uuid/audit-trail` — chronological log of all access and state change events.

---

**Priority 3.6 — Export: PDF and XLSX**

**PDF:** Server-side generation using `pdfkit` or `puppeteer`. A dedicated `GET /reports/ers-incidents/:uuid/export?format=pdf` renders an incident summary sheet: header block, participant timeline table, ring attempt table, recording info. Suitable for printing or e-mailing to incident commanders.

**XLSX:** Use `exceljs` npm package. One worksheet per section (Summary, Participants, Ring Attempts).

---

**Priority 3.7 — Analytics Dashboard**

New page: `reports/AnalyticsDashboard.jsx`

Components:
- Average time-to-first-answer by ERS config (line chart over time)
- Responder answer rate by contact (table, sortable)
- Incidents by hour of day / day of week (heatmap)
- ENS delivery success rate trend (line chart)
- Contact reliability score (successful deliveries / total attempts per contact)
- Conference utilization (peak concurrent conferences over time)

All backed by new aggregation endpoints:
```
GET /reports/analytics/ers-kpis?period=week|month&configuration_id=
GET /reports/analytics/ens-kpis?period=week|month&configuration_id=
GET /reports/analytics/contact-reliability?sort=worst|best
```

---

## 8. Summary Table

| Feature | Status | Phase | DB Change? |
|---|---|---|---|
| Fix Contact Usage field names | **Bug** | 1 | No |
| Fix Notifications response shape | **Bug** | 1 | No |
| Fix ERS status enum (IN_PROGRESS→ACTIVE) | **Bug** | 1 | No |
| Fix ENS status enum (SENT→COMPLETED) | **Bug** | 1 | No |
| Fix missing title → ens_name | **Bug** | 1 | No |
| Extract reportController.js | Refactor | 1 | No |
| Time-to-first-answer metric | Missing | 2 | No (query only) |
| Conference duration metric | Missing | 2 | No (query only) |
| Queue wait time in report | Missing | 2 | No (query exists) |
| Answer rate % | Missing | 2 | No (query only) |
| Recording playback in report | Missing | 2 | No (endpoint exists) |
| Server-side pagination + total count | Missing | 2 | No |
| ERS config / room / caller filters | Missing | 2 | No |
| Column sorting | Missing | 2 | No |
| Server-side CSV export | Missing | 2 | No |
| ENS delivery rate % | Missing | 2 | No (query only) |
| ENS retry count surface | Missing | 2 | No (column exists) |
| ENS trigger method / number | Missing | 2 | No (column exists) |
| Ring attempt logging | Missing | 3 | Yes — new table |
| Multiple rejoin session logging | Missing | 3 | Yes — new table |
| ENS per-attempt history | Missing | 3 | Yes — new table |
| ENS acknowledgement tracking | Missing | 3 | Yes — new columns |
| Audit trail write points | Missing | 3 | Yes — new writes |
| PDF export | Missing | 3 | No |
| XLSX export | Missing | 3 | No |
| Analytics dashboard | Missing | 3 | No (new queries) |
| Print-friendly layout | Missing | 2 | No |
