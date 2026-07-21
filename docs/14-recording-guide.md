# Recording Guide

**Document:** 14-recording-guide.md  
**System:** fs-enrs (FreeSWITCH Emergency Notification and Response System)  
**Audience:** System administrators, integration engineers, operations staff  

---

## Overview

The fs-enrs platform records two distinct categories of audio:

| Context | Source | Storage Path | Trigger |
|---|---|---|---|
| **ERS Conference** | Active emergency conference bridge | `/var/lib/freeswitch/recordings/ers/` | Conference create or moderator join |
| **ENS Campaign** | Operator records message before blast | `/var/lib/freeswitch/recordings/ens/` | IVR `ens_blast_record` node |
| **IVR** | IVR-level recordings | `/var/lib/freeswitch/recordings/ivr/` | IVR flow action |
| **Manual** | Admin-initiated from monitoring UI | `/var/lib/freeswitch/recordings/manual/` | POST to monitoring API |

### Directory Structure

```
/var/lib/freeswitch/recordings/
├── ers/
│   └── {ers_configuration_id}/
│       └── {incident_uuid}_{timestamp}.wav
├── ens/
│   └── {ens_configuration_id}/
│       └── {campaign_uuid}_{timestamp}.wav
├── ivr/
│   └── {ivr_flow_id}/
│       └── {session_uuid}_{timestamp}.wav
└── manual/
    └── {conference_room}/
        └── {timestamp}.wav
```

FreeSWITCH must have write permission to these directories. Set ownership to the `freeswitch` OS user.

---

### `recordings` Table Schema

```sql
CREATE TABLE recordings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conference_room     TEXT,
    incident_uuid       UUID REFERENCES ers_incidents(id),
    ers_configuration_id UUID REFERENCES ers_configurations(id),
    recording_path      TEXT UNIQUE NOT NULL,
    recording_file      TEXT GENERATED ALWAYS AS (
                            split_part(recording_path, '/', -1)
                        ) STORED,
    file_size_bytes     BIGINT,
    duration_sec        INTEGER,
    status              TEXT NOT NULL CHECK (status IN ('RECORDING','COMPLETED','ARCHIVED','FAILED')),
    recording_type      TEXT NOT NULL CHECK (recording_type IN ('ERS','ENS','IVR','MANUAL')),
    waveform_peaks      JSONB,
    notes               TEXT,
    tags                JSONB,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    deleted_at          TIMESTAMPTZ
);
```

**Key fields:**

| Field | Notes |
|---|---|
| `recording_path` | Absolute filesystem path. UNIQUE constraint prevents duplicate entries per file. |
| `recording_file` | Generated column — basename of `recording_path`. Used for download filenames. |
| `status` | State machine: `RECORDING` → `COMPLETED` or `FAILED`; `COMPLETED` → `ARCHIVED` |
| `recording_type` | Determines storage subdirectory and API filtering |
| `waveform_peaks` | JSONB array of amplitude samples for UI waveform display |
| `incident_uuid` | NULL for ENS/IVR/MANUAL types; set for ERS type |

---

## ERS Conference Recording

### Configuration

ERS recording is controlled at the `ers_configurations` level:

| Configuration Field | Type | Description |
|---|---|---|
| `record_conferences` | BOOLEAN | Master switch — enables/disables automatic recording |
| `recording_enabled` | BOOLEAN | Alias for `record_conferences` (both checked) |
| `recording_mode` | TEXT | `AUTO` (start on conference-create) or `MANUAL` (admin initiates) |
| `recording_trigger` | TEXT | `CONFERENCE_CREATED`, `FIRST_PARTICIPANT`, or `MODERATOR_JOIN` |
| `recording_retention_hours` | INTEGER | Retention advisory (default: 48 hours) |

### Recording Mode: AUTO vs MANUAL

**AUTO mode** — FreeSWITCH begins recording immediately when the conference room is created, before any participants join.

**MANUAL mode** — Recording does not start automatically. An administrator must POST to the monitoring API or trigger via UI. Suitable for incident response scenarios where not all calls should be recorded.

### ESL Event Flow

The recording lifecycle is driven by FreeSWITCH ESL events processed in `eslService.js`:

```
FreeSWITCH                     eslService.js                    PostgreSQL
    │                               │                               │
    │── conference::maintenance ──►│                               │
    │   action: start-recording     │── upsertRecordingStart() ──►│
    │                               │   INSERT recordings           │
    │                               │   status=RECORDING            │
    │                               │── set registry ────────────► │
    │                               │   recordingState=ACTIVE       │
    │                               │── UPDATE ers_incidents ──────►│
    │                               │   recording_path=<path>       │
    │                               │                               │
    │── conference::maintenance ──►│                               │
    │   action: stop-recording      │── closeRecording() ─────────►│
    │                               │   UPDATE recordings           │
    │                               │   status=COMPLETED            │
    │                               │   ended_at=now()              │
    │                               │                               │
    │── conference-destroy ────────►│                               │
    │   (if recording still ACTIVE) │── closeRecording() ─────────►│
    │                               │   handles crash/disconnect    │
```

**`upsertRecordingStart(room, path, incidentUuid, configId, tenantId)`**
- Inserts a new `recordings` row with `status='RECORDING'`
- Updates `conferenceRegistry[room].recordingState = 'ACTIVE'`
- Updates `ers_incidents.recording_path` so the monitoring UI reflects the file path immediately

**`closeRecording(room)`**
- Sets `recordings.status = 'COMPLETED'`
- Sets `recordings.ended_at = now()`
- Sets `conferenceRegistry[room].recordingState = 'OFF'`
- Emits `enrs::recording_stopped` Socket.IO event

### Recording State Machine

```
        OFF
         │
         │ (recording_mode=AUTO or admin POST)
         ▼
     STARTING ──────── bgapi reloadxml + timeout ──────► FAILED
         │                                                  (timeout exceeded)
         │ (start-recording ESL event received)
         ▼
      ACTIVE
         │
         │ (stop-recording ESL event or conference-destroy)
         ▼
     STOPPING
         │
         │ (stop-recording ESL event confirmed)
         ▼
     COMPLETED
```

**State notes:**
- `STARTING` to `ACTIVE` transition requires FreeSWITCH to acknowledge the record command via `conference::maintenance` with `action=start-recording`. If this event is not received within the configured timeout, the state moves to `FAILED`.
- `conference-destroy` is a safety net: if the conference is destroyed while `recordingState = 'ACTIVE'`, `closeRecording()` is called to ensure the DB row is closed.

### 120-Second Healer Job

A background scanner runs every 120 seconds to detect and heal missed `stop-recording` events:

```
eslService.js: scanRecordingDirectory()
  ├── Query: SELECT id, recording_path FROM recordings WHERE status='RECORDING'
  │          AND started_at < now() - interval '120 seconds'
  ├── For each stale RECORDING row:
  │   ├── Stat the file on disk to get actual file size
  │   ├── If file exists and size > 0: UPDATE status=COMPLETED, file_size_bytes=<actual>
  │   └── If file missing: UPDATE status=FAILED
  └── Log findings for operator review
```

This handles cases where the FreeSWITCH process crashed or the ESL connection was interrupted before the `stop-recording` event was delivered.

### File Naming

ERS recordings follow this naming convention:

```
/var/lib/freeswitch/recordings/ers/{ers_configuration_id}/{incident_uuid}_{timestamp}.wav
```

**Example:**

```
/var/lib/freeswitch/recordings/ers/3f8a1c2d-0000-0000-0000-000000000001/
    a9b2c3d4-e5f6-7890-abcd-ef1234567890_20260720-143022.wav
```

---

## Manual Recording via Monitoring

Administrators can initiate recording on any active conference from the monitoring dashboard.

### Start Recording

```http
POST /api/v1/monitoring/conferences/:room/record/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "file_path": "/var/lib/freeswitch/recordings/manual/myroom_20260720.wav"
}
```

If `file_path` is omitted, the system generates a path using `{room}_{ISO8601timestamp}.wav` under the `manual/` directory.

**Backend action:**
```
bgapi conference {room} record {path}
```

### Stop Recording

```http
POST /api/v1/monitoring/conferences/:room/record/stop
Authorization: Bearer <token>
```

**Backend action:**
```
bgapi conference {room} norecord {path}
```

The recording is inserted into the `recordings` table with `recording_type = 'MANUAL'`. The `incident_uuid` and `ers_configuration_id` columns are NULL for manual recordings.

---

## ENS Campaign Recording (via IVR Node)

Before dispatching an ENS blast, the operator records the notification message through the IVR flow.

### IVR Flow: `ens_blast_record` Node

The `ens_blast_record` node is a specialized IVR action that:

1. Plays a prompt instructing the operator to record their message after the tone
2. Records the caller's audio input
3. Optionally plays back the recording and prompts for confirmation
4. Stores the recording file path as an IVR session variable

```
IVR Flow (on ENS trigger number)
  │
  ├─► [gather DTMF PIN]
  │
  ├─► [condition: ens_pin_valid]
  │         POST /internal/ens/verify-pin
  │
  ├─► [ens_blast_record]
  │         record → session.recording_file = /var/lib/freeswitch/recordings/ens/...
  │
  └─► [ens node]
            POST /internal/ens/campaign/start {
              trigger_number: <caller>,
              recording_file: session.recording_file
            }
```

### Storage

ENS recordings are stored at:

```
/var/lib/freeswitch/recordings/ens/{ens_configuration_id}/{timestamp}_{session_uuid}.wav
```

The `recording_file` path is passed as the `messageAudioUrl` when creating the campaign and is played back to all notified contacts during outbound call delivery.

### Retention

| Configuration | Field | Default |
|---|---|---|
| ERS | `ers_configurations.recording_retention_hours` | 48 hours |
| ENS | `ens_configurations.recording_retention_hours` | 24 hours |

> **Important:** Retention values are advisory only. No automatic file deletion is implemented. Operators must run manual cleanup or schedule a cron job that respects these values.

---

## Recording Lifecycle API

### List Recordings

```http
GET /api/v1/recordings
Authorization: Bearer <token>

Query Parameters:
  type        ERS | ENS | IVR | MANUAL
  status      RECORDING | COMPLETED | ARCHIVED | FAILED
  from        ISO8601 datetime (started_at >=)
  to          ISO8601 datetime (started_at <=)
  limit       integer (default: 20, max: 1000)
  offset      integer
```

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "conference_room": "ers_1_p1",
      "incident_uuid": "uuid",
      "recording_file": "a9b2c3d4_20260720-143022.wav",
      "file_size_bytes": 2048000,
      "duration_sec": 127,
      "status": "COMPLETED",
      "recording_type": "ERS",
      "started_at": "2026-07-20T14:30:22Z",
      "ended_at": "2026-07-20T14:32:29Z"
    }
  ],
  "total": 142,
  "limit": 20,
  "offset": 0
}
```

### Get Recording Detail

```http
GET /api/v1/recordings/:id
Authorization: Bearer <token>
```

Returns full recording metadata including `waveform_peaks` JSONB for audio waveform visualization.

### Stream Audio

```http
GET /api/v1/recordings/:id/stream
Authorization: Bearer <token>
  — OR —
GET /api/v1/recordings/:id/stream?token=<jwt>
```

Supports HTTP `Range` requests for seeking. The `?token=` query parameter allows embedding in `<audio>` elements where Bearer headers cannot be set.

**Headers returned:**
```
Content-Type: audio/wav
Content-Length: 2048000
Accept-Ranges: bytes
```

### Download Recording

```http
GET /api/v1/recordings/:id/download
Authorization: Bearer <token>
```

Returns the audio file with `Content-Disposition: attachment; filename="<recording_file>"` to force a browser download.

### Get Waveform Data

```http
GET /api/v1/recordings/:id/waveform
Authorization: Bearer <token>
```

Returns the `waveform_peaks` JSONB array for rendering an audio visualization widget in the UI. Peaks are pre-computed and stored at recording completion time.

### Update Metadata

```http
PUT /api/v1/recordings/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "notes": "Critical incident — fire suppression activation Building A",
  "tags": ["fire", "building-a", "2026-07"]
}
```

Only `notes` and `tags` are mutable after recording completion.

### Archive Recording

```http
POST /api/v1/recordings/:id/archive
Authorization: Bearer <token>
```

Moves the recording to `ARCHIVED` status. The physical file is retained on disk. Archived recordings are excluded from default list queries unless `status=ARCHIVED` is explicitly requested.

### Delete Recording

```http
DELETE /api/v1/recordings/:id
Authorization: Bearer <token>
```

Soft-delete only — sets `deleted_at = now()`. The physical audio file is **not** deleted. File removal must be performed separately by an administrator in accordance with retention policy.

---

## Troubleshooting

### Recording Not Starting

| Symptom | Check |
|---|---|
| `recordingState` stays `OFF` | Verify `record_conferences = true` in `ers_configurations` |
| No `start-recording` ESL event | Confirm ESL TCP connection is established (`netstat -an | grep 8021`) |
| Permission denied in FreeSWITCH logs | Verify `freeswitch` OS user has write access to `/var/lib/freeswitch/recordings/` |
| Wrong recording mode | Check `recording_mode = 'AUTO'` if expecting automatic start |

### Recording Stuck in STARTING

The `STARTING` state means the system issued the record command to FreeSWITCH but has not yet received the `start-recording` ESL event.

**Diagnosis steps:**
1. Check FreeSWITCH `conference.log` for errors related to the conference profile's record permissions.
2. Verify the conference profile (`conference_profile` field) has `record-file-shareable = true` or equivalent permission.
3. Confirm the recording destination directory exists and is writable.
4. Check `eslService.js` logs for the `bgapi conference {room} record {path}` command output.

### Recording File Missing After Completion

If the DB row shows `status=COMPLETED` but no file exists on disk:

1. Check `FS_RECORDINGS_DIR` environment variable — it must match the path FreeSWITCH writes to.
2. Confirm the directory was not moved or cleaned by an external process.
3. Review the 120-second healer logs: it will have set `status=FAILED` if the file was missing during its scan.

### 120-Second Healer Not Running

Check `eslService.js` startup logs for:
```
[recording-healer] Scanner initialized, interval=120s
```

If absent, verify `scanRecordingDirectory()` is called in the ESL service initialization path in `server.js`.

---

*See also: [15-ens-guide.md](15-ens-guide.md), [16-ers-guide.md](16-ers-guide.md), [17-conference-guide.md](17-conference-guide.md)*
