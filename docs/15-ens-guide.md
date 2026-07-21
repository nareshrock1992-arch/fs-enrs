# ENS (Emergency Notification System) Guide

**Document:** 15-ens-guide.md  
**System:** fs-enrs (FreeSWITCH Emergency Notification and Response System)  
**Audience:** System administrators, integration engineers, operations staff  

---

## Overview

The Emergency Notification System (ENS) delivers a recorded voice message simultaneously to all configured contacts via outbound telephone calls. ENS is used for mass emergency notifications, evacuation alerts, drill exercises, and any scenario requiring rapid broadcast to a predefined contact list.

**Key characteristics:**

- Outbound-only: the system calls contacts; contacts do not call in to receive the notification
- Parallel delivery: all contacts are called simultaneously up to `max_concurrent_calls` limit
- Retry logic: unanswered calls are automatically retried based on configuration
- Callback support: contacts can call a replay number to hear the message again
- Adaptive throttling: automatic rate reduction when busy/congestion rates are high
- Cluster-safe: PostgreSQL advisory locks prevent double-dispatch in PM2 multi-process deployments

---

## Architecture

```
Phone Call (IVR Lua)          UI / REST API
       │                            │
       ▼                            ▼
POST /internal/ens/campaign/start   POST /api/v1/campaigns
       │                            │
       └──────────┬─────────────────┘
                  ▼
          ens_campaigns table (status=queued)
                  │
                  ▼ (every 1 second)
         Campaign Engine Tick
         (campaignEngine.js — singleton, advisory lock)
                  │
                  ├── originateCampaignCall() × N
                  │        │
                  │        ▼
                  │   FreeSWITCH ESL
                  │        │
                  │   CHANNEL_ANSWER ──► onCallAnswer(uuid)
                  │   CHANNEL_HANGUP ──► onCallHangup(uuid, cause)
                  │
                  └── emitInternal(enrs::campaign_progress)
                             │
                             ▼
                      Socket.IO → UI monitoring
```

---

## ENS Configuration (`ens_configurations` Table)

Each ENS configuration represents a named notification service with its own contacts, calling behavior, and numbers.

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | Configuration identifier |
| `name` | TEXT | Human-readable name shown in UI |
| `pin` | TEXT | Optional PIN to authorize phone-triggered blasts. NULL = no PIN required |
| `blast_clid` | TEXT | Caller ID displayed to recipients when the system calls them |
| `reply_clid` | TEXT | Number recipients call back to replay the last message |
| `destination_number` | TEXT | Number an operator calls to **trigger** the blast (bound in `emergency_numbers`) |
| `playback_number` | TEXT | Number callers dial to **replay** the last active campaign |
| `max_concurrent_calls` | INTEGER | Maximum simultaneous outbound call legs (default: 10) |
| `calls_per_second` | NUMERIC | Outbound call originate rate per second (default: 2) |
| `batch_size` | INTEGER | Destinations claimed per campaign engine tick (default: 10) |
| `max_attempts` | INTEGER | Maximum call attempts per contact before marking FAILED (default: 3) |
| `retry_interval_sec` | INTEGER | Seconds to wait between retry attempts (default: 60) |
| `campaign_timeout_min` | INTEGER | Campaign expires after this many minutes regardless of completion (default: 60) |
| `adaptive_throttling` | BOOLEAN | If true: auto-reduce CPS when busy/congestion rates are elevated |
| `no_pending_msg` | TEXT | TTS text spoken on playback number when no active campaign exists |
| `expiry_announcement` | TEXT | TTS text spoken on playback number when the last campaign has expired |
| `recording_retention_hours` | INTEGER | Advisory retention period for ENS recordings (default: 24) |
| `tenant_id` | UUID FK | Tenant scoping — always set from `req.user.tenantId` |

### Adaptive Throttling Behavior

When `adaptive_throttling = true`, the campaign engine monitors call outcomes in real time:

| Busy/Congestion Rate | Action |
|---|---|
| > 30% of completed calls | Reduce effective CPS to **75%** of configured value |
| > 15% of completed calls | Reduce effective CPS to **90%** of configured value |
| ≤ 15% | Use full configured `calls_per_second` |

Throttling is evaluated per tick and adjusts dynamically as network conditions improve.

---

## Contact Targeting

Contacts for an ENS campaign are resolved from two sources and merged before dispatch:

### Source 1: Direct Contacts (`ens_configuration_contacts`)

Individual `emergency_contacts` records linked directly to the ENS configuration.

### Source 2: Group Contacts (`ens_configuration_groups` → `responder_group_members`)

Contacts belonging to groups that are linked to the ENS configuration.

### Resolution Query

```sql
SELECT DISTINCT
    ec.id,
    ec.mobile_number,
    ec.name
FROM emergency_contacts ec
WHERE ec.active = true
  AND ec.deleted_at IS NULL
  AND (
      ec.id IN (
          SELECT contact_id
          FROM ens_configuration_contacts
          WHERE ens_configuration_id = $1
            AND deleted_at IS NULL
      )
      OR ec.id IN (
          SELECT rgm.contact_id
          FROM responder_group_members rgm
          JOIN ens_configuration_groups ecg
              ON ecg.group_id = rgm.group_id
          WHERE ecg.ens_configuration_id = $1
            AND ecg.deleted_at IS NULL
            AND rgm.deleted_at IS NULL
      )
  )
ORDER BY ec.id;
```

Contacts appearing in both direct list and group membership are deduplicated by the `DISTINCT` clause. The resolved list is written as individual `ens_campaign_destinations` rows when the campaign is created.

---

## Campaign Data Model

```sql
-- Parent campaign
ens_campaigns
  id, ens_configuration_id, status, triggered_via,
  message_audio_url, notification_uuid,
  total_targets, total_answered, total_no_answer, total_failed,
  campaign_priority, started_at, completed_at,
  campaign_timeout_min, tenant_id

-- Per-contact delivery rows
ens_campaign_destinations
  id, campaign_id, contact_id, mobile_number, contact_name,
  status CHECK(queued|dialing|answered|failed|retried|expired),
  attempts, last_attempted_at, answered_at,
  freeswitch_uuid, hangup_cause, tenant_id
```

---

## Phone-Triggered Blast Flow (IVR Path)

### Prerequisites

- An IVR flow is published and deployed with the ENS trigger number bound in `emergency_numbers`
- The IVR flow contains: `[gather DTMF]` → `[ens_pin_valid condition]` → `[ens_blast_record]` → `[ens node]`

### Step-by-Step Flow

```
1. Operator calls destination_number (e.g., 5500)
          │
          ▼
2. FreeSWITCH routes to IVR Lua script
   Lua: GET /internal/ivr/lookup?number=5500
          │
          ▼
3. IVR node: Gather DTMF PIN
   Lua: POST /internal/ens/verify-pin
        { pin: "1234", configuration_id: "uuid" }
   Response: { authorized: true } — sets session variable ens_authorized=true
          │
          ▼
4. Condition node: ens_pin_valid
   If not authorized → play error + hangup
          │
          ▼
5. IVR node: ens_blast_record
   - Plays prompt: "Record your message after the tone. Press # when finished."
   - FreeSWITCH records input
   - Stores path in session: session.recording_file = /var/lib/freeswitch/recordings/ens/...
          │
          ▼
6. IVR node: ens (blast trigger)
   Lua: POST /internal/ens/campaign/start
        {
          trigger_number: "5500",
          recording_file: session.recording_file,
          configuration_id: "uuid"
        }
   Response: { campaign_id: "uuid", notification_uuid: "uuid", total_targets: 47 }
          │
          ▼
7. Lua: plays confirmation prompt → hangs up
   Campaign dispatches in background
```

### PIN Security

- The PIN is stored in `ens_configurations.pin` (plaintext — treat as a shared secret, not a password).
- The `GET /internal/ens/lookup` response returns only `{ pin_required: true/false }` — the raw PIN value is **never** sent to the Lua script.
- PIN verification is performed server-side by `POST /internal/ens/verify-pin` only.

---

## UI-Triggered Blast Flow

```http
POST /api/v1/ens/notifications
Authorization: Bearer <token>
Content-Type: application/json

{
  "configuration_id": "uuid",
  "triggered_via": "UI",
  "recording_file": "/var/lib/freeswitch/recordings/ens/config-uuid/message.wav"
}
```

Alternatively, via the campaigns endpoint:

```http
POST /api/v1/campaigns
Authorization: Bearer <token>
Content-Type: application/json

{
  "ens_configuration_id": "uuid",
  "triggeredVia": "UI",
  "messageAudioUrl": "/var/lib/freeswitch/recordings/ens/config-uuid/message.wav"
}
```

Both endpoints create an `ens_campaigns` row with `status = 'queued'`. The campaign engine picks it up on the next tick.

---

## Campaign Engine Tick Behavior

The campaign engine (`src/services/campaignEngine.js`) is a singleton that runs a 1-second tick loop. In PM2 cluster mode, PostgreSQL advisory locks ensure only one worker processes campaigns at a time.

### Tick Sequence

```
Every TICK_MS=1000ms:

1. Acquire PostgreSQL advisory lock (pg_try_advisory_lock)
   └── If lock not acquired: skip this tick (another worker is processing)

2. Query active campaigns:
   SELECT * FROM ens_campaigns
   WHERE status IN ('queued', 'running')
     AND deleted_at IS NULL
   ORDER BY campaign_priority DESC, created_at ASC

3. For each campaign:
   ├── a. queued → running
   │        UPDATE ens_campaigns SET status='running' WHERE status='queued'
   │        (idempotent — WHERE status='queued' prevents double-transition)
   │
   ├── b. Check timeout:
   │        IF now() > started_at + campaign_timeout_min minutes:
   │            UPDATE status='expired'
   │            UPDATE remaining DIALING destinations to FAILED
   │            CONTINUE to next campaign
   │
   ├── c. Detect stale DIALING rows:
   │        SELECT COUNT(*) FROM ens_campaign_destinations
   │        WHERE campaign_id = ? AND status='dialing'
   │          AND last_attempted_at < now() - interval '90 seconds'
   │        → Mark stale as FAILED (STALE_DIALING_SEC=90)
   │
   ├── d. Count current DIALING rows (excludes stale):
   │        dialing_count = active dialing rows
   │        availableSlots = max_concurrent_calls - dialing_count
   │
   ├── e. Adaptive throttling:
   │        IF adaptive_throttling=true:
   │            Compute busyRate from recent completed calls
   │            Adjust effective CPS (75% or 90% of configured)
   │
   ├── f. Claim next batch:
   │        UPDATE ens_campaign_destinations
   │        SET status='dialing', last_attempted_at=now()
   │        WHERE id IN (
   │            SELECT id FROM ens_campaign_destinations
   │            WHERE campaign_id=? AND status='queued'
   │            LIMIT batch_size
   │            FOR UPDATE SKIP LOCKED
   │        )
   │        RETURNING *
   │
   ├── g. For each claimed destination:
   │        originateCampaignCall(destination, campaign, configuration)
   │        → eslService: bgapi originate {dial_string} &playback({recording_file})
   │
   ├── h. Check completion:
   │        IF no queued or dialing rows remain:
   │            UPDATE status='completed', completed_at=now()
   │            Emit enrs::campaign_completed
   │
   └── i. Emit progress:
            emitInternal('enrs::campaign_progress', { campaign_id, answered, no_answer, ... })

4. Release advisory lock
```

---

## Call Delivery State Machine

### Destination States

```
queued
  │
  │ (claimed by engine tick)
  ▼
dialing ──────── STALE (90s) ──────► failed
  │                                    ▲
  │ CHANNEL_ANSWER                     │
  ▼                                    │
answered                               │
  │                                    │
  │ CHANNEL_HANGUP                     │
  ▼                                    │
completed ─── (if retryable cause) ──► retried
                                        │
                                        │ (attempts < max_attempts)
                                        ▼
                                      queued (re-queued after retry_interval_sec)
                                        │
                                        │ (attempts >= max_attempts)
                                        ▼
                                      failed
```

### Retryable Hangup Causes

The following `CHANNEL_HANGUP` causes trigger an automatic retry if `attempts < max_attempts`:

| Hangup Cause | Meaning |
|---|---|
| `BUSY` | Remote party busy |
| `USER_BUSY` | User-side busy |
| `NO_ANSWER` | No answer within ring timeout |
| `CALL_REJECTED` | Remote rejected the call |
| `NORMAL_CIRCUIT_CONGESTION` | Network congestion |
| `SWITCH_CONGESTION` | Switch-level congestion |
| `NO_ROUTE_DESTINATION` | No route to destination |
| `ORIGINATOR_CANCEL` | Originator cancelled (internal cancellation) |

All other hangup causes result in immediate `FAILED` status with no retry.

---

## Callback / Replay Flow

Contacts who missed the call, or who wish to hear the message again, call the `reply_clid` number.

```
1. Contact calls reply_clid (e.g., 5501)
          │
          ▼
2. Lua: GET /internal/ens/callbacks/authorize
        ?reply_clid=5501&caller=+1234567890
   Response:
   {
     "authorized": true,
     "notification_uuid": "uuid",
     "recording_file": "/var/lib/freeswitch/recordings/ens/..."
   }
          │
          ▼
3. Lua plays back recording_file to caller

4. Lua: GET /internal/ens/campaigns/:id/playback-log
        ?caller=+1234567890
   (increments callback_count in ens_campaigns, logs individual replay)

5. Lua: POST /internal/ens/callbacks
        {
          "notification_uuid": "uuid",
          "caller_number": "+1234567890",
          "reply_clid": "5501",
          "delivery_id": "uuid"
        }
   (creates ens_callbacks row for reporting)
```

### Playback Number (No Active Campaign)

If a contact calls the playback number when no campaign is active:

- Lua: `GET /internal/ens/lookup?number=<playback_number>`
- Then: `GET /internal/ens/campaigns/latest?configuration_id=<id>`
- If no campaign found: play `no_pending_msg` TTS
- If campaign found but expired: play `expiry_announcement` TTS

---

## Reporting

### ENS Broadcast List

```http
GET /api/v1/reports/ens
Authorization: Bearer <token>

Query Parameters:
  from          ISO8601 datetime
  to            ISO8601 datetime
  configuration_id   UUID (filter by ENS config)
  status        queued | running | completed | expired
  limit         integer (default 20, max 1000)
```

**Response fields:**

| Field | Description |
|---|---|
| `notification_uuid` | Unique identifier for the blast |
| `triggered_via` | `IVR`, `UI`, or `API` |
| `total_targets` | Total contacts targeted |
| `total_answered` | Contacts who answered |
| `total_no_answer` | Contacts who did not answer |
| `total_failed` | Contacts that permanently failed |
| `callback_count` | Replay callbacks received |
| `started_at` / `completed_at` | Campaign timing |

### Per-Contact Delivery Breakdown

```http
GET /api/v1/reports/ens/:notificationUuid
Authorization: Bearer <token>
```

Returns a per-contact breakdown with individual delivery status:

| Status | Description |
|---|---|
| `ANSWERED` | Contact answered at least one call attempt |
| `NO_ANSWER` | All attempts exhausted — no answer |
| `FAILED` | Call failed with non-retryable cause |
| `REPLAYED` | Contact called back on `reply_clid` |

---

## Complete End-to-End Example

**Scenario:** Hospital code blue notification to all ICU nurses

### Configuration

```
ENS Configuration: "ICU Nurse Alert"
  destination_number:     5500
  playback_number:        5501
  reply_clid:             5501
  pin:                    1234
  max_concurrent_calls:   30
  calls_per_second:       5
  max_attempts:           3
  retry_interval_sec:     60
  campaign_timeout_min:   20
  adaptive_throttling:    true
```

**Contacts:** 47 ICU nurses (35 direct + 12 via "ICU Night Shift" group)

### Execution

```
Step 1:  Supervisor calls 5500
Step 2:  IVR prompts for PIN → supervisor enters "1234"
         POST /internal/ens/verify-pin → { authorized: true }
Step 3:  IVR plays: "Record your message after the tone. Press # when finished."
         Supervisor records: "Code blue in ICU ward 3, all nurses report immediately"
         recording_file = /var/lib/freeswitch/recordings/ens/cfg-uuid/20260720-143022.wav
Step 4:  POST /internal/ens/campaign/start
         Response: { campaign_id: "camp-uuid", total_targets: 47 }
Step 5:  Supervisor hears confirmation tone → hangs up

Campaign Engine (running concurrently):
  T+0s:   Campaign status → running; 30 destinations claimed (max_concurrent_calls=30)
           30 bgapi originate commands issued
  T+15s:  27 CHANNEL_ANSWER events received → onCallAnswer()
           17 CHANNEL_HANGUP (after playback) → status=completed
  T+25s:  3 NO_ANSWER after ring timeout → retried (attempt 1 of 3)
           Remaining 17 destinations claimed from queue
  T+60s:  3 retried destinations re-queued for second attempt
  T+85s:  2 of 3 retried contacts answer on second attempt → completed
           1 remains NO_ANSWER → third attempt queued
  T+145s: Final contact NO_ANSWER on third attempt → status=FAILED
  T+146s: All 47 destinations resolved → campaign status=completed

Result:
  total_targets:    47
  total_answered:   44 (38 on first attempt, 5 on retry, 1 on third attempt)
  total_no_answer:   2 (exceeded max_attempts)
  total_failed:      1 (CALL_REJECTED — not retryable)

Step 6:  4 nurses call reply_clid (5501) to hear the message again
         ens_callbacks: 4 rows inserted; callback_count incremented to 4
```

### Report Output

```http
GET /api/v1/reports/ens/camp-uuid
```

```json
{
  "notification_uuid": "camp-uuid",
  "configuration_name": "ICU Nurse Alert",
  "triggered_via": "IVR",
  "total_targets": 47,
  "total_answered": 44,
  "total_no_answer": 2,
  "total_failed": 1,
  "callback_count": 4,
  "started_at": "2026-07-20T14:30:22Z",
  "completed_at": "2026-07-20T14:32:46Z",
  "destinations": [
    {
      "contact_name": "Jane Doe",
      "mobile_number": "+1555000001",
      "status": "ANSWERED",
      "attempts": 1,
      "answered_at": "2026-07-20T14:30:37Z"
    },
    {
      "contact_name": "John Smith",
      "mobile_number": "+1555000008",
      "status": "NO_ANSWER",
      "attempts": 3
    }
  ]
}
```

---

*See also: [14-recording-guide.md](14-recording-guide.md), [16-ers-guide.md](16-ers-guide.md), [17-conference-guide.md](17-conference-guide.md)*
