# Conference Guide

**Document:** 17-conference-guide.md  
**System:** fs-enrs (FreeSWITCH Emergency Notification and Response System)  
**Audience:** System administrators, integration engineers, operations staff  

---

## Conference Architecture

### FreeSWITCH mod_conference

All conference rooms in fs-enrs are managed by FreeSWITCH's `mod_conference` module. The backend interacts with conference rooms exclusively through the ESL (Event Socket Library) TCP connection to FreeSWITCH port 8021.

**Key architectural points:**

| Aspect | Detail |
|---|---|
| Conference engine | FreeSWITCH `mod_conference` |
| ESL library | `modesl` (Node.js) |
| Connection | TCP `127.0.0.1:8021` (or `FS_HOST`:`FS_ESL_PORT` env vars) |
| Room naming (ERS) | `ers_{configuration_id}_{tier_prefix}{slot}` (e.g., `ers_1_p1`) |
| Room naming (manual) | Arbitrary string — typically conference name or UUID |
| Profile | Configurable via `ers_configurations.conference_profile` (default: `default`) |
| Max ERS slots | `max_concurrent_conferences` per configuration (default: 2) |

### In-Memory Registry

`eslService.js` maintains an in-process `Map<string, ConferenceRecord>` called `conferenceRegistry`. This is the primary source of real-time state for the monitoring UI. The registry is seeded from FreeSWITCH via `xml_list` queries and kept current by processing ESL events.

> **Important:** The registry is per-process. In PM2 cluster mode, each worker has its own registry instance. Real-time monitoring accuracy depends on all ESL events being routed to the same worker process, or Socket.IO using sticky sessions.

---

## Conference Registry

### ConferenceRecord Structure

```typescript
interface ConferenceRecord {
    name:            string;         // Conference room name (e.g., "ers_1_p1")
    createdAt:       string;         // ISO 8601 timestamp when room was created
    locked:          boolean;        // True if room is locked (no new joins permitted)
    recording:       boolean;        // True if recording is in progress
    recordingPath:   string | null;  // Absolute path to current recording file
    recordingState:  RecordingState; // 'OFF' | 'STARTING' | 'ACTIVE' | 'STOPPING' | 'FAILED'
    recordingError:  string | null;  // Error message if recordingState='FAILED'
    floorHolder:     number | null;  // memberId of current floor holder (last speaker)
    rate:            number;         // Sample rate reported by FreeSWITCH
    rawFlags:        string;         // Raw conference flags string from FreeSWITCH
    members:         Map<number, MemberRecord>;  // Keyed by FreeSWITCH member ID
}
```

### MemberRecord Structure

```typescript
interface MemberRecord {
    id:          number;   // FreeSWITCH member ID (integer, unique within the conference)
    callerNum:   string;   // Caller-ID-Number as received in ESL event (may be initiator's number for outbound legs — see note)
    callerName:  string;   // Caller-ID-Name from ESL event
    displayName: string;   // Corrected name after trackParticipant lookup (responder's actual name)
    extension:   string;   // Caller-Destination-Number from ESL (responder's actual extension)
    role:        'moderator' | 'participant';  // FreeSWITCH role
    muted:       boolean;  // True if member's microphone is muted
    deaf:        boolean;  // True if member cannot hear (deafened)
    moderator:   boolean;  // True if member has moderator privileges
    talking:     boolean;  // True if member is currently speaking (floor activity)
    floor:       boolean;  // True if member holds the audio floor
    canHear:     boolean;  // True if member receives conference audio
    canSpeak:    boolean;  // True if member's audio is mixed into the conference
    volIn:       number;   // Input volume level (-4 to 4)
    volOut:      number;   // Output volume level (-4 to 4)
    energy:      number;   // Energy threshold for VAD (0–100)
    joinedAt:    string;   // ISO 8601 timestamp of join
    _uuid:       string;   // FreeSWITCH channel UUID (Caller-Unique-ID)
}
```

> **`callerNum` vs `displayName` note:** For ERS ring-all outbound legs, `callerNum` is initially set to the initiator's number (from `origination_caller_id_number`). After `trackParticipant()` resolves the responder's identity via `Caller-Destination-Number`, `displayName` is corrected to the responder's real name and `callerNum` is updated to the responder's extension. See [16-ers-guide.md — Participant Tracking](16-ers-guide.md) for the full algorithm.

---

## ESL Conference Events (Complete Reference)

All conference events arrive as `CUSTOM` ESL events with `Event-Subclass: conference::maintenance`.

### Event Header Summary

Every `conference::maintenance` event includes these headers:

| Header | Description |
|---|---|
| `Conference-Name` | Conference room name |
| `Conference-Unique-ID` | FreeSWITCH internal conference UUID |
| `Action` | Event type (see table below) |
| `Conference-Size` | Current member count |
| `Conference-Profile-Name` | Active profile name |
| `Caller-Unique-ID` | Channel UUID of the member involved (where applicable) |
| `Caller-Caller-ID-Number` | Caller ID number of the member |
| `Caller-Caller-ID-Name` | Caller ID name of the member |
| `Caller-Destination-Number` | Dialled number / extension of the member |
| `Member-ID` | FreeSWITCH member ID (integer) |

### Action Types

| Action | Fired When | Key Headers Read |
|---|---|---|
| `add-member` | A new participant joins the conference | `Member-ID`, `Caller-Unique-ID`, `Caller-Caller-ID-Number`, `Caller-Caller-ID-Name`, `Caller-Destination-Number`, `Conference-Size` |
| `del-member` | A participant leaves the conference | `Member-ID`, `Caller-Unique-ID`, `Caller-Caller-ID-Number`, `Conference-Size` |
| `floor-change` | The audio floor holder changes | `Member-ID`, `Floor-Old-ID`, `Conference-Size` |
| `mute-member` | A member is muted | `Member-ID`, `Caller-Unique-ID` |
| `unmute-member` | A member is unmuted | `Member-ID`, `Caller-Unique-ID` |
| `deaf-member` | A member is deafened | `Member-ID`, `Caller-Unique-ID` |
| `undeaf-member` | A member is undeafened | `Member-ID`, `Caller-Unique-ID` |
| `kick-member` | A member is kicked | `Member-ID`, `Caller-Unique-ID` |
| `transfer-member` | A member is transferred | `Member-ID`, `Caller-Unique-ID` |
| `volume-in-member` | Input volume changed | `Member-ID`, `Volume-In-Level` |
| `volume-out-member` | Output volume changed | `Member-ID`, `Volume-Out-Level` |
| `energy-level-member` | Energy threshold changed | `Member-ID`, `Energy-Level` |
| `start-recording` | Recording started on the conference | `Path` (recording file path) |
| `stop-recording` | Recording stopped | `Path` |
| `conference-create` | Conference room created (first member joins) | `Conference-Name`, `Conference-Unique-ID` |
| `conference-destroy` | Conference room destroyed (last member leaves) | `Conference-Name`, `Conference-Unique-ID` |
| `lock` | Conference locked | `Conference-Name` |
| `unlock` | Conference unlocked | `Conference-Name` |
| `talk` | Member began speaking | `Member-ID` |
| `stop-talking` | Member stopped speaking | `Member-ID` |
| `play-file` | Audio file play started | `Member-ID` (if targeted), `Conference-Name` |
| `stop-file` | Audio file play stopped | `Conference-Name` |
| `say` | TTS announcement sent | `Conference-Name` |

### `add-member` Handler Detail

```javascript
// eslService.js: handler for Action=add-member

const memberId   = parseInt(event.getHeader('Member-ID'));
const callerNum  = event.getHeader('Caller-Caller-ID-Number');
const callerName = event.getHeader('Caller-Caller-ID-Name');
const destNum    = event.getHeader('Caller-Destination-Number');
const uuid       = event.getHeader('Caller-Unique-ID');
const confSize   = parseInt(event.getHeader('Conference-Size'));

// 1. Add to registry with initial (possibly inaccurate) values
conferenceRegistry.get(confName).members.set(memberId, {
    id: memberId,
    callerNum, callerName,
    displayName: callerName,   // overwritten by trackParticipant
    extension: destNum,
    muted: false, deaf: false,
    // ... defaults from parseMemberFlags()
    joinedAt: new Date().toISOString(),
    _uuid: uuid
});

// 2. Schedule XML-List sync (600ms delay to allow FreeSWITCH state to settle)
setTimeout(() => syncConferenceFromXml(confName), 600);

// 3. Async DB write via trackParticipant (ERS-specific)
if (isErsRoom(confName)) {
    await trackParticipant(confName, memberId, event.headers);
}

// 4. Emit real-time update
emitInternal('enrs::conference_member_joined', { confName, memberId, ... });
```

### `del-member` Handler Detail

```javascript
// eslService.js: handler for Action=del-member

const memberId  = parseInt(event.getHeader('Member-ID'));
const uuid      = event.getHeader('Caller-Unique-ID');
const confSize  = parseInt(event.getHeader('Conference-Size'));

// Remove from in-memory registry
conferenceRegistry.get(confName)?.members.delete(memberId);

// Update DB participant row
if (isErsRoom(confName)) {
    await updateParticipantLeft(confName, uuid);
}

// If confSize=0: last member left — conference may be destroyed next
if (confSize === 0) {
    // Emit warning — conference-destroy will follow shortly
}

emitInternal('enrs::conference_member_left', { confName, memberId, uuid });
```

### `conference-destroy` Handler Detail

```javascript
// eslService.js: handler for Action=conference-destroy

// Remove conference from registry
conferenceRegistry.delete(confName);

// ERS orphan reconciliation
if (isErsRoom(confName)) {
    await reconcileOrphanedIncident(confName);
    // ↑ Finds any ACTIVE incident for this room and marks COMPLETED
    //   Only fires if incident was not already completed via the API
}

emitInternal('enrs::conference_destroyed', { confName });
```

---

## Conference Control API (via `/monitoring`)

All conference control actions require a valid JWT (`Authorization: Bearer <token>`) and the caller's tenant must own the conference being modified.

### Conference-Level Actions

#### Lock / Unlock Conference

Prevents or allows new participants from joining.

```http
POST /api/v1/monitoring/conferences/:room/lock
POST /api/v1/monitoring/conferences/:room/unlock
Authorization: Bearer <token>
```

**ESL command issued:**
```
api conference <room> lock
api conference <room> unlock
```

#### Start Recording

```http
POST /api/v1/monitoring/conferences/:room/record/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "file_path": "/var/lib/freeswitch/recordings/manual/myroom_20260720.wav"
}
```

If `file_path` is omitted, a path is auto-generated under `/var/lib/freeswitch/recordings/manual/`.

**ESL command issued:**
```
bgapi conference <room> record <file_path>
```

Response includes the `recording_id` of the newly created `recordings` row.

#### Stop Recording

```http
POST /api/v1/monitoring/conferences/:room/record/stop
Authorization: Bearer <token>
```

**ESL command issued:**
```
bgapi conference <room> norecord <file_path>
```

#### Play Audio File

Plays an audio file to all conference participants.

```http
POST /api/v1/monitoring/conferences/:room/play
Authorization: Bearer <token>
Content-Type: application/json

{
  "audio_url": "/var/lib/freeswitch/sounds/en/us/callie/custom/alert.wav"
}
```

**ESL command issued:**
```
api conference <room> play <audio_url>
```

#### Say (TTS Announcement)

Speaks a text string to all conference participants via TTS.

```http
POST /api/v1/monitoring/conferences/:room/say
Authorization: Bearer <token>
Content-Type: application/json

{
  "text": "The incident commander has joined the call."
}
```

**ESL command issued:**
```
api conference <room> say <text>
```

#### Invite Participant

Dials out to a new destination and adds them to the conference.

```http
POST /api/v1/monitoring/conferences/:room/invite
Authorization: Bearer <token>
Content-Type: application/json

{
  "destination": "1009",
  "dialplan": "XML",
  "context": "default"
}
```

**ESL command issued:**
```
bgapi conference <room> dial {ignore_early_media=true}user/<destination> <dialplan> <context>
```

#### Terminate Conference

Kicks all members, destroying the conference.

```http
DELETE /api/v1/monitoring/conferences/:room
Authorization: Bearer <token>
```

**ESL command issued:**
```
api conference <room> kick all
```

---

## Per-Member Control

All member control endpoints follow the path pattern:

```
/api/v1/monitoring/conferences/:room/members/:memberId/<action>
```

`:memberId` is the integer FreeSWITCH member ID from the conference registry.

### Mute / Unmute

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/mute
POST /api/v1/monitoring/conferences/:room/members/:memberId/unmute
Authorization: Bearer <token>
```

**ESL commands:**
```
api conference <room> mute   <memberId>
api conference <room> unmute <memberId>
```

Registry update: `members[memberId].muted = true/false`  
Socket.IO emit: `enrs::member_muted` / `enrs::member_unmuted`

### Deaf / Undeaf

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/deaf
POST /api/v1/monitoring/conferences/:room/members/:memberId/undeaf
Authorization: Bearer <token>
```

**ESL commands:**
```
api conference <room> deaf   <memberId>
api conference <room> undeaf <memberId>
```

Registry update: `members[memberId].deaf = true/false`

### Volume Control

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/volume
Authorization: Bearer <token>
Content-Type: application/json

{
  "level": 2
}
```

Valid range: `-4` to `4` (0 = default, positive = louder, negative = quieter).

**ESL commands (both input and output are set):**
```
api conference <room> volume_in  <memberId> <level>
api conference <room> volume_out <memberId> <level>
```

### Energy Threshold

Controls voice activity detection sensitivity for a member.

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/energy
Authorization: Bearer <token>
Content-Type: application/json

{
  "level": 30
}
```

Valid range: `0` to `100` (lower = more sensitive, 0 = always active).

**ESL command:**
```
api conference <room> energy <memberId> <level>
```

### Force Floor Hold

Immediately grants the audio floor to the specified member.

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/floor
Authorization: Bearer <token>
```

**ESL command:**
```
api conference <room> floor <memberId>
```

### Transfer Member

Transfers a conference participant to a different destination, removing them from the conference.

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/transfer
Authorization: Bearer <token>
Content-Type: application/json

{
  "destination": "9001",
  "dialplan": "XML",
  "context": "default"
}
```

**ESL command:**
```
api conference <room> transfer <memberId> <destination> <dialplan> <context>
```

### Toggle Moderator

Grants or revokes moderator privileges for a member.

```http
POST /api/v1/monitoring/conferences/:room/members/:memberId/moderator
Authorization: Bearer <token>
```

Moderators in FreeSWITCH have extended control rights defined in the conference profile (e.g., can lock the conference, kick members).

**ESL command:**
```
api conference <room> moderator <memberId>
```

### Kick Member

Removes a specific member from the conference.

```http
DELETE /api/v1/monitoring/conferences/:room/members/:memberId
Authorization: Bearer <token>
```

**ESL command:**
```
api conference <room> kick <memberId>
```

---

## XML-List Sync (State Accuracy)

### Why Sync Is Necessary

The `add-member` ESL event fires before FreeSWITCH has fully initialized the member's conference state. The `parseMemberFlags()` function infers mute/deaf/talking state from raw flag strings in the event, but this inference is unreliable for the first few hundred milliseconds after joining.

### Sync Mechanism

**600ms Post-Join Sync**

After every `add-member` event, a 600ms timeout fires `syncConferenceFromXml(confName)`:

```javascript
// eslService.js
async function syncConferenceFromXml(confName) {
    // ESL command: api conference <confName> xml_list
    const xmlResponse = await eslClient.api(`conference ${confName} xml_list`);
    const members = parseConferenceXmlList(xmlResponse);
    
    for (const member of members) {
        const existing = conferenceRegistry.get(confName)?.members.get(member.id);
        if (!existing) continue;
        
        const changed = (
            existing.muted   !== member.muted   ||
            existing.deaf    !== member.deaf    ||
            existing.talking !== member.talking  ||
            existing.floor   !== member.floor
        );
        
        if (changed) {
            Object.assign(existing, {
                muted:    member.muted,
                deaf:     member.deaf,
                talking:  member.talking,
                floor:    member.floor,
                canHear:  member.canHear,
                canSpeak: member.canSpeak,
                volIn:    member.volIn,
                volOut:   member.volOut,
                energy:   member.energy
            });
            
            // Emit correction so UI updates
            emitInternal('enrs::member_state_corrected', {
                confName, memberId: member.id, state: existing
            });
        }
    }
}
```

**30-Second Heartbeat**

`seedConferenceRegistry()` runs every 30 seconds:

```javascript
async function seedConferenceRegistry() {
    // ESL: api show conferences as json
    const conferences = await eslClient.api('show conferences as json');
    
    for (const conf of JSON.parse(conferences).rows) {
        if (!conferenceRegistry.has(conf.name)) {
            // Conference exists in FS but not in registry — add it
            conferenceRegistry.set(conf.name, createEmptyConferenceRecord(conf));
        }
        // Sync member state for all known conferences
        await syncConferenceFromXml(conf.name);
    }
    
    // Prune stale registry entries (conference destroyed but not caught by event)
    for (const [name] of conferenceRegistry) {
        if (!activeConferences.has(name)) {
            conferenceRegistry.delete(name);
            emitInternal('enrs::conference_stale_pruned', { confName: name });
        }
    }
}
```

---

## Member Identification (Post-Fix Summary)

The table below summarizes the state of member identity data after the `trackParticipant` destNum fix is applied. This is the ground truth for both the in-memory registry and the database.

| Data Point | Location | Value (ERS ring-all leg) |
|---|---|---|
| `registry.member.displayName` | `conferenceRegistry` | Responder's actual name (e.g., `"Alice (Fire Warden)"`) |
| `registry.member.callerNum` | `conferenceRegistry` | Responder's extension (e.g., `"1001"`) |
| `registry.member.extension` | `conferenceRegistry` | Same as `callerNum` (from `Caller-Destination-Number`) |
| `ers_incident_participants.raw_number` | PostgreSQL | Responder's extension |
| `ers_incident_participants.display_name` | PostgreSQL | Responder's contact name |
| `ers_incident_responders.mobile_number` | PostgreSQL | Responder's extension |
| `ers_incident_responders.status` | PostgreSQL | `JOINED` |

**For the initiator's inbound leg:**

| Data Point | Location | Value |
|---|---|---|
| `registry.member.displayName` | `conferenceRegistry` | Initiator's name or caller ID |
| `registry.member.callerNum` | `conferenceRegistry` | Initiator's number (actual caller) |
| `ers_incident_participants.raw_number` | PostgreSQL | Initiator's number |
| `ers_incident_participants.role` | PostgreSQL | `initiator` |

---

## Monitoring UI Integration

### Socket.IO Events Emitted by Conference Engine

| Event | Payload | Description |
|---|---|---|
| `enrs::conference_created` | `{ confName, createdAt }` | New conference room created |
| `enrs::conference_destroyed` | `{ confName }` | Conference room destroyed |
| `enrs::conference_member_joined` | `{ confName, memberId, member }` | New member joined |
| `enrs::conference_member_left` | `{ confName, memberId, uuid }` | Member left |
| `enrs::member_muted` | `{ confName, memberId }` | Member muted |
| `enrs::member_unmuted` | `{ confName, memberId }` | Member unmuted |
| `enrs::member_state_corrected` | `{ confName, memberId, state }` | XML-list sync correction applied |
| `enrs::recording_started` | `{ confName, recordingPath }` | Recording became ACTIVE |
| `enrs::recording_stopped` | `{ confName, recordingId, duration }` | Recording completed |
| `enrs::ers_incident_update` | `{ incidentUuid, participantCount, responderCount }` | Incident state changed |
| `enrs::ers_incident_ended` | `{ incidentUuid, conferenceRoom }` | Incident completed |
| `enrs::conference_stale_pruned` | `{ confName }` | Stale registry entry removed |

All events are emitted via `emitInternal(event, data)` which broadcasts to all authenticated Socket.IO connections for the tenant.

---

*See also: [14-recording-guide.md](14-recording-guide.md), [15-ens-guide.md](15-ens-guide.md), [16-ers-guide.md](16-ers-guide.md)*
