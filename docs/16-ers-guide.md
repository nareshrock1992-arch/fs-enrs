# ERS (Emergency Response System) Guide

**Document:** 16-ers-guide.md  
**System:** fs-enrs (FreeSWITCH Emergency Notification and Response System)  
**Audience:** System administrators, integration engineers, operations staff  

---

## Overview

The Emergency Response System (ERS) connects an emergency caller into a live conference bridge and simultaneously rings all configured responders. When a responder answers, they are joined directly to the conference. The initiating caller, the responders, and any observers can communicate in real time for the duration of the incident.

**Key characteristics:**

- Ring-all: all tier responders are called simultaneously
- Conference bridge: all parties share a single audio room
- Max 2 concurrent conferences per ERS configuration by default (configurable)
- Overflow queue: callers beyond slot capacity are queued with polling
- Rejoin: callers who disconnect accidentally can reconnect to an active incident
- Open access: observers can join without triggering a ring-all
- Automatic and manual recording support
- CLI authentication: optionally restrict to authorized caller numbers

---

## Architecture

```
Emergency Caller
       │ dials emergency_number
       ▼
FreeSWITCH → Lua: ers_conference_bridge.lua
       │
       ├── GET /internal/ers/lookup?number=<dest>
       │       Returns: full config, bridge numbers, responder tiers,
       │                queue settings, slot assignment
       │
       ├── GET /internal/ers/tier-status?configuration_id=<id>
       │       Returns: primary/secondary slot occupancy
       │
       └── POST /internal/ers/ring-all
               { configuration_id, tier, caller_number }
                       │
                       ▼
              ersInternalController
                       │
                       ├── INSERT ers_incidents (status=ACTIVE)
                       ├── INSERT ers_incident_participants (initiator)
                       └── erlRingService.startRingAll()
                                   │
                       ┌──── ring loop ────────────────────┐
                       │  bgapi originate × N responders   │
                       │  FreeSWITCH routes to conference  │
                       │  ESL add-member → trackParticipant│
                       └───────────────────────────────────┘
                                   │
                       Socket.IO → enrs::ers_incident_update → UI
```

---

## ERS Configuration Fields

Each `ers_configurations` row defines a complete emergency response service instance.

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | Configuration identifier |
| `name` | TEXT | Human-readable name |
| `emergency_number` | TEXT | Number callers dial to trigger ERS |
| `rejoin_number` | TEXT | Number a dropped caller dials to reconnect |
| `open_access_number` | TEXT | Number for observers to join without ring-all |
| `max_concurrent_conferences` | INTEGER | Maximum parallel conferences per slot type (default: 2) |
| `conference_profile` | TEXT | FreeSWITCH conference profile name (default: `default`) |
| `ring_timeout_seconds` | INTEGER | NULL = ring indefinitely (up to 2 hours); integer = ring for N seconds then stop |
| `retry_ring_count` | INTEGER | Legacy retry setting — number of additional ring waves |
| `retry_ring_interval` | INTEGER | Legacy retry setting — seconds between waves |
| `record_conferences` | BOOLEAN | Enable automatic conference recording |
| `recording_enabled` | BOOLEAN | Alias for `record_conferences` |
| `recording_mode` | TEXT | `AUTO` or `MANUAL` |
| `recording_trigger` | TEXT | `CONFERENCE_CREATED`, `FIRST_PARTICIPANT`, `MODERATOR_JOIN` |
| `allow_rejoin` | BOOLEAN | Allow disconnected callers to rejoin via `rejoin_number` |
| `cli_authentication` | BOOLEAN | If true: only callers listed in `ers_cli_authorized` may trigger ERS |
| `queue_enabled` | BOOLEAN | If true: callers beyond slot capacity are queued rather than rejected |
| `tenant_id` | UUID FK | Tenant scoping — always set from `req.user.tenantId` |

---

## Tier System

Each ERS configuration has two responder tiers: **primary** and **secondary**. Responders are assigned to a tier and are ringed simultaneously when an incident in that tier is triggered.

### Responder Resolution

Responders are resolved from two sources per tier, then merged and deduplicated:

**Source 1: Individual contacts** (`ers_tier_contacts`)

```sql
SELECT etc.contact_id, etc.priority, ec.mobile_number, ec.name
FROM ers_tier_contacts etc
JOIN emergency_contacts ec ON ec.id = etc.contact_id
WHERE etc.ers_configuration_id = $1
  AND etc.tier = $2          -- 'primary' or 'secondary'
  AND etc.deleted_at IS NULL
  AND ec.active = true
  AND ec.deleted_at IS NULL
ORDER BY etc.priority ASC;
```

**Source 2: Group-based contacts** (`ers_tier_groups` → `responder_group_members`)

```sql
SELECT rgm.contact_id, ec.mobile_number, ec.name
FROM ers_tier_groups etg
JOIN responder_group_members rgm ON rgm.group_id = etg.group_id
JOIN emergency_contacts ec ON ec.id = rgm.contact_id
WHERE etg.ers_configuration_id = $1
  AND etg.tier = $2
  AND etg.deleted_at IS NULL
  AND rgm.deleted_at IS NULL
  AND ec.active = true
  AND ec.deleted_at IS NULL;
```

Both result sets are merged with deduplication on `contact_id` before being passed to the ring-all engine.

---

## Conference Slot Assignment

Each ERS configuration supports up to `max_concurrent_conferences` simultaneous incidents per tier type.

### Slot Naming Convention

```
ers_{ers_configuration_id}_{tier_prefix}{slot_number}

Primary tier, slot 1:   ers_1_p1
Primary tier, slot 2:   ers_1_p2
Secondary tier, slot 1: ers_1_s1
Secondary tier, slot 2: ers_1_s2
```

### Slot Status Check

Before creating a new incident, Lua calls:

```http
GET /internal/ers/tier-status?configuration_id=<id>
```

**Response:**

```json
{
  "primary": {
    "occupied": true,
    "live_members": 4,
    "incident_uuid": "uuid",
    "conference_room": "ers_1_p1"
  },
  "secondary": {
    "occupied": false,
    "live_members": 0,
    "incident_uuid": null,
    "conference_room": null
  },
  "slots_available": 1
}
```

### Overflow Handling

If all slots are occupied and `queue_enabled = true`:

```
Slot 1 (ers_1_p1): OCCUPIED
Slot 2 (ers_1_p2): OCCUPIED
                       │
                       ▼
              POST /internal/ers/overflow/enqueue
              { configuration_id, caller_number, destination_number }
              Response: { queue_id: "uuid", position: 3 }
                       │
                       ▼
              Lua polls every 3 seconds:
              GET /internal/ers/overflow/poll?queue_id=<id>
              Response (while waiting): { ready: false, position: 3 }
              Response (slot free):     { ready: true, conference_room: "ers_1_p1" }
```

Queued `ers_queues` rows older than 2 hours are automatically expired by a 60-second background cleanup job.

---

## Ring-All Flow (Critical Path)

### Phase 1: Incident Creation

```http
POST /internal/ers/ring-all
X-Internal-Key: <INTERNAL_API_KEY>
Content-Type: application/json

{
  "configuration_id": "uuid",
  "tier": "primary",
  "caller_number": "+15551234567"
}
```

**Controller actions (`ersInternalController.js`):**

1. Resolve conference room name for the available slot (`ers_{config_id}_p{N}`)
2. `INSERT INTO ers_incidents` — status=`ACTIVE`, conference_room=room
3. `INSERT INTO ers_incident_participants` — role=`initiator`, raw_number=caller_number
4. Pre-populate responder rows: `INSERT INTO ers_incident_responders (status=INVITED)` for all resolved tier contacts
5. Call `erlRingService.startRingAll(incident, responders, config)`

**Response:**

```json
{
  "success": true,
  "incident_uuid": "uuid",
  "conference_room": "ers_1_p1",
  "responder_count": 8
}
```

### Phase 2: Ring Loop

`erlRingService.startRingAll()` runs asynchronously (non-blocking to the HTTP response):

```
Constants:
  LEG_TIMEOUT_S  = 25   -- seconds per ring wave
  RING_POLL_MS   = 3000 -- poll interval within each wave
  MAX_RUNTIME_S  = 7200 -- 2-hour absolute deadline

Loop (until deadline or stop condition):
  ├── wave++
  │
  ├── getConferenceMemberCount(room) via ESL
  │   Response: current member count in conference
  │
  ├── If wave > 0 AND member_count == 0:
  │   Caller abandoned — no one in conference
  │   → Stop ring loop
  │   → UPDATE ers_incidents SET status=COMPLETED (no responders joined)
  │
  ├── If member_count > 1:
  │   At least one responder has joined (initiator + responder = 2)
  │   → Optionally start recording (if recording_mode=AUTO)
  │   → Stop ring loop (responders are handling the incident)
  │
  ├── Fire bgapi originate for each responder:
  │   bgapi originate
  │     {origination_caller_id_number=<initiator_number>}
  │     {origination_caller_id_name=<initiator_name>}
  │     {ignore_early_media=true}
  │     {origination_uuid=<generated_uuid>}
  │     user/<extension>
  │     &conference(<room>@<conference_profile>)
  │
  └── Wait LEG_TIMEOUT_S, polling every RING_POLL_MS for member count changes
```

> **Note on `origination_caller_id_number`:** This is intentionally set to the initiator's number so that when a responder's phone displays caller ID, it shows the emergency caller's number — not the system's number. However, this means FreeSWITCH sets `Caller-Caller-ID-Number` in the `add-member` ESL event to the **initiator's number**, not the responder's extension. See [Participant Tracking](#participant-tracking-trackparticipant) below.

---

## Participant Tracking (`trackParticipant`)

### Problem: CallerID Ambiguity in `add-member` Events

When FreeSWITCH sends a `conference::maintenance add-member` event for an outbound ring-all leg, the ESL headers carry:

| ESL Header | Value Set By | Content |
|---|---|---|
| `Caller-Caller-ID-Number` | `origination_caller_id_number` variable | **Initiator's number** (intentional — shows emergency number on responder's phone) |
| `Caller-Caller-ID-Name` | `origination_caller_id_name` variable | Initiator's name or `"Outbound Call"` |
| `Caller-Destination-Number` | FreeSWITCH routing | **Responder's actual extension** |
| `Caller-Unique-ID` | FreeSWITCH | Channel UUID |

Because `Caller-Caller-ID-Number` is the initiator's number on all outbound legs, it cannot be used to identify which responder answered. The correct approach is to use `Caller-Destination-Number`.

### Identification Algorithm

```javascript
// eslService.js: trackParticipant(confName, memberId, headers)

const callerNum = headers['Caller-Caller-ID-Number'];  // initiator's number
const destNum   = headers['Caller-Destination-Number']; // responder's extension
const uuid      = headers['Caller-Unique-ID'];

// Step 1: Try to identify by destNum (responder's actual extension)
const contactByDest = await lookupContactByNumber(destNum, tenantId);

if (contactByDest) {
    // This is a responder leg
    trackingNum  = destNum;                        // responder's extension
    displayName  = contactByDest.name;             // "Jane Doe"
    
    // Correct the in-memory registry — overwrite "Outbound Call" with real name
    registry.members[memberId].displayName = contactByDest.name;
    registry.members[memberId].callerNum   = destNum;
    
    // Check if already tracked (re-join scenario)
    const existing = await getParticipantByNumber(incidentUuid, destNum);
    if (existing && !existing.left_at) {
        // Already in the conference — skip duplicate insert
        return;
    }
    
    // Write to DB
    await insertIncidentParticipant({ incidentUuid, rawNumber: destNum, role: 'responder' });
    await upsertIncidentResponder({ contactId: contactByDest.id, status: 'JOINED' });
    
} else {
    // Step 2: Try callerNum (finds initiator)
    const contactByCaller = await lookupContactByNumber(callerNum, tenantId);
    
    if (contactByCaller) {
        const existing = await getParticipantByNumber(incidentUuid, callerNum);
        if (existing && !existing.left_at) {
            // Initiator already tracked — correct behavior, skip
            return;
        }
        // First-join for initiator (inbound leg)
        await insertIncidentParticipant({ incidentUuid, rawNumber: callerNum, role: 'initiator' });
    }
}
```

### Why `destNum` Is Used First

When an outbound leg connects to `user/1001` and the responder answers:
- `Caller-Destination-Number` = `1001` (the extension FreeSWITCH dialled)
- `1001` is the responder's extension, which exists in `emergency_contacts`

For the initiator's own **inbound** leg joining the conference:
- `Caller-Destination-Number` = the ERS emergency number (e.g., `5911`)
- `5911` is NOT in `emergency_contacts` (it's in `emergency_numbers`)
- Lookup by destNum fails → falls back to callerNum lookup → finds initiator

This asymmetry is what allows a single code path to correctly handle both inbound (initiator) and outbound (responder) legs.

### Registry Correction

The `add-member` event fires before FreeSWITCH populates full participant detail. The initial `parseMemberFlags()` call on raw event flags may set `displayName = "Outbound Call"`. The `trackParticipant` correction sets `registry.members[memberId].displayName = contactByDest.name` so the monitoring UI shows the responder's real name immediately.

---

## Incident States

| Status | Description |
|---|---|
| `ACTIVE` | Conference is running; ring loop may still be active |
| `QUEUED` | Overflow — caller is waiting for a slot to become available |
| `COMPLETED` | Incident ended normally (all parties left or manually completed) |
| `FAILED` | Error occurred during incident creation |
| `CANCELLED` | Manually cancelled by an administrator |

---

## Incident Completion

### Normal Completion

```http
POST /internal/ers/incidents/:uuid/complete
X-Internal-Key: <INTERNAL_API_KEY>
```

**Actions:**

1. `UPDATE ers_incidents SET status='COMPLETED', ended_at=now()`
2. `UPDATE ers_incident_responders SET status='MISSED' WHERE status='INVITED'`
   — Marks all responders who were invited but never joined as MISSED
3. Emit `enrs::ers_incident_ended` Socket.IO event
4. If recording is ACTIVE: trigger `closeRecording(room)`

### Conference-Destroy Fallback

When FreeSWITCH destroys the conference room (all participants left), an ESL `conference-destroy` event fires. The ESL handler calls `reconcileOrphanedIncident(room)` which:

- Finds any `ACTIVE` incident associated with that room
- Calls the completion sequence above as a safety net
- Prevents incidents from remaining `ACTIVE` indefinitely after FreeSWITCH-side closure

---

## Rejoin Flow

Allows a caller who accidentally disconnected to re-enter an active conference.

### Prerequisites

- `ers_configurations.allow_rejoin = true`
- A `rejoin_number` is configured and bound in `emergency_numbers` with type `REJOIN`

### Flow

```
1. Caller hangs up accidentally
2. Caller calls rejoin_number (e.g., 5912)
          │
          ▼
3. Lua: GET /internal/ers/incidents/rejoin
        ?rejoin_number=5912&caller=+15551234567
   Response:
   {
     "authorized": true,
     "incident_uuid": "uuid",
     "conference_room": "ers_1_p1",
     "role": "initiator"
   }
          │
          ▼
4. Lua bridges caller back to conference_room
5. ESL: del-member event (if old leg still present) → clean up old entry
6. ESL: add-member event → trackParticipant handles rejoin:
        - existing row found with left_at IS NOT NULL → UPDATE left_at=NULL
        - or: existing row with left_at IS NULL → skip (already tracked)
```

---

## Open Access Flow

Allows observers (management, compliance, external parties) to join a conference without triggering a ring-all.

### Prerequisites

- `open_access_number` configured and bound with type `OPEN_ACCESS`

### Flow

```http
GET /internal/ers/incidents/open-join?number=<open_access_number>
```

**Response:**

```json
{
  "incident_uuid": "uuid",
  "conference_room": "ers_1_p1"
}
```

Lua bridges the caller to the conference. The system logs their join:

```http
POST /internal/ers/incidents/:uuid/observer
{
  "caller_number": "+15559876543",
  "joined_at": "2026-07-20T14:32:10Z"
}
```

Observers appear in `ers_incident_participants` with `role = 'observer'`. They are not included in responder reports.

---

## Overflow Queue

### Enqueue

```http
POST /internal/ers/overflow/enqueue
X-Internal-Key: <INTERNAL_API_KEY>
Content-Type: application/json

{
  "configuration_id": "uuid",
  "caller_number": "+15551234567",
  "destination_number": "5911"
}
```

**Response:**

```json
{
  "queue_id": "uuid",
  "position": 2,
  "estimated_wait_sec": 120
}
```

### Poll for Ready State

Lua polls every 3 seconds:

```http
GET /internal/ers/overflow/poll?queue_id=<id>
```

**Response (still waiting):**

```json
{ "ready": false, "position": 2 }
```

**Response (slot available):**

```json
{
  "ready": true,
  "conference_room": "ers_1_p1",
  "incident_uuid": "uuid"
}
```

When Lua receives `ready: true`, it proceeds to `POST /internal/ers/ring-all` and bridges the caller to the assigned room.

### Queue Cleanup

A background job runs every 60 seconds:

```sql
UPDATE ers_queues
SET status = 'EXPIRED', expired_at = now()
WHERE status = 'QUEUED'
  AND created_at < now() - interval '2 hours'
  AND deleted_at IS NULL;
```

---

## Reporting

### ERS Incident List

```http
GET /api/v1/reports/ers
Authorization: Bearer <token>

Query Parameters:
  configuration_id   UUID
  status             ACTIVE | COMPLETED | FAILED | CANCELLED
  from               ISO8601
  to                 ISO8601
  limit              integer (default 20, max 1000)
```

**Response fields:**

| Field | Description |
|---|---|
| `incident_uuid` | Unique incident identifier |
| `conference_room` | FreeSWITCH conference room name |
| `participant_count` | Total parties who joined (initiator + responders + observers) |
| `responder_count` | Responders who answered (JOINED status) |
| `answered_count` | Alias for `responder_count` |
| `missed_count` | Responders invited but never answered |
| `duration_sec` | Conference duration in seconds |
| `started_at` / `ended_at` | Incident timing |
| `recording_path` | Path to recording file if recorded |

### ERS Incident Detail

```http
GET /api/v1/reports/ers/:incidentUuid
Authorization: Bearer <token>
```

Returns full incident detail including:

- Incident metadata (room, config, timing, status)
- All `ers_incident_participants` rows (initiator, responders, observers)
- All `ers_incident_responders` rows with individual status

**Responder statuses in report:**

| Status | Meaning |
|---|---|
| `INVITED` | Ring-all fired for this responder; outcome unknown |
| `JOINED` | Responder answered and joined the conference |
| `MISSED` | Responder did not answer before incident completed |
| `DECLINED` | Responder rejected the call (retryable or not) |

---

## Complete End-to-End Example

**Scenario:** Fire emergency in Building A

### Configuration

```
ERS Configuration: "Building A Security"
  emergency_number:           5911
  rejoin_number:              5912
  open_access_number:         5913
  max_concurrent_conferences: 2
  conference_profile:         default
  ring_timeout_seconds:       NULL  (ring indefinitely up to 2h)
  record_conferences:         true
  recording_mode:             AUTO
  allow_rejoin:               true
  queue_enabled:              true
```

**Primary tier:** 8 responders (5 direct + 3 via "Fire Safety" group)

### Execution

```
Step 1:  Building security calls 5911
         Lua: GET /internal/ers/lookup?number=5911
              → config, tier contacts (8 responders resolved)
              → slot available: ers_1_p1

Step 2:  Lua: POST /internal/ers/ring-all
              { configuration_id: "1", tier: "primary", caller_number: "+15551000001" }
         Response: { incident_uuid: "inc-uuid", conference_room: "ers_1_p1", responder_count: 8 }

Step 3:  FreeSWITCH bridges security caller into ers_1_p1
         ESL add-member: Caller-Caller-ID-Number=+15551000001 (security)
                         Caller-Destination-Number=5911 (ERS number — not in contacts)
         trackParticipant: destNum=5911 → no contact → fallback callerNum=+15551000001
                           → initiator participant row inserted

Step 4:  erlRingService fires 8 bgapi originate commands simultaneously:
         For each responder extension (e.g., 1001, 1002 ... 1008):
           bgapi originate {origination_caller_id_number=+15551000001}
                           {origination_caller_id_name=Security-5911}
                           user/100N &conference(ers_1_p1@default)

Step 5:  ESL add-member events (wave 1, LEG_TIMEOUT_S=25s):
         - Extension 1001 answers:
             Caller-Caller-ID-Number = +15551000001 (initiator)
             Caller-Destination-Number = 1001 (responder's extension)
             trackParticipant: destNum=1001 → contact found: "Alice (Fire Warden)"
             → INSERT ers_incident_participants (role=responder, raw_number=1001)
             → UPSERT ers_incident_responders: INVITED → JOINED
             → registry member displayName corrected: "Alice (Fire Warden)"
         - Extensions 1003, 1005 answer similarly
         - Extensions 1002, 1004, 1006, 1007, 1008: NO_ANSWER (LEG_TIMEOUT_S reached)

Step 6:  member_count = 4 (initiator + 3 responders) → ring loop stops
         Recording starts: AUTO mode
         recordingPath = /var/lib/freeswitch/recordings/ers/1/inc-uuid_20260720-143022.wav

Step 7:  Conference in progress — 4 parties coordinating fire response
         Monitoring UI shows: 4 members, live updates via Socket.IO

Step 8:  After 15 minutes, incident coordinator calls:
         POST /internal/ers/incidents/inc-uuid/complete
         → status=COMPLETED, ended_at=now()
         → 5 INVITED responders marked MISSED
         → recording closeRecording() → status=COMPLETED

Step 9:  ESL conference-destroy fires (confirms closure)
         reconcileOrphanedIncident → incident already COMPLETED → no-op
```

### Report Output

```http
GET /api/v1/reports/ers/inc-uuid
```

```json
{
  "incident_uuid": "inc-uuid",
  "conference_room": "ers_1_p1",
  "configuration_name": "Building A Security",
  "status": "COMPLETED",
  "participant_count": 4,
  "responder_count": 3,
  "answered_count": 3,
  "missed_count": 5,
  "duration_sec": 907,
  "started_at": "2026-07-20T14:30:22Z",
  "ended_at": "2026-07-20T14:45:29Z",
  "recording_path": "/var/lib/freeswitch/recordings/ers/1/inc-uuid_20260720-143022.wav",
  "participants": [
    { "raw_number": "+15551000001", "role": "initiator", "joined_at": "2026-07-20T14:30:22Z" },
    { "raw_number": "1001", "role": "responder", "display_name": "Alice (Fire Warden)", "joined_at": "2026-07-20T14:30:31Z" },
    { "raw_number": "1003", "role": "responder", "display_name": "Bob (Fire Safety)", "joined_at": "2026-07-20T14:30:34Z" },
    { "raw_number": "1005", "role": "responder", "display_name": "Carol (Evacuation Lead)", "joined_at": "2026-07-20T14:30:38Z" }
  ],
  "responders": [
    { "contact_name": "Alice (Fire Warden)",    "mobile_number": "1001", "status": "JOINED" },
    { "contact_name": "Bob (Fire Safety)",       "mobile_number": "1003", "status": "JOINED" },
    { "contact_name": "Carol (Evacuation Lead)", "mobile_number": "1005", "status": "JOINED" },
    { "contact_name": "David (Backup)",          "mobile_number": "1002", "status": "MISSED" },
    { "contact_name": "Eve (Security Lead)",     "mobile_number": "1004", "status": "MISSED" }
  ]
}
```

---

*See also: [14-recording-guide.md](14-recording-guide.md), [15-ens-guide.md](15-ens-guide.md), [17-conference-guide.md](17-conference-guide.md)*
