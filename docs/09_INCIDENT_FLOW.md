# 09 — Incident Flow Diagrams

## ERS (Emergency Response) Incident Lifecycle

### 1. Standard STATIC Conference — Primary Tier

```
PSTN/SIP call → destination_number = "1222" (or any ERS number)
  │
  ▼
FreeSWITCH dialplan matches → launches dial_911_conference.lua
  │
  │ GET /internal/ers/lookup?number=1222
  │   ← { conference_type: "STATIC", primary_bridge_number: "3010",
  │         conference_profile: "default", responders: [...],
  │         slot: 1, can_accept: true, recording_enabled: false }
  │
  │ (DYNAMIC mode: generates room name ers1_p_0e3f2a1 instead)
  │
  ▼
Lua: session:execute("conference", "3010@default")
  │
  │ [caller enters conference]
  │
  ▼
FreeSWITCH ESL event: conference-create + add-member
  │
  ├─► eslService.js updates in-memory registry
  ├─► Socket.IO emit → "conference.created" → Dashboard
  └─► conferenceManager.handleConferenceCreated() [if recording_enabled]
        └─► AUTO recording: conference 3010 record /path/ers_3010.wav

  │ Lua (concurrently, after conference join):
  │
  │ POST /internal/ers/incidents
  │   body: { configuration_id:1, caller_number:"7001003",
  │            conference_room:"3010", group_type:"primary", status:"ACTIVE" }
  │   ← { incident_uuid: "abc-123", incident_id: 42 }
  │
  ├─► DB: INSERT ers_incidents
  └─► Socket.IO emit → "enrs::ers_incident_created" → Dashboard (incident panel opens)

  │
  │ POST /internal/ers/ring-all
  │   body: { configuration_id:1, caller_number:"7001003", tier:"primary" }
  │
  ▼
ersInternalController.ersRingAll()
  └─► startRingAll({ incidentId:42, room:"3010", conferenceProfile:"default", ... })
        [background loop — non-blocking]
        │
        │ Wave 1: for each responder in primary tier:
        │   bgapi originate {vars}sofia/gateway/trunk/60123456789 &conference(3010@default)
        │
        │ Wait 28s (LEG_TIMEOUT_S=25 + 3s settle)
        │
        │ Check getConferenceMemberCount("3010")
        │   > 1 → responder answered → stop ringing
        │   = 0 → caller left → abort
        │   = 1 → nobody answered → Wave 2

  │ Responder dials in (answers originate):
  │
  ▼
FreeSWITCH ESL: add-member (memberId=2, callerNum="60123456789")
  ├─► registry: conf["3010"].members.size = 2
  ├─► Socket.IO: "conference.member.added"
  └─► conferenceManager.handleFirstParticipant() [if recording_enabled + trigger=FIRST_PARTICIPANT]

  │ Lua (after responder answers, Lua detects via tier-status poll):
  │ PATCH /internal/ers/incidents/abc-123/responder
  │   body: { responder_number:"60123456789", status:"ANSWERED" }
  │
  └─► Socket.IO emit → "enrs::ers_responder_update"

  [Conference ongoing — OPERATOR can: mute, kick, record, play audio via Monitoring page]

  │ Caller hangs up:
  │
  ▼
Lua (on session end): POST /internal/ers/incidents/abc-123/complete
  body: { recording_file: "/path/ers_3010_2026-07-17.wav" }
  │
  ├─► DB: UPDATE ers_incidents SET status='COMPLETED', ended_at=NOW()
  └─► Socket.IO emit → "enrs::ers_incident_ended"
        [Dashboard: incident panel closes]
        [recordingController: scan + upsert into recordings table]
```

---

### 2. Queue Path — All Slots Occupied

```
Caller dials 1222 → Lua gets ERS config
  │
  │ GET /internal/ers/lookup?number=1222
  │   ← { can_accept: false, slot: 3 }  (both primary + secondary occupied)
  │
  ▼
Lua: session:execute("conference", "3010@default")
  │
  │ POST /internal/ers/overflow/enqueue
  │   body: { configuration_id:1, caller_number:"7001010" }
  │   ← { queue_id: "q-uuid-1", position: 1, status: "WAITING" }
  │
  └─► DB: INSERT ers_queue
      Socket.IO: "enrs::ers_queue_changed"

  Lua hold loop (every 3s):
    GET /internal/ers/overflow/poll?queue_id=q-uuid-1
      ← { status: "WAITING" }   (loop continues)
      ← { status: "ACTIVE", conference_room: "3010" }  (incident ended, queue promoted)

  On ACTIVE:
    Lua: session:execute("conference", "3010@default")
    [repeat normal flow from conference join]

  Or caller hangs up during queue:
    POST /internal/ers/overflow/cancel { queue_id: "q-uuid-1" }
    Socket.IO: "enrs::ers_queue_changed"
```

---

### 3. Rejoin Path — Responder Reconnects

```
Responder lost connectivity → dials "3010" again (STATIC mode)
  │
  │ GET /internal/ers/incidents/rejoin?configuration_id=1&caller_number=60123456789
  │   ← { can_rejoin: true, conference_room: "3010", incident_uuid: "abc-123" }
  │
  ▼
Lua: session:execute("conference", "3010@default")
  │
  └─► Responder re-enters same conference bridge — incident continues uninterrupted
```

This is the core reason STATIC mode exists. The conference name `3010` never changes during the emergency — responders always know the number to dial.

---

## ENS (Emergency Notification) Campaign Lifecycle

### Broadcast Initiation via Lua

```
Caller dials ENS number (e.g. "1333")
  │
  ▼
FreeSWITCH → blast_call.lua
  │
  │ GET /internal/ens/lookup?number=1333
  │   ← { configuration_id:2, pin_required:true, no_pending_msg:"...", ... }
  │
  │ [If pin_required]:
  │ session:execute("play_and_get_digits", "...enter pin...")
  │
  │ POST /internal/ens/verify-pin
  │   body: { configuration_id:2, pin:"1234" }
  │   ← { valid: true }
  │
  │ [Caller records message]:
  │ session:execute("record", "/var/lib/freeswitch/recordings/ens/msg.wav")
  │
  ▼
POST /internal/ens/campaign/start
  body: { configuration_id:2, recording_file:"/path/msg.wav", caller_number:"7001001" }
  │
  ├─► DB: INSERT ens_campaigns (status=PENDING)
  ├─► DB: INSERT ens_campaign_destinations (one per contact in config)
  └─► Socket.IO: "enrs::ens_started"
```

### Campaign Engine Delivery

```
campaignEngine.js tick (every 1s):
  │
  │ PostgreSQL advisory lock (prevents duplicate worker in PM2 cluster)
  │
  │ SELECT pending destinations WHERE status='PENDING' LIMIT <concurrency>
  │
  │ For each destination:
  │   UPDATE status='CALLING'
  │   bgapi originate {sip_h_X-Campaign-ID=7,sip_h_X-Destination-ID=42}
  │              sofia/gateway/trunk/60198765432 &lua(blast_call.lua)
  │
  │ ESL: CHANNEL_ANSWER event
  │   ← campaign destination ID from SIP header
  │   UPDATE ens_campaign_destinations SET status='DELIVERED', answered_at=NOW()
  │   Socket.IO: "enrs::ens_delivery" { status: "DELIVERED" }
  │
  │ ESL: CHANNEL_HANGUP event (no answer / busy)
  │   ← hangup_cause
  │   if cause in RETRYABLE_CAUSES and attempt_count < max_retries:
  │     UPDATE status='PENDING', attempt_count+1, schedule retry
  │   else:
  │     UPDATE status='FAILED'
  │     Socket.IO: "enrs::ens_delivery" { status: "FAILED" }
  │
  │ When all destinations resolved:
  │   UPDATE ens_campaigns SET status='COMPLETED'
  │   Socket.IO: "enrs::ens_complete"
```

### Retry Playback (Missed Caller Dials Back)

```
Contact missed the call → dials "1333" back
  │
  ▼
FreeSWITCH → ENS_retry_playback.lua
  │
  │ GET /internal/ens/lookup?number=1333
  │ GET /internal/ens/campaigns/latest?configuration_id=2
  │   ← { recording_file: "/path/msg.wav", status: "COMPLETED" }
  │
  │ [If no active/completed campaign]:
  │ session:execute("speak", no_pending_msg)
  │
  │ [If campaign found]:
  │ session:execute("playback", "/path/msg.wav")
```

---

## IVR Call Flow

```
Caller dials IVR number (e.g. "1000")
  │
  ▼
FreeSWITCH dialplan → enrs_ivr_<flow_uuid>.lua
  │
  │ GET /internal/ivr/lookup?number=1000
  │   ← { flow_id, entry_node_id, nodes: {...} }
  │
  ▼
Lua traverses the node graph:
  │
  │ PLAYBACK node → session:execute("playback", "prompt.wav")
  │
  │ MENU node → session:execute("play_and_get_digits", ...)
  │               DTMF input → route to next node
  │
  │ ERS_BRIDGE node → session:execute("conference", "3010@default")
  │                    [same as direct ERS call from here]
  │
  │ ENS_TRIGGER node → POST /internal/ens/campaign/start
  │
  │ RECORD node → session:execute("record", path)
  │               POST /internal/ivr/cdr
  │
  │ CONDITION node → evaluate variable → branch
  │
  │ TRANSFER node → session:execute("transfer", "1001 XML default")
  │
  └─► HANGUP node → session:hangup()
```

---

## Monitoring Page — Operator View

```
Dashboard open → GET /api/v1/monitoring/conferences
  ← [{ name:"3010", members:[...] }]   (registry snapshot)

Socket.IO events update live:
  conference.created      → new conference panel appears
  conference.member.added → member row added
  conference.member.muted → mute indicator toggles
  conference.member.talking → audio activity indicator
  conference.destroyed    → panel disappears
  enrs::ers_incident_created → incident detail appears alongside conference

Operator actions:
  Mute member:    POST /monitoring/conferences/3010/members/1/mute
  Kick member:    DELETE /monitoring/conferences/3010/members/1
  Lock:           POST /monitoring/conferences/3010/lock
  Start record:   POST /monitoring/conferences/3010/record/start
  Play file:      POST /monitoring/conferences/3010/play
  End conference: DELETE /monitoring/conferences/3010
```

---

## State Transition Tables

### ERS Incident Status

| From | Event | To |
|---|---|---|
| *(new)* | Caller joins conference | `ACTIVE` |
| *(new)* | All slots occupied | `QUEUED` |
| `QUEUED` | Slot freed, caller dequeued | `ACTIVE` |
| `QUEUED` | Caller hangs up | `CANCELLED` |
| `ACTIVE` | Caller hangs up (`/complete`) | `COMPLETED` |
| `ACTIVE` | Supervisor cancels | `CANCELLED` |

### ENS Campaign Status

| From | Event | To |
|---|---|---|
| *(new)* | `POST /internal/ens/campaign/start` | `PENDING` |
| `PENDING` | Engine picks up first batch | `RUNNING` |
| `RUNNING` | `POST /campaigns/:id/pause` | `PAUSED` |
| `PAUSED` | `POST /campaigns/:id/resume` | `RUNNING` |
| `RUNNING` | All destinations resolved | `COMPLETED` |
| `RUNNING`/`PAUSED` | `POST /campaigns/:id/cancel` | `CANCELLED` |

### ERS Queue Entry Status

| From | Event | To |
|---|---|---|
| *(new)* | `/overflow/enqueue` | `WAITING` |
| `WAITING` | Slot freed, `/overflow/poll` returns ACTIVE | `DEQUEUED` |
| `WAITING` | Caller hangs up (`/overflow/cancel`) | `CANCELLED` |
