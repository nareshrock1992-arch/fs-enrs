# fs-enrs Internal API — Lua Script Contracts

These endpoints are called **only by FreeSWITCH Lua scripts**.
They are authenticated with `X-Internal-Key` (shared secret, NOT JWT).
Never expose these routes to the public internet.

Mount under: `router.use('/internal', requireInternalKey, internalRoutes)`

---

## Runtime Environment Variables (FreeSWITCH server)

```bash
FS_INTERNAL_KEY=<must match backend INTERNAL_API_KEY env var>
FS_GATEWAY=avaya          # SIP gateway name in FreeSWITCH
```

---

## ENS Internal Endpoints

### Lookup ENS config by dialed number
```
GET /api/v1/internal/ens/lookup?number=<dest>

Response 200:
{
  "success": true,
  "data": {
    "configuration_id": 1,
    "name": "Fire Alarm ENS",
    "blast_clid": "9995",       // shown on recipient phone
    "reply_clid": "9996",       // recipient dials back to replay
    "pin": "1234",              // null = no PIN required
    "retry_count": 2,
    "max_concurrent": 50,       // 0 = auto-detect from FS
    "recording_retention_hours": 24,
    "contacts": ["0501234567", "0502222222"]
  }
}

Response 404: { "success": false, "error": "ENS number not found" }
```

### Create notification (called after recording is done)
```
POST /api/v1/internal/ens/notifications
Body:
{
  "configuration_id": 1,
  "triggered_via": "PHONE",    // "PHONE" | "UI" | "API"
  "caller_number": "0501111111",
  "recording_file": "/var/lib/freeswitch/recordings/ens/ens_20260704_abc.wav"
}

Response 201:
{
  "notification_uuid": "uuid-v4",
  "notification_id": 42
}
```

### Queue status (prevent simultaneous blasts)
```
GET /api/v1/internal/ens/notifications/queue-status?configuration_id=1

Response 200:
{
  "can_proceed": true,         // false = another blast in progress
  "active_uuid": null          // uuid of the blocking notification (or null)
}
```

### Get pending (unanswered) contacts for retry
```
GET /api/v1/internal/ens/notifications/:uuid/pending-contacts

Response 200:
{
  "contacts": ["0501234567"]   // numbers not yet ANSWERED or REPLAYED
}
```

### Update individual delivery status
```
PATCH /api/v1/internal/ens/notifications/:uuid/delivery
Body:
{
  "contact_number": "0501234567",
  "status": "ANSWERED",        // "ANSWERED" | "NO_ANSWER" | "FAILED" | "CANCELLED"
  "call_uuid": "fs-channel-uuid",
  "hangup_cause": "NORMAL_CLEARING",
  "answered_at": "2026-07-04T09:00:00"
}

Response 200: { "ok": true }
```

### Complete notification
```
POST /api/v1/internal/ens/notifications/:uuid/complete
Body: {}

Response 200: { "ok": true }
```

### Authorize ENS callback replay
```
GET /api/v1/internal/ens/callbacks/authorize?reply_clid=9996&caller=0501234567

Logic:
  1. Find ENS config where reply_clid = '9996'
  2. Find latest notification for that config within retention window
  3. Check ens_notification_deliveries for caller (last-9-digit match for mobile)

Response 200 (authorized):
{
  "authorized": true,
  "notification_uuid": "uuid",
  "recording_file": "/var/lib/freeswitch/recordings/ens/ens_20260704.wav",
  "delivery_id": 99
}

Response 200 (not authorized):
{
  "authorized": false,
  "reason": "not_in_blast_list"  // "not_in_blast_list" | "recording_expired" | "no_active_notification"
}
```

### Log ENS callback replay
```
POST /api/v1/internal/ens/callbacks
Body:
{
  "notification_uuid": "uuid",
  "caller_number": "0501234567",
  "reply_clid": "9996",
  "delivery_id": 99,
  "replayed_at": "2026-07-04T09:05:00"
}

Response 200: { "ok": true }
// Updates delivery status to REPLAYED
```

---

## ERS Internal Endpoints

### Lookup ERS config by emergency number
```
GET /api/v1/internal/ers/lookup?number=1222

Response 200:
{
  "success": true,
  "data": {
    "configuration_id": 1,
    "name": "Fire Response",
    "primary_responders": ["0501111111", "0502222222"],
    "secondary_responders": ["0503333333"],
    "retry_count": 2,
    "max_concurrent_conferences": 2,
    "queue_enabled": true,
    "record_conferences": true
  }
}
```

### Create incident
```
POST /api/v1/internal/ers/incidents
Body:
{
  "configuration_id": 1,
  "caller_number": "0509999999",
  "caller_name": "John Doe",
  "conference_room": "ers_1_primary",
  "group_type": "primary",
  "recording_path": "/var/lib/freeswitch/recordings/ers/ers_1_20260704.wav",
  "status": "ACTIVE"
}

Response 201:
{
  "incident_id": 7,
  "incident_uuid": "uuid-v4"
}
```

### Complete incident (caller left conference)
```
POST /api/v1/internal/ers/incidents/:uuid/complete
Body:
{
  "recording_file": "/var/lib/freeswitch/recordings/ers/ers_1_20260704.wav"
}

Response 200: { "ok": true }
// Sets status=COMPLETED, ended_at=now(), dequeues next if queue_enabled
```

### Update responder status (called by ers_retry_caller)
```
PATCH /api/v1/internal/ers/incidents/:uuid/responder
Body:
{
  "responder_number": "0501111111",
  "status": "JOINED",          // "JOINED" | "MISSED" | "REJOINED"
  "joined_at": "2026-07-04T09:01:00",
  "role": "primary"            // optional
}

Response 200: { "ok": true }
```

### Authorized rejoin lookup (for dial_ers_callback)
```
GET /api/v1/internal/ers/incidents/rejoin?rejoin_number=1223&caller=0501111111

Logic:
  1. Find ERS config where rejoin_number = '1223'
  2. Find ACTIVE incident for that config
  3. Check if caller is in primary_responders → primary room
  4. Check if caller is in secondary_responders → secondary room
  5. Check if caller is the original incident caller_number → their room
  6. Verify conference_room is still alive (member count check done in Lua)

Response 200 (authorized):
{
  "authorized": true,
  "incident_uuid": "uuid",
  "conference_room": "ers_1_primary",
  "role": "primary"            // "primary" | "secondary" | "initiator"
}

Response 200 (not authorized):
{
  "authorized": false,
  "reason": "no_active_incident"  // or "not_a_member"
}
```

### Open-access join (for dial_ers_retry_group — no membership check)
```
GET /api/v1/internal/ers/incidents/open-join?number=<dest>&caller=<number>

Logic:
  1. Resolve dest → ERS config (via open_access_numbers table or config field)
  2. Find ACTIVE incident for that config
  3. Return conference room (no membership validation)

Response 200:
{
  "incident_uuid": "uuid",
  "conference_room": "ers_1_primary"
}

Response 404:
{
  "conference_room": null,
  "reason": "no_active_incident"
}
```

### Log open-access observer
```
POST /api/v1/internal/ers/incidents/:uuid/observer
Body:
{
  "observer_number": "0507777777",
  "joined_via": "1224",
  "joined_at": "2026-07-04T09:03:00"
}

Response 200: { "ok": true }
// Inserts into ers_incident_responders with status=OBSERVER
```

---

## Backend Middleware

```typescript
// middleware/requireInternalKey.ts
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== config.internalApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

```env
# Add to .env.example
INTERNAL_API_KEY=change_me_internal_key   # Same value as FS_INTERNAL_KEY on FS server
```

---

## Dialplan Entries Required

```xml
<!-- extensions/enrs.xml -->

<!-- ENS blast trigger (e.g. 9995) -->
<extension name="ens_blast">
  <condition field="destination_number" expression="^(99[0-9]{2})$">
    <action application="lua" data="ens_blast_trigger.lua"/>
  </condition>
</extension>

<!-- ENS callback replay (e.g. 9996) -->
<extension name="ens_replay">
  <condition field="destination_number" expression="^(99[0-9]{2})$">
    <!-- reply_clid numbers are resolved by ens_playback_handler.lua via API -->
    <action application="lua" data="ens_playback_handler.lua"/>
  </condition>
</extension>

<!-- ERS emergency (e.g. 1222) -->
<extension name="ers_emergency">
  <condition field="destination_number" expression="^(1222)$">
    <action application="lua" data="ers_conference_bridge.lua"/>
  </condition>
</extension>

<!-- ERS authorized rejoin (e.g. 1223) -->
<extension name="ers_rejoin">
  <condition field="destination_number" expression="^(1223)$">
    <action application="lua" data="dial_ers_callback.lua"/>
  </condition>
</extension>

<!-- ERS open-access join (optional, e.g. 1224) -->
<extension name="ers_open_join">
  <condition field="destination_number" expression="^(1224)$">
    <action application="lua" data="dial_ers_retry_group.lua"/>
  </condition>
</extension>
```
