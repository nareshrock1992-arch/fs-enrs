# ESL Event Processing

## Overview

All ESL events are dispatched through `handleEvent(evt)` in `backend/src/services/eslService.js`. The function reads FreeSWITCH event headers, updates the in-memory conference registry, writes to the database where required, and emits Socket.IO events to connected browser clients.

The in-memory conference registry (`conferenceRegistry`, a module-level `Map`) is the single source of truth for live conference state. The monitoring REST API reads from this map directly — no database query is involved for real-time conference data.

---

## `CUSTOM conference::maintenance` Events

These are the most important ESL events in the system. FreeSWITCH emits them for every state change in a conference room or its members. The `Action` header identifies the specific event.

### Common Headers Read for All `conference::maintenance` Events

| ESL Header | Variable | Purpose |
|---|---|---|
| `Action` | `action` | Event subtype (see below) |
| `Conference-Name` | `confName` | Conference room name |
| `Member-ID` | `memberId` | Integer member identifier |
| `Caller-Caller-ID-Number` | `callerNum` | Presented CallerID number |
| `Caller-Caller-ID-Name` | `callerName` | Presented CallerID name |
| `Caller-Unique-ID` | `channelUuid` | FreeSWITCH channel UUID (internal only) |
| `Caller-Destination-Number` | `destNum` | The number the originate targeted |

---

### `conference-create`

Fired when FreeSWITCH creates a new conference room.

**Registry change:** `registryGetOrCreate(confName)` — inserts a new entry with default values.

**DB writes:** None directly. `conferenceManager.handleConferenceCreated(confName)` is dynamically imported and called asynchronously — it may write to `ers_incidents` depending on the room name pattern.

**Socket event emitted:** `conference.created { confName }`

---

### `conference-destroy`

Fired when the last member leaves and FreeSWITCH destroys the room.

**Registry change:** `conferenceRegistry.delete(confName)`. Before deletion, if the conference had an active recording, `closeRecording()` is called to finalise the recording DB row.

**DB writes:** `reconcileOrphanedIncident(confName)` is called. This queries `ers_incidents WHERE conference_room = $1 AND status = 'ACTIVE'` and calls `completeIncidentCore(incident_uuid)` for any found rows. This is the authoritative "room is empty" signal — stronger than any per-leg completion call.

**Socket event emitted:** `conference.ended { confName }` — emitted **after** the DB reconcile, not before, so that any REST reseed triggered by the socket event observes the updated DB state.

---

### `add-member`

Fired when a new participant joins the conference.

**Additional headers read:**
- `Conference-Member-Flags`: pipe-delimited flags string (e.g., `hear|speak|moderator`)

**Registry change:** Creates a `MemberRecord` in `conf.members` with parsed flag state. Sets `joinedAt` to `new Date().toISOString()`. Stores `channelUuid` in `_uuid` (internal only). On the first member (`memberCount === 1`), calls `conferenceManager.handleFirstParticipant()`.

**Post-join sync:** 600 ms after join, `syncConferenceFromXml(confName)` is called to correct the initial muted/deaf state. The text-flag parser used at join time (`parseMemberFlags`) infers muted from the absence of `speak` in the flags string, which is unreliable on some FreeSWITCH versions.

**DB writes:** Via `trackParticipant(confName, callerNum, destNum, 'join', memberId)` — see the `trackParticipant` section below.

**Audit log:** `persistEvent('conference.member.joined', { confName, member: memberId, callerNum })` inserts a row in `audit_logs`.

**Socket events emitted:**
- `conference.member.joined { confName, member: memberId, callerNum, callerName, memberData }`

`memberData` is the complete `MemberRecord` object.

---

### `del-member`

Fired when a participant leaves the conference.

**Registry change:** `conf.members.delete(memberId)`.

**DB writes:** Via `trackParticipant(confName, callerNum, destNum, 'leave', null)`.

**Socket event emitted:** `conference.member.left { confName, member: memberId, callerNum }`

---

### `mute-member`

**Registry change:** `member.muted = true`

**Socket event emitted:** `conference.member.muted { confName, member: memberId, callerNum, muted: true }`

---

### `unmute-member`

**Registry change:** `member.muted = false`

**Socket event emitted:** `conference.member.muted { confName, member: memberId, callerNum, muted: false }`

---

### `deaf-member`

**Registry change:** `member.deaf = true`

**Socket event emitted:** `conference.member.deaf { confName, member: memberId, deaf: true }`

---

### `undeaf-member`

**Registry change:** `member.deaf = false`

**Socket event emitted:** `conference.member.deaf { confName, member: memberId, deaf: false }`

---

### `start-talking`

Fired by FreeSWITCH's voice activity detection when a member's energy exceeds the threshold.

**Registry change:** `member.talking = true`

**Socket event emitted:** `conference.member.talking { confName, member: memberId, callerNum, talking: true }`

**Note:** This is the only source of `talking` state. `syncConferenceFromXml()` deliberately does NOT update `talking` because an `xml_list` snapshot almost always shows `talking=false` (point-in-time, not event-driven) and would overwrite the correct event state.

---

### `stop-talking`

**Registry change:** `member.talking = false`

**Socket event emitted:** `conference.member.talking { confName, member: memberId, callerNum, talking: false }`

---

### `floor-change`

Fired when the conference floor (speaking priority) changes.

**Additional headers read:**
- `New-ID`: the member ID of the new floor holder

**Registry change:** `conf.floorHolder = newFloor`. For every member, sets `member.floor = (mid === newFloor)`.

**Socket event emitted:** `conference.floor.changed { confName, member: newFloor }`

---

### `lock`

**Registry change:** `conf.locked = true`

**Socket event emitted:** `conference.locked { confName, locked: true }`

---

### `unlock`

**Registry change:** `conf.locked = false`

**Socket event emitted:** `conference.locked { confName, locked: false }`

---

### `start-recording`

Fired by FreeSWITCH when it successfully opens a recording file.

**Additional headers read (accepts any of these across FS versions):**
- `Path`
- `Recording-File`
- `Recording-Path`

**Registry change:** `conf.recording = true`, `conf.recordingState = 'ACTIVE'`, `conf.recordingError = null`. Updates `conf.recordingPath` with the confirmed path. Clears the 5-second STARTING timeout that was set by `setConferenceRecordingStarting()`.

**DB writes:**
1. `upsertRecordingStart({ type, confName, recPath, createdBy: 'system' })` — creates or updates a recording row. Type is inferred from path: `/ers/` → `ERS`, `/ens/` → `ENS`, `/ivr/` → `IVR`, `/manual/` → `MANUAL`.
2. If type is `ERS`: `UPDATE ers_incidents SET recording_path = $1 WHERE conference_room = $2 AND status = 'ACTIVE'` — syncs the recording path onto the incident row for direct access in reports without a JOIN on `recordings`.

**Socket event emitted:** `conference.recording { confName, recording: true, recordingState: 'ACTIVE', recordingPath, recordingError: null }`

---

### `stop-recording`

Fired by FreeSWITCH when recording stops.

**Additional headers read:** Same as `start-recording`.

**Registry change:** `conf.recording = false`, `conf.recordingState = 'OFF'`. Keeps `conf.recordingPath` so the UI can display "last recording was X".

**DB writes:** `closeRecording({ confName, recPath })` — extracts file metadata, calculates duration, and closes the recording row.

**Socket event emitted:** `conference.recording { confName, recording: false, recordingState: 'OFF', recordingPath }`

---

### `energy-level`

Fired when the energy threshold for a member changes.

**Additional headers read:**
- `Conference-Energy-Level`

**Registry change:** `member.energy = energyVal`

**Socket event emitted:** `conference.member.energy { confName, member: memberId, callerNum, energy: energyVal }`

---

### `moderator`

Fired by `conference <room> moderator <id>` — toggles the moderator role.

**Registry change:** `member.moderator = !member.moderator` (toggle).

**Socket event emitted:** `conference.member.moderator { confName, member: memberId, callerNum, moderator: <new value> }`

---

## `CHANNEL_HANGUP`

**Headers read:**
- `Unique-ID` → `uuid`
- `Hangup-Cause` → `cause`
- `Caller-Caller-ID-Number` → `callerNum`

**Socket event emitted:** `channel.hangup { uuid, cause, callerNum }`

**Internal event emitted:** `eslEvents.emit('CHANNEL_HANGUP', { uuid, cause, callerNum })` — the campaign engine subscribes here to update delivery status.

Common `cause` values the campaign engine treats as retryable: `BUSY`, `USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED`, `NORMAL_CIRCUIT_CONGESTION`, `SWITCH_CONGESTION`.

---

## `CHANNEL_ANSWER`

**Headers read:**
- `Unique-ID` → `uuid`
- `Caller-Caller-ID-Number` → `callerNum`

**Socket event emitted:** `channel.answer { uuid, callerNum }`

**Internal event emitted:** `eslEvents.emit('CHANNEL_ANSWER', { uuid, callerNum })` — campaign engine marks the delivery as ANSWERED.

---

## `CHANNEL_CREATE`

Fired when a new call leg is established (before answer).

**Headers read:**
- `Unique-ID` → `uuid`
- `Caller-Caller-ID-Number` → `callerNum`
- `Caller-Destination-Number` → `destNum`

**Socket event emitted:** `channel.create { uuid, callerNum, destNum }`

**Internal event emitted:** `eslEvents.emit('CHANNEL_CREATE', { uuid, callerNum, destNum })`

---

## `CHANNEL_BRIDGE`

Fired when two call legs are bridged together.

**Headers read:**
- `Unique-ID` → `uuid`
- `Bridge-B-Unique-ID` → `bridgeUuid`
- `Caller-Caller-ID-Number` → `callerNum`

**Socket event emitted:** `channel.bridge { uuid, bridgeUuid, callerNum }`

**Internal event emitted:** `eslEvents.emit('CHANNEL_BRIDGE', { uuid, bridgeUuid, callerNum })`

---

## `DTMF`

Fired when a DTMF digit is pressed.

**Headers read:**
- `Unique-ID` → `uuid`
- `DTMF-Digit` → `digit`
- `DTMF-Duration` → `duration`

**Socket event emitted:** `channel.dtmf { uuid, digit, duration }`

**Internal event emitted:** `eslEvents.emit('DTMF', { uuid, digit, duration })`

---

## `RECORD_STOP`

Fired by FreeSWITCH for any call recording that ends — both Lua `record_session` recordings and conference recordings.

**Headers read:**
- `Record-File-Path` or `variable_record_file_path` → `recPath`
- `variable_conference_name` or `Conference-Name` → `confName`

**DB writes:**
1. `upsertRecordingStart(...)` — inserts with ON CONFLICT DO NOTHING (safe for conference recordings where `start-recording` already inserted the row).
2. `closeRecording(...)` — extracts file metadata and closes the row.

For Lua `record_session` recordings, no `start-recording` conference event fires, so `RECORD_STOP` is the only DB write opportunity. For ESL conference recordings, `upsertRecordingStart` was already called from `start-recording` and `RECORD_STOP` triggers only `closeRecording`.

---

## `trackParticipant` Algorithm

This is the most complex database logic in the ESL event handler. It is called from both `add-member` (event = `'join'`) and `del-member` (event = `'leave'`).

### Purpose

Maintains audit records in two tables:
- `ers_incident_participants`: one row per person per incident, with `joined_at`, `left_at`, `rejoined_at`.
- `ers_incident_responders`: tracks invitation and join status for responders per incident.

### Phase 1 — Resolve from `destNum` (Caller-Destination-Number)

For ring-all originated legs, FreeSWITCH sets `Caller-Caller-ID-Number` to the **initiator's** number (via `origination_caller_id_number`). The responder's actual extension is in `Caller-Destination-Number`.

```sql
SELECT id, first_name, last_name FROM emergency_contacts
WHERE deleted_at IS NULL
  AND (extension_number = $1
       OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
LIMIT 1
```

Parameters: `($1 = destNum, $2 = last9DigitsOfDestNum)`

If a contact is found via `destNum`:
- `contact = destContact`
- `trackingNum = destNum`
- **Registry correction**: the in-memory `MemberRecord` is updated: `callerNum`, `callerName`, `displayName`, and `extension` are all set to the resolved responder's data. This ensures the monitoring UI shows the responder's name instead of "Outbound Call" or the initiator's CallerID.

### Phase 2 — Fallback to `callerNum` (Caller-Caller-ID-Number)

If Phase 1 did not resolve a contact (e.g., for the initiator's own inbound join where `destNum` is the ERS service number in `emergency_numbers`, not in `emergency_contacts`):

```sql
SELECT id, first_name, last_name FROM emergency_contacts
WHERE deleted_at IS NULL
  AND (extension_number = $1
       OR RIGHT(REGEXP_REPLACE(mobile_number, '[^0-9]', '', 'g'), 9) = $2)
LIMIT 1
```

Parameters: `($1 = callerNum, $2 = last9DigitsOfCallerNum)`

If no contact is found via either phase, `trackingNum` remains `callerNum` (or the function returns early if both are empty).

### Join Logic

After resolving `contact` and `trackingNum`:

```sql
SELECT id, left_at, role FROM ers_incident_participants
WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3)
ORDER BY joined_at DESC LIMIT 1
```

**Scenario A — Existing participant row with `left_at` set (rejoin):**

```sql
UPDATE ers_incident_participants
SET rejoined_at = now(), left_at = NULL WHERE id = $1
```

```sql
UPDATE ers_incident_responders
SET status = 'REJOINED', rejoin_count = rejoin_count + 1, join_time = now()
WHERE ers_incident_id = $1 AND mobile_number = $2
```

**Scenario B — No existing row (first join):**

```sql
INSERT INTO ers_incident_participants
  (incident_id, contact_id, raw_number, role, joined_at)
VALUES ($1, $2, $3, 'responder', now())
```

```sql
INSERT INTO ers_incident_responders
  (ers_incident_id, emergency_contact_id, mobile_number, status, join_time)
VALUES ($1, $2, $3, 'JOINED', now())
ON CONFLICT (ers_incident_id, mobile_number) DO UPDATE SET
  status = CASE WHEN ers_incident_responders.status = 'INVITED'
                THEN 'JOINED'
                ELSE ers_incident_responders.status END,
  join_time = COALESCE(ers_incident_responders.join_time, now()),
  emergency_contact_id = EXCLUDED.emergency_contact_id
```

**Scenario C — Existing row with `left_at = NULL` (duplicate join event):** No action taken.

### Leave Logic

```sql
UPDATE ers_incident_participants
SET left_at = now()
WHERE incident_id = $1 AND (raw_number = $2 OR contact_id = $3) AND left_at IS NULL
```

```sql
UPDATE ers_incident_responders
SET leave_time = now()
WHERE ers_incident_id = $1 AND mobile_number = $2 AND leave_time IS NULL
```

### Error Handling

`trackParticipant` wraps everything in a try/catch. Any database failure logs an error but never propagates. Live call event handling must never be broken by audit tracking failures.

---

## Conference Registry — Background Reconciliation

### 30-Second Heartbeat + Seed

Every 30 seconds, `seedConferenceRegistry()` runs. It uses a two-step process:

1. `bgapi conference list` — text output, parsed for conference **names only** (one round-trip).
2. For each conference name: `bgapi conference <name> xml_list` — XML output, parsed for authoritative member state (one round-trip per conference).

The two-step approach avoids using `conference xml_list` (no room argument) which is not available on all FreeSWITCH versions. A rejected command would be misinterpreted as "no active conferences" and would wipe the entire registry.

For existing members in the registry, the seed updates only cosmetic/audio fields (`energy`, `volIn`, `volOut`, `_uuid`) and does NOT update `muted`, `deaf`, `talking`, `floor`, or `locked`. These are owned by ESL maintenance events and `syncConferenceFromXml()`. Overwriting them from a 30-second snapshot would race against and corrupt real-time event state.

Conferences in the registry that are no longer in the live list are removed. `reconcileOrphanedIncident()` is called before emitting `conference.ended` so REST reseeds triggered by the socket event see the updated DB state.

### 60-Second Active Incident Reconciliation

`reconcileAllActiveIncidents()` queries all ACTIVE `ers_incidents` rows from the past 48 hours and calls `getConferenceMemberCount(room)` for each via `bgapi conference <room> count`. If count is 0, `completeIncidentCore(incident_uuid)` is called.

This job is explicitly skipped when ESL is not connected. If run without ESL, every `getConferenceMemberCount()` call returns 0 (catches the connection error) — which would falsely complete every active incident.

### 120-Second Recording Directory Scan

`scanRecordingDirectory()` reads the recording directories and reconciles with `recordings` table rows. Heals:
- Recordings whose `stop-recording` event was missed (ESL disconnect during call).
- Files the `start-recording` event failed to insert (race condition or ESL disconnect at recording start).

The scan is idempotent — all upserts use ON CONFLICT DO NOTHING.
