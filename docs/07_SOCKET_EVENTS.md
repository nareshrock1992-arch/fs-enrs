# 07 — Socket.IO Events

## Connection

**Transport:** Socket.IO v4 (WebSocket + long-polling fallback)  
**Auth:** JWT access token passed as query param on connect:
```js
io.connect({ auth: { token: '<access_token>' } })
```
The server validates the token via `requireAuth` equivalent in `socketService.js`. Unauthenticated connections are immediately disconnected.

**Namespace:** Default (`/`)  
**Broadcast:** `emitInternal(event, data)` — broadcasts to **all** authenticated sockets (no room-based filtering, tenant filtering is done client-side or by data shape).

---

## Frontend Listener Registration

All listeners are set up in `frontend/src/api/socket.js`:

```js
import { socket } from './socket';

socket.on('event.name', (data) => { ... });
```

---

## Event Reference

### Conference Events (from ESL)

These events are emitted by `eslService.js` in response to FreeSWITCH `conference::maintenance` ESL events.

---

#### `conference.list`
**Trigger:** On socket connect, or on `GET /api/v1/monitoring/conferences`  
**Direction:** Server → Client  
**Purpose:** Full snapshot of the in-memory conference registry

```json
[
  {
    "name": "3010",
    "createdAt": "2026-07-17T10:00:00.000Z",
    "recording": false,
    "locked": false,
    "members": [
      {
        "id": "1",
        "callerNum": "7001003",
        "callerName": "John Smith",
        "muted": false,
        "talking": false,
        "floor": false,
        "role": "moderator"
      }
    ]
  }
]
```

---

#### `conference.created`
**Trigger:** FreeSWITCH ESL `conference-create` action  
**Direction:** Server → Client

```json
{ "confName": "3010" }
```

---

#### `conference.member.added`
**Trigger:** ESL `add-member` action  
**Direction:** Server → Client

```json
{
  "confName": "3010",
  "member": {
    "id": "2",
    "callerNum": "7001004",
    "callerName": "Jane Doe",
    "muted": false,
    "talking": false,
    "floor": false,
    "role": "member"
  }
}
```

---

#### `conference.member.removed`
**Trigger:** ESL `del-member` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "memberId": "2" }
```

---

#### `conference.member.muted`
**Trigger:** ESL `mute-member` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "memberId": "1", "muted": true }
```

---

#### `conference.member.talking`
**Trigger:** ESL `start-talking` / `stop-talking` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "memberId": "1", "talking": true }
```

---

#### `conference.member.floor`
**Trigger:** ESL `floor-change` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "memberId": "1", "floor": true }
```

---

#### `conference.recording`
**Trigger:** ESL `record` / `norecord` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "recording": true, "path": "/var/lib/freeswitch/recordings/ers/ers_3010_2026-07-17.wav" }
```

---

#### `conference.locked`
**Trigger:** ESL `lock` / `unlock` action  
**Direction:** Server → Client

```json
{ "confName": "3010", "locked": true }
```

---

#### `conference.destroyed`
**Trigger:** ESL `conference-destroy` action (all members left)  
**Direction:** Server → Client

```json
{ "confName": "3010" }
```

---

### ERS (Emergency Response System) Events

Emitted by `ersInternalController.js` and `ersRingService.js` via `emitInternal()`.

---

#### `enrs::ers_incident_created`
**Trigger:** `POST /internal/ers/incidents` — caller enters conference  
**Direction:** Server → Client  
**Consumers:** Monitoring page (opens incident panel), Dashboard (increment active count)

```json
{
  "incident_uuid": "abc-123",
  "incident_id": 42,
  "configuration_id": 1,
  "configuration_name": "Main Gate ERS",
  "caller_number": "7001003",
  "caller_name": "John Smith",
  "conference_room": "3010",
  "group_type": "primary",
  "status": "ACTIVE",
  "started_at": "2026-07-17T10:00:00.000Z"
}
```

---

#### `enrs::ers_incident_ended`
**Trigger:** `POST /internal/ers/incidents/:uuid/complete` — caller disconnects  
**Direction:** Server → Client

```json
{
  "incident_uuid": "abc-123",
  "status": "COMPLETED",
  "recording_file": "/var/lib/freeswitch/recordings/ers/ers_3010_2026-07-17.wav",
  "ended_at": "2026-07-17T10:15:00.000Z"
}
```

---

#### `enrs::ers_responder_update`
**Trigger:** `PATCH /internal/ers/incidents/:uuid/responder`  
**Direction:** Server → Client  
**Consumers:** Monitoring page (responder status column)

```json
{
  "incident_uuid": "abc-123",
  "responder_number": "7001004",
  "status": "ANSWERED",
  "answered_at": "2026-07-17T10:01:00.000Z"
}
```

---

#### `enrs::ers_observer_joined`
**Trigger:** `POST /internal/ers/incidents/:uuid/observer`  
**Direction:** Server → Client

```json
{ "incident_uuid": "abc-123", "observer_number": "7001005" }
```

---

#### `enrs::ers_queue_changed`
**Trigger:** Enqueue, dequeue, or cancel operations on `ers_queue`  
**Direction:** Server → Client  
**Consumers:** Monitoring page (queue column)

```json
{
  "configuration_id": 1,
  "queue_size": 2,
  "entries": [
    { "queue_id": "uuid-1", "caller_number": "7001010", "position": 1, "enqueued_at": "..." }
  ]
}
```

---

#### `enrs::ers_ring_ended`
**Trigger:** `startRingAll()` loop exits (responder answered, timeout, or room empty)  
**Direction:** Server → Client

```json
{ "incident_uuid": "abc-123", "room": "3010", "tier": "primary" }
```

---

### ENS (Emergency Notification System) Events

Emitted by `ensInternalController.js` and `campaignEngine.js`.

---

#### `enrs::ens_started`
**Trigger:** `POST /internal/ens/campaign/start`  
**Direction:** Server → Client

```json
{
  "campaign_id": 7,
  "configuration_id": 2,
  "campaign_name": "Building A Evacuation",
  "total_contacts": 45,
  "started_at": "2026-07-17T10:00:00.000Z"
}
```

---

#### `enrs::ens_delivery`
**Trigger:** `PATCH /internal/ens/notifications/:uuid/delivery` — per-contact delivery update  
**Direction:** Server → Client  
**Consumers:** Campaign progress bar, contact-level delivery table

```json
{
  "campaign_id": 7,
  "contact_id": 12,
  "status": "DELIVERED",
  "answered_at": "2026-07-17T10:01:30.000Z"
}
```

---

#### `enrs::ens_complete`
**Trigger:** `POST /internal/ens/notifications/:uuid/complete`  
**Direction:** Server → Client

```json
{
  "campaign_id": 7,
  "delivered_count": 38,
  "failed_count": 7,
  "completed_at": "2026-07-17T10:08:00.000Z"
}
```

---

#### `enrs::ens_callback`
**Trigger:** `POST /internal/ens/callbacks` — contact calls back on ENS number  
**Direction:** Server → Client

```json
{ "campaign_id": 7, "caller_number": "7001020", "callback_at": "..." }
```

---

#### `enrs::campaign_started` / `enrs::campaign_paused` / `enrs::campaign_resumed` / `enrs::campaign_cancelled`
**Trigger:** UI campaign control endpoints (`/api/v1/campaigns/:id/*`)  
**Direction:** Server → Client

```json
{ "campaign_id": 7, "status": "PAUSED" }
```

---

### Internal Events (Backend Bus — not Socket.IO)

`eslService.js` exposes an internal `eslEvents` EventEmitter. These are **not** Socket.IO events — they are Node.js internal events consumed by `campaignEngine.js`.

| Event | Payload | Consumer |
|---|---|---|
| `CHANNEL_ANSWER` | `{ uuid, callerNum }` | `campaignEngine` — marks destination DELIVERED |
| `CHANNEL_HANGUP` | `{ uuid, cause }` | `campaignEngine` — marks FAILED or schedules retry |
| `conference::maintenance` | Raw ESL body | `eslService.handleEvent()` |

---

## Connection State Management (Frontend)

`frontend/src/api/socket.js` manages reconnect:

```js
socket.on('connect', () => { /* re-subscribe to live data */ });
socket.on('disconnect', (reason) => { /* show reconnecting banner */ });
socket.on('connect_error', (err) => { /* log */ });
```

On reconnect the monitoring page re-fetches `GET /api/v1/monitoring/conferences` because events missed during disconnect are not replayed.
