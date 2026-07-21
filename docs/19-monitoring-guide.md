# Monitoring Guide

## Overview

fs-enrs provides real-time monitoring of active FreeSWITCH conferences through a combination of a WebSocket (Socket.IO) push channel and a REST polling API. The monitoring subsystem maintains an in-memory `conferenceRegistry` that is kept synchronized with FreeSWITCH state via ESL events and periodic heartbeat resyncs.

---

## Monitoring Dashboard (Frontend)

- **Route:** `/monitoring`
- **Component:** `frontend/src/pages/Monitoring.jsx`
- **Data source 1:** `GET /monitoring/conferences` — REST endpoint for initial state load and periodic polling fallback
- **Data source 2:** Socket.IO events — real-time push updates for incremental state changes

---

## Conference State via REST

**Endpoint:** `GET /monitoring/conferences`

Returns all conferences currently tracked in the in-memory `conferenceRegistry`. Use this endpoint for initial page load and as a polling fallback when the Socket.IO connection is unavailable.

**Response schema:**

```json
{
  "conferences": [
    {
      "name": "ers_1_p1",
      "createdAt": "2025-01-20T10:30:00Z",
      "locked": false,
      "recording": true,
      "recordingState": "ACTIVE",
      "floorHolder": "3",
      "memberCount": 4,
      "members": [
        {
          "id": "1",
          "callerNum": "5001",
          "callerName": "John Smith",
          "displayName": "John Smith",
          "muted": false,
          "deaf": false,
          "moderator": false,
          "talking": true,
          "floor": true,
          "joinedAt": "2025-01-20T10:30:05Z"
        }
      ]
    }
  ]
}
```

**`recordingState` values:** `STARTING` | `ACTIVE` | `STOPPING` | `OFF` | `FAILED`

---

## Socket.IO Real-Time Events

### Authentication

Before receiving events, the client must authenticate:

1. Connect to `/socket.io`
2. Emit `authenticate` with payload `{ token: "JWT_ACCESS_TOKEN" }`
3. Server responds with `authenticated { userId, role }` on success, or `auth.error "message"` on failure
4. An authenticated socket is automatically scoped to the tenant derived from the JWT

### Conference Lifecycle Events

| Event | Payload | Description |
|---|---|---|
| `conference.created` | `{ name, createdAt }` | New conference room created |
| `conference.ended` | `{ name }` | Conference destroyed |
| `conference.locked` | `{ name, locked: bool }` | Lock or unlock state changed |
| `conference.recording` | `{ name, recording: bool, recordingState }` | Recording state changed |
| `conference.floor.changed` | `{ name, floorHolder: memberId }` | Floor holder changed |

### Member Events

| Event | Payload | Description |
|---|---|---|
| `conference.member.joined` | `{ name, member: memberData }` | New member joined; includes full `memberData` object |
| `conference.member.left` | `{ name, memberId }` | Member departed |
| `conference.member.muted` | `{ name, memberId, muted: bool }` | Mute state changed |
| `conference.member.deaf` | `{ name, memberId, deaf: bool }` | Deaf state changed |
| `conference.member.talking` | `{ name, memberId, talking: bool }` | Talking state changed |
| `conference.member.energy` | `{ name, memberId, energy: int }` | Energy level changed |

### ESL and Application Events

| Event | Payload | Description |
|---|---|---|
| `esl.status` | `{ connected: bool, host, port }` | ESL connection state changed |
| `enrs::ers_incident_created` | Incident metadata | New ERS incident opened |
| `enrs::ers_incident_ended` | `{ incidentUuid }` | ERS incident completed |
| `enrs::ens_started` | Campaign metadata | New ENS campaign started |
| `enrs::campaign_progress` | `{ campaignId, dialing, ready }` | Campaign tick update |
| `enrs::campaign_call_answered` | `{ campaignId, destination }` | Individual call answered |
| `enrs::campaign_completed` | `{ campaignId }` | Campaign finished |

---

## Monitoring Actions

All write actions require the **ADMIN** or **SUPERVISOR** role.

### Conference-Level Controls

#### Lock Conference
```
POST /monitoring/conferences/:room/lock
```
Prevents new members from joining the conference. The `locked` field in the conference object reflects this state.

#### Start Recording
```
POST /monitoring/conferences/:room/record/start
Body: { "file_path": "/var/lib/freeswitch/recordings/manual/custom.wav" }
```
`file_path` is optional. If omitted, defaults to `/var/lib/freeswitch/recordings/manual/{room}_{timestamp}.wav`.

#### Stop Recording
```
POST /monitoring/conferences/:room/record/stop
```

#### Play Announcement
```
POST /monitoring/conferences/:room/play
Body: { "audio_url": "/media/announcement.wav" }
```
Plays an audio file to all conference members.

#### Text-to-Speech
```
POST /monitoring/conferences/:room/say
Body: { "text": "Attention all responders..." }
```
Speaks text to all conference members via the configured TTS engine.

#### Invite Participant
```
POST /monitoring/conferences/:room/invite
Body: { "destination": "5001", "dialplan": "XML", "context": "default" }
```
Originates a call to `destination` and bridges it into the conference. `dialplan` and `context` are optional and default to `XML` and `default`.

#### Terminate Conference
```
DELETE /monitoring/conferences/:room
```
Kicks all members and destroys the conference. This action is irreversible.

---

### Member-Level Controls

All member controls are prefixed with `POST /monitoring/conferences/:room/members/:memberId/`.

| Action | Method + Path | Body | Description |
|---|---|---|---|
| Mute | `POST .../mute` | — | Member cannot hear other participants |
| Unmute | `POST .../unmute` | — | Restore audio |
| Deaf | `POST .../deaf` | — | Member cannot be heard by others |
| Undeaf | `POST .../undeaf` | — | Restore audio |
| Volume | `POST .../volume` | `{ "level": -4 }` | Adjust input volume; range `-4` to `4` |
| Energy | `POST .../energy` | `{ "level": 50 }` | Adjust talking threshold; range `0`–`100` |
| Force floor | `POST .../floor` | — | Assign conference floor to this member |
| Transfer | `POST .../transfer` | `{ "destination", "dialplan", "context" }` | Transfer member out to another destination |
| Toggle moderator | `POST .../moderator` | — | Toggle moderator status for this member |
| Kick member | `DELETE .../:memberId` | — | Remove member from conference |

---

## ESL Connection Monitoring

### Status Check
```
GET /monitoring/status
```
Returns:
```json
{
  "esl_connected": true,
  "conference_count": 3
}
```

### Force Conference Resync (ADMIN / SUPERVISOR only)
```
GET /monitoring/debug/conf-sync
```
Triggers an immediate `xml_list` resync of all conferences from FreeSWITCH, overwriting the in-memory `conferenceRegistry`. Use when the registry appears out of sync with FreeSWITCH state.

---

## Member State Accuracy Notes

The in-memory `conferenceRegistry` follows a progressive correction model:

| Timing | Mechanism | Accuracy |
|---|---|---|
| At join | `parseMemberFlags` text inference from ESL event | Approximate — text parsing only |
| +600 ms | `xml_list` sync for that conference | Corrected muted / deaf / floor / talking |
| ~+50 ms | `trackParticipant` DB contact lookup | `displayName` corrected from `emergency_contacts` |
| Every 30 s | Full heartbeat reseed from FreeSWITCH | All conferences fully reconciled |

If a member's name shows as a raw number immediately after join, it will be resolved to the contact's first and last name within approximately 50 ms once `trackParticipant` completes the database lookup.
