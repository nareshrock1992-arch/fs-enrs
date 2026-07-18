# 03 — API Reference

## Base URL

| Environment | URL |
|---|---|
| Development | `http://localhost:4100/api/v1` |
| Production | `https://<host>/api/v1` |

## Authentication

All UI endpoints require:
```
Authorization: Bearer <access_token>
```

Internal endpoints (Lua only) require:
```
X-Internal-Key: <INTERNAL_API_KEY from .env>
```

---

## Rate Limits

| Surface | Limit |
|---|---|
| All `/api/*` | 300 req/min (global) |
| `POST /api/v1/auth/login` | 10 req/15min |
| `/api/v1/internal/*` | 500 req/min (separate bucket) |

---

## Role Hierarchy

`ADMIN` > `SUPERVISOR` > `OPERATOR` > `VIEWER`

| Guard | Roles allowed |
|---|---|
| `adminOnly` | ADMIN |
| `adminOrSuper` | ADMIN, SUPERVISOR |
| `adminOrOp` | ADMIN, OPERATOR |
| `canTriggerEns` | ADMIN, SUPERVISOR, OPERATOR |
| `canManageIncidents` | ADMIN, SUPERVISOR |
| `anyRole` | All roles |

---

# Authentication (`/api/v1/auth`)

---

### `POST /api/v1/auth/login`
**Purpose:** Authenticate user, issue JWT access token and refresh cookie.  
**Auth:** None  
**Rate limit:** 10/15min

**Request body:**
```json
{ "email": "admin@enrs.local", "password": "Admin@12345" }
```

**Response 200:**
```json
{ "token": "<access_jwt>", "user": { "id": 1, "email": "...", "role": "ADMIN", "tenantId": "..." } }
```

Sets `HttpOnly` refresh token cookie (`enrs_refresh`).

**Response 401:** `{ "error": "Invalid credentials" }`

---

### `POST /api/v1/auth/refresh`
**Purpose:** Renew access token using refresh cookie.  
**Auth:** Refresh cookie  

**Response 200:** `{ "token": "<new_access_jwt>" }`

---

### `POST /api/v1/auth/logout`
**Purpose:** Invalidate refresh token, clear cookie.  
**Auth:** Bearer  

**Response 200:** `{ "message": "Logged out" }`

---

### `GET /api/v1/auth/me`
**Purpose:** Return current user profile.  
**Auth:** Bearer  

**Response 200:**
```json
{ "id": 1, "email": "admin@enrs.local", "role": "ADMIN", "first_name": "Admin", "last_name": "User" }
```

---

### `POST /api/v1/auth/change-password`
**Purpose:** Change current user's password.  
**Auth:** Bearer  

**Request body:**
```json
{ "currentPassword": "old", "newPassword": "New@Pass1" }
```

**Response 200:** `{ "message": "Password changed" }`

---

# Users (`/api/v1/users`)

All endpoints: `requireAuth` + `adminOnly`

---

### `GET /api/v1/users`
**Purpose:** List all users in the tenant.  
**DB:** `users`  
**Response:** `[{ id, email, role, first_name, last_name, is_active, created_at }]`

---

### `GET /api/v1/users/:id`
**Purpose:** Get a single user.

---

### `POST /api/v1/users`
**Purpose:** Create user.  
**Body:** `{ email, password, role, first_name, last_name }`  
**Response 201:** User row.

---

### `PUT /api/v1/users/:id`
**Purpose:** Update user (role, name, active status).  
**Body:** `{ role?, first_name?, last_name?, is_active? }`

---

### `DELETE /api/v1/users/:id`
**Purpose:** Soft-delete user.

---

# Organizations (`/api/v1/organizations`)

### `GET /api/v1/organizations`
`requireAuth` + `adminOrOp`  
**Query:** `limit=1000&search=...`  
**Response:** `{ data: [org], total, page, limit }`

### `GET /api/v1/organizations/:id`
### `POST /api/v1/organizations`
`adminOnly` — Body: `{ name, code?, address?, phone?, email? }`
### `PUT /api/v1/organizations/:id`
### `DELETE /api/v1/organizations/:id`

### `GET /api/v1/organizations/locations`
**Query:** `organization_id=<n>`  
**Response:** `[{ id, name, organization_id, address }]`

### `POST /api/v1/organizations/locations`
### `PUT /api/v1/organizations/locations/:id`
### `DELETE /api/v1/organizations/locations/:id`

### `GET /api/v1/organizations/departments`
**Query:** `organization_id=<n>`

### `POST /api/v1/organizations/departments`
### `PUT /api/v1/organizations/departments/:id`
### `DELETE /api/v1/organizations/departments/:id`

---

# Emergency Contacts (`/api/v1/contacts`)

### `GET /api/v1/contacts`
`requireAuth` + `adminOrOp`  
**Query:** `limit=1000&organization_id=&search=`  
**Response:** `{ data: [contact], total, page, limit }`

Contact shape:
```json
{
  "id": 1, "first_name": "John", "last_name": "Smith",
  "extension_number": "1001", "mobile_number": "+601112223333",
  "email": "john@org.com", "organization_id": 1, "is_active": true
}
```

### `GET /api/v1/contacts/:id`
### `POST /api/v1/contacts`
`adminOnly` — Body: `{ first_name, last_name, extension_number?, mobile_number?, organization_id }`
### `PUT /api/v1/contacts/:id`
### `DELETE /api/v1/contacts/:id`

### `POST /api/v1/contacts/bulk-upload`
`adminOnly`  
**Body:** `multipart/form-data` — `file` (CSV), `organization_id`  
**Response:** `{ imported: N, errors: [...] }`

---

# Responder Groups (`/api/v1/groups`)

### `GET /api/v1/groups`
**Query:** `organization_id=&limit=1000`

### `POST /api/v1/groups`
`adminOnly` — Body: `{ name, description?, organization_id }`

### `PUT /api/v1/groups/:id`
### `DELETE /api/v1/groups/:id`

### `POST /api/v1/groups/:id/members`
`adminOnly` — Body: `{ contact_ids: [1, 2, 3] }`

### `DELETE /api/v1/groups/:id/members/:contactId`
`adminOnly`

---

# ENS Configurations (`/api/v1/ens`)

### `GET /api/v1/ens/configurations`
`requireAuth` + `adminOrOp`  
**Response:** `[{ id, name, description, pin_required, is_active, ... }]`

### `GET /api/v1/ens/configurations/:id`
### `POST /api/v1/ens/configurations`
`adminOnly`  
**Body:**
```json
{
  "organization_id": 1,
  "name": "Building A ENS",
  "pin": "1234",
  "no_pending_msg": "No active broadcasts",
  "expiry_announcement": "This broadcast has expired",
  "contact_ids": [1, 2],
  "group_ids": [1]
}
```

### `PUT /api/v1/ens/configurations/:id`
### `PATCH /api/v1/ens/configurations/:id/toggle`
Toggles `is_active`.

### `DELETE /api/v1/ens/configurations/:id`

### `GET /api/v1/ens/notifications`
**Query:** `configuration_id=&status=&from=&to=`  
**Response:** `[{ notification_uuid, campaign_name, status, started_at, completed_at }]`

### `POST /api/v1/ens/notifications`
`canTriggerEns`  
**Body:** `{ configuration_id, message?, priority? }`  
**Purpose:** Manually trigger an ENS broadcast from the UI (not the Lua path).

---

# ERS Configurations (`/api/v1/ers`)

### `GET /api/v1/ers/configurations`
`requireAuth` + `adminOrOp`  

**Response fields include (after migration 027):**
```json
{
  "id": 1,
  "name": "Main Gate ERS",
  "primary_bridge_number": "3010",
  "secondary_bridge_number": "3011",
  "conference_profile": "default",
  "conference_type": "STATIC",
  "recording_enabled": false,
  "recording_mode": "MANUAL",
  "recording_trigger": "CONFERENCE_CREATED",
  "recording_format": "wav",
  "max_concurrent_conferences": 2,
  "queue_enabled": true,
  "record_conferences": false,
  "is_active": true
}
```

### `GET /api/v1/ers/configurations/:id`
### `POST /api/v1/ers/configurations`
`adminOnly`  
**Body:** All ERS configuration fields (see ErsConfigSchema in ersController.js)

### `PUT /api/v1/ers/configurations/:id`
`adminOnly`

### `PATCH /api/v1/ers/configurations/:id/toggle`
`adminOnly` — Toggles `is_active`

### `DELETE /api/v1/ers/configurations/:id`
`adminOnly`

### `GET /api/v1/ers/configurations/:id/tier-groups`
`adminOrOp` — Returns tier 1 (primary) and tier 2 (secondary) responder groups + contacts

### `PUT /api/v1/ers/configurations/:id/tier-groups`
`adminOnly` — Body: `{ primary_group_ids: [], secondary_group_ids: [], primary_contact_ids: [], secondary_contact_ids: [] }`

---

### `GET /api/v1/ers/incidents`
`adminOrOp`  
**Query:** `configuration_id=&status=ACTIVE|COMPLETED|QUEUED&from=&to=`  
**Response:** Incident list with responder count

### `GET /api/v1/ers/incidents/:uuid/detail`
`adminOrOp` — Full incident detail with participants, responders, recording path

### `GET /api/v1/ers/incidents/:id/responders`
`adminOrOp` — Responder invite + answer history

### `POST /api/v1/ers/incidents/:uuid/complete`
`adminOrOp` — Mark incident COMPLETED from UI (supervisor action)  
**Body:** `{ recording_file?: "/path/to.wav" }`

### `POST /api/v1/ers/incidents/:uuid/cancel`
`adminOrOp` — Cancel a QUEUED incident

### `GET /api/v1/ers/queue`
`adminOrOp` — Active queue entries with position + wait time

---

### Conference Controls (ERS module)

### `GET /api/v1/ers/conference/:room/members`
`adminOrOp` — Members from in-memory registry  
**ESL:** `conference <room> list`

### `POST /api/v1/ers/conference/:room/kick`
`adminOrOp` — Body: `{ member_id }`  
**ESL:** `conference <room> kick <memberId>`

### `POST /api/v1/ers/conference/:room/mute`
`adminOrOp` — Body: `{ member_id, muted: true|false }`  
**ESL:** `conference <room> mute/unmute <memberId>`

### `POST /api/v1/ers/conference/:room/play`
`adminOrOp` — Body: `{ audio_path }`  
**ESL:** `conference <room> play <audio_path>`

---

# IVR Flows (`/api/v1/ivr`)

### `GET /api/v1/ivr/node-types`
`requireAuth` — Returns all available IVR node type definitions (palette + property schemas)  
**Controller:** `ivrController.getNodeTypes()`

### `GET /api/v1/ivr/flows`
`requireAuth` + `adminOrOp`  
**Query:** `limit=&page=&search=`

### `GET /api/v1/ivr/flows/templates`
`requireAuth` + `adminOrOp` — Returns built-in IVR flow templates

### `POST /api/v1/ivr/flows/templates/:id/create`
`adminOnly` — Creates a new flow from a template  
**Body:** `{ name? }`

### `GET /api/v1/ivr/flows/:uuid`
### `POST /api/v1/ivr/flows`
`adminOnly` — Body: `{ name, description?, graph? }`

### `PUT /api/v1/ivr/flows/:uuid`
`adminOnly` — Save graph  
**Body:** `{ name?, description?, graph: { entry_node_id, nodes: {...} } }`

### `DELETE /api/v1/ivr/flows/:uuid`
`adminOnly`

### `POST /api/v1/ivr/flows/:uuid/validate`
`adminOrOp`  
**Body:** `{ graph? }` — validates saved graph or provided graph  
**Response:** `{ valid: true }` or `{ valid: false, errors: [...] }`

### `POST /api/v1/ivr/flows/:uuid/publish`
`adminOnly`  
**Body:** `{ change_notes? }`  
**Purpose:** Creates immutable version snapshot in `ivr_flow_versions`  
**Response:** `{ version: N, published_at: "..." }`

### `GET /api/v1/ivr/flows/:uuid/versions`
`adminOrOp` — Returns all published version history

### `GET /api/v1/ivr/flows/:uuid/versions/:version`
`adminOrOp` — Returns a specific version's graph snapshot

### `PATCH /api/v1/ivr/flows/:uuid/bind`
`adminOnly` — Body: `{ emergency_number_id: N }`  
**Purpose:** Link a flow to an emergency number (enables deployment)

### `PATCH /api/v1/ivr/flows/:uuid/unbind`
`adminOnly` — Body: `{ emergency_number_id: N }`

---

# Deployment (`/api/v1/deployment`)

### Audio Library

### `GET /api/v1/deployment/audio`
`adminOrOp` — List uploaded audio files  
**DB:** `audio_library`

### `GET /api/v1/deployment/audio/categories`
`adminOrOp`

### `POST /api/v1/deployment/audio/scan`
`adminOnly` — Scan FS sound directory and import new files

### `POST /api/v1/deployment/audio/upload`
`adminOnly` — `multipart/form-data`: `file`, `category`, `description`  
**Purpose:** Upload audio file → staging → deploy to FreeSWITCH sounds directory

### `POST /api/v1/deployment/audio/:id/deploy`
`adminOnly`  
**ESL:** copies file to `FS_SOUND_DIR/enrs/`

### `GET /api/v1/deployment/audio/:id/stream`
`adminOrOp` — Token auth (`?token=`) for browser `<audio>` elements

### `DELETE /api/v1/deployment/audio/:id`
`adminOnly`

---

### Flow Deployment

### `GET /api/v1/deployment/flows`
`adminOrOp` — All IVR flows with last deployment status  
**DB:** `ivr_flows` JOIN `ivr_flow_deployments`

### `GET /api/v1/deployment/flows/:uuid/preview`
`adminOrOp` — Shows what Lua + XML would be generated without writing anything

### `POST /api/v1/deployment/flows/:uuid/deploy`
`adminOnly`  
**Pipeline:**
1. Load published version from `ivr_flow_versions`
2. `luaGenerator.js` → Lua script → write to `FS_SCRIPT_DIR`
3. `xmlGenerator.js` → Dialplan XML → write to `FS_DIALPLAN_DIR/enrs/`
4. ESL `api reloadxml` → hot-reload
5. Record in `ivr_flow_deployments`  
**Socket event:** none (response is synchronous)

### `GET /api/v1/deployment/flows/:uuid/history`
`adminOrOp` — Deployment records  
**Query:** `limit=10`

### `POST /api/v1/deployment/redeploy-all`
`adminOnly` — Re-deploy all currently bound + published flows

---

### Diagnostics

### `GET /api/v1/deployment/diagnostics`
`adminOrOp` — Checks: ESL connectivity, FS path accessibility, dialplan conflicts  
**ESL:** `status`

### `POST /api/v1/deployment/diagnostics/reloadxml`
`adminOnly`  
**ESL:** `api reloadxml`  
**Response:** `{ result: "...", success: true }`

### `GET /api/v1/deployment/diagnostics/paths`
`adminOrOp` — Returns resolved FS paths + whether each directory exists

### `GET /api/v1/deployment/diagnostics/esl`
`adminOrOp` — ESL connected status + host + port

### `POST /api/v1/deployment/diagnostics/disable-legacy-extension`
`adminOnly` — Comments out a conflicting `<extension>` block in a dialplan XML file  
**Body:** `{ file: "/etc/freeswitch/dialplan/default.xml", extension_name: "3010" }`

---

# Service Registry (`/api/v1/services`)

### `GET /api/v1/services`
`requireAuth` + `anyRole`  
**Query:** `type=ENS|ERS|IVR&is_active=true`  
**DB:** `emergency_numbers`  
**Purpose:** Emergency number to service-type binding registry

### `GET /api/v1/services/:id`
### `POST /api/v1/services`
`adminOnly`  
**Body:**
```json
{
  "number": "1222",
  "type": "ERS",
  "description": "Main Gate Emergency",
  "ers_configuration_id": 1,
  "is_active": true
}
```

### `PUT /api/v1/services/:id`
### `DELETE /api/v1/services/:id`

---

# Campaigns (`/api/v1/campaigns`)

### `GET /api/v1/campaigns/engine/stats`
`adminOrOp` — Live campaign engine statistics (active calls, pending, queue depth)

### `GET /api/v1/campaigns`
`adminOrOp`  
**Query:** `status=PENDING|RUNNING|COMPLETED|CANCELLED`  
**DB:** `ens_campaigns`

### `GET /api/v1/campaigns/:id`
### `GET /api/v1/campaigns/:id/destinations`
`adminOrOp` — Delivery status per destination

### `POST /api/v1/campaigns`
`adminOrOp`  
**Body:** `{ configuration_id, message?, contacts?: [...] }`  
**Purpose:** Trigger ENS campaign from UI  
**Socket event:** `enrs::campaign_started`

### `POST /api/v1/campaigns/:id/pause`
`adminOrOp` — Pause active campaign  
**Socket event:** `enrs::campaign_paused`

### `POST /api/v1/campaigns/:id/resume`
**Socket event:** `enrs::campaign_resumed`

### `POST /api/v1/campaigns/:id/cancel`
**Socket event:** `enrs::campaign_cancelled`

---

# Dashboard (`/api/v1/dashboard`)

### `GET /api/v1/dashboard/metrics`
`requireAuth`  
**Response:**
```json
{
  "totalContacts": 145,
  "activeIncidents": 2,
  "activeCampaigns": 1,
  "totalConfigurations": 5
}
```

### `GET /api/v1/dashboard/active`
`requireAuth` — Active incidents + active campaigns

### `GET /api/v1/dashboard/chart`
`requireAuth`  
**Query:** `period=week|month|year`  
**Response:** `{ labels: [...], incidents: [...], campaigns: [...] }`

---

# Reports (`/api/v1/reports`)

### `GET /api/v1/reports/notifications`
`canExportReports`  
**Query:** `from=&to=&configuration_id=`

### `GET /api/v1/reports/incidents`
`canExportReports`  
**Query:** `from=&to=`

### `GET /api/v1/reports/contact-usage`
`canExportReports` — Most-called responders

### `GET /api/v1/reports/ers-incidents`
`canExportReports` — ERS-specific incident report with responder answers  
**Query:** `from=&to=&configuration_id=`

### `GET /api/v1/reports/ens-broadcasts`
`canExportReports` — ENS broadcast delivery summary  
**Query:** `from=&to=&configuration_id=`

---

# Settings (`/api/v1/settings`)

### `GET /api/v1/settings`
`adminOnly` — All `system_settings` rows

### `GET /api/v1/settings/test-mode`
`requireAuth` (all roles) — Returns `{ enabled: bool, caller_id: string }`

### `GET /api/v1/settings/emergency-numbers`
`adminOrSuper` — Active emergency numbers (used by IVR Builder BindNumbersModal)

### `PUT /api/v1/settings/:key`
`adminOnly` — Body: `{ value: "..." }` — Upsert a setting by key

### `GET /api/v1/settings/esl/status`
`adminOnly` — ESL connection status

### `GET /api/v1/settings/feature-flags`
`adminOnly` — All feature flags

### `PATCH /api/v1/settings/feature-flags/:key`
`adminOnly` — Body: `{ is_enabled: true|false }`

---

# SIP Gateways (`/api/v1/gateways`)

### `GET /api/v1/gateways`
`requireAuth` — List configured SIP gateways  
**DB:** `sip_gateways`

### `POST /api/v1/gateways`
`adminOrSuper`  
**Body:** `{ name, host, username, password, register: true|false, proxy?, port?, codec? }`

### `PUT /api/v1/gateways/:id`
`adminOrSuper`

### `DELETE /api/v1/gateways/:id`
`adminOrSuper`

### `POST /api/v1/gateways/:id/deploy`
`adminOrSuper`  
**Purpose:** Generates gateway XML → writes to `FS_SIP_PROFILE_DIR` → ESL `sofia profile internal rescan`  
**ESL:** `sofia profile internal rescan`

---

# Monitoring (Conference Operations Center) (`/api/v1/monitoring`)

All endpoints: `requireAuth`. Controls require `adminOrSuper`.

### `GET /api/v1/monitoring/conferences`
`requireAuth` — Returns live conference state from **in-memory registry** (no DB query)  
**Response:**
```json
[{
  "name": "3010",
  "createdAt": "2026-07-17T10:00:00Z",
  "recording": false,
  "locked": false,
  "members": [
    { "id": "1", "callerNum": "7001003", "muted": false, "talking": false, "role": "moderator" }
  ]
}]
```

### `GET /api/v1/monitoring/status`
`requireAuth` — ESL connection status + conference count

### `GET /api/v1/monitoring/debug/conf-sync`
`adminOrSuper` — Forces `xml_list` re-sync for all conferences

---

### Conference-Level Controls

| Method | URL | ESL Command | Purpose |
|---|---|---|---|
| POST | `/monitoring/conferences/:room/lock` | `conference <room> lock` | Lock conference |
| POST | `/monitoring/conferences/:room/unlock` | `conference <room> unlock` | Unlock |
| POST | `/monitoring/conferences/:room/record/start` | `conference <room> record <path>` | Start recording |
| POST | `/monitoring/conferences/:room/record/stop` | `conference <room> norecord <path>` | Stop recording |
| POST | `/monitoring/conferences/:room/play` | `conference <room> play <path>` | Play audio file |
| POST | `/monitoring/conferences/:room/say` | `conference <room> say <text>` | TTS announcement |
| POST | `/monitoring/conferences/:room/invite` | `conference <room> bgdial <dialstr>` | Invite participant |
| DELETE | `/monitoring/conferences/:room` | `conference <room> kick all` | Terminate conference |

### Member-Level Controls

| Method | URL | ESL Command |
|---|---|---|
| POST | `…/members/:id/mute` | `conference <room> mute <id>` |
| POST | `…/members/:id/unmute` | `conference <room> unmute <id>` |
| DELETE | `…/members/:id` | `conference <room> kick <id>` |
| POST | `…/members/:id/deaf` | `conference <room> deaf <id>` |
| POST | `…/members/:id/undeaf` | `conference <room> undeaf <id>` |
| POST | `…/members/:id/volume` | `conference <room> volume_in/out <id> <level>` |
| POST | `…/members/:id/energy` | `conference <room> energy <id> <level>` |
| POST | `…/members/:id/floor` | `conference <room> vid-floor <id>` |
| POST | `…/members/:id/transfer` | `conference <room> transfer <id> <ext> XML default` |

---

# Media Library (`/api/v1/media-library`)

### `GET /api/v1/media-library`
`adminOrOp`  
**Query:** `category=&search=&limit=&page=`  
**DB:** `media_files`

### `GET /api/v1/media-library/categories`
`adminOrOp`

### `POST /api/v1/media-library/upload`
`adminOnly` — `multipart/form-data`: `file`, `category`, `description`, `tags`

### `POST /api/v1/media-library/scan`
`adminOnly` — Scan media directories and import untracked files

### `GET /api/v1/media-library/:id`
### `PUT /api/v1/media-library/:id`
`adminOnly`

### `POST /api/v1/media-library/:id/deploy`
`adminOnly` — Copy file to `FS_SOUND_DIR/enrs/`

### `GET /api/v1/media-library/:id/stream`
`requireAuthOrToken` — Audio stream (Bearer or `?token=`)

### `GET /api/v1/media-library/:id/download`
`requireAuthOrToken`

### `GET /api/v1/media-library/:id/waveform`
`requireAuthOrToken` — Returns JSON peak data for waveform visualizer

### `DELETE /api/v1/media-library/:id`
`adminOnly`

---

# Recordings (`/api/v1/recordings`)

### `GET /api/v1/recordings`
`adminOrOp`  
**Query:** `recording_type=ERS|ENS|IVR|MANUAL&status=&conference_room=&from=&to=`  
**DB:** `recordings` (renamed from `conference_recordings` in migration 026)

### `GET /api/v1/recordings/:id`
`adminOrOp`

### `PUT /api/v1/recordings/:id`
`adminOrOp` — Update metadata (tags, notes)

### `POST /api/v1/recordings/:id/archive`
`adminOrOp` — Mark as archived

### `DELETE /api/v1/recordings/:id`
`adminOrOp` — Soft-delete

### `GET /api/v1/recordings/:id/stream`
`requireAuthOrToken`

### `GET /api/v1/recordings/:id/download`
`requireAuthOrToken`

### `GET /api/v1/recordings/:id/waveform`
`requireAuthOrToken` — Cached in `recordings.waveform_peaks` JSONB column

---

# Health Check

### `GET /api/health`
No auth.  
**Response:** `{ "status": "ok", "service": "fs-enrs", "time": "<ISO>" }`

---

# Internal API — Lua Contract (`/api/v1/internal`)

> **Auth:** `X-Internal-Key: <INTERNAL_API_KEY>`  
> **Rate limit:** 500 req/min  
> **Never expose to WAN**

---

## Service Lookup

### `GET /api/v1/internal/services/:number`
### `GET /api/v1/internal/services?number=<n>`
**Purpose:** Unified entry point — Lua calls this first to determine service type.  
**Controller:** `serviceController.internalServiceLookup()`  
**Response:**
```json
{ "success": true, "type": "ERS", "configuration_id": 1, "name": "Main Gate" }
```

---

## ERS Internal API

### `GET /api/v1/internal/ers/lookup?number=<dest>`
**Purpose:** Full ERS configuration lookup for a dialed number (first call from `dial_911_conference.lua`).  
**Controller:** `ersInternalController.ersLookup()`  
**DB:** `emergency_numbers` JOIN `ers_configurations`  
**Response includes:**
- `primary_bridge_number`, `secondary_bridge_number` (STATIC mode) or generated room names (DYNAMIC mode)
- `conference_profile` (always a valid FS profile name — sanitized by `getConferenceProfile()`)
- `primary_responders`, `secondary_responders` (merged from groups + contacts)
- `conference_type`, `recording_enabled`, `recording_mode`, `recording_trigger`
- `slot`, `group_type`, `can_accept`, `active_conferences`
- `pin_required` (boolean only — raw PIN never returned)

### `GET /api/v1/internal/ers/tier-status`
**Query:** `configuration_id=&tier=primary|secondary`  
**Purpose:** Live member count check (never uses DB status).  
**ESL:** `getConferenceMemberCount(room)`

### `POST /api/v1/internal/ers/ring-all`
**Purpose:** Backend-driven incident creation + ring-all (parallel originate).  
**Body:** `{ configuration_id, caller_number, caller_name?, tier }`  
**Actions:**
1. Checks tier live occupancy (rejoin path)
2. Creates `ers_incidents` row
3. Calls `startRingAll()` (background loop)
4. **Socket event:** `enrs::ers_incident_created`

### `POST /api/v1/internal/ers/overflow/enqueue`
**Purpose:** Queue a caller when both bridges are occupied.  
**Body:** `{ configuration_id, caller_number, caller_name? }`  
**Socket event:** `enrs::ers_queue_changed`

### `GET /api/v1/internal/ers/overflow/poll`
**Query:** `queue_id=`  
**Purpose:** Lua calls every ~3s. Returns `status=ACTIVE` when dequeued.  
**Socket event:** `enrs::ers_queue_changed` (on promotion)

### `POST /api/v1/internal/ers/overflow/cancel`
**Body:** `{ queue_id }`  
**Socket event:** `enrs::ers_queue_changed`

### `GET /api/v1/internal/ers/playback/authorize`
**Query:** `caller_number=`  
**Purpose:** UUUU line: check if caller is authorized to listen (active incident exists)

### `POST /api/v1/internal/ers/incidents`
**Purpose:** Create incident (called from Lua after conference join).  
**Body:**
```json
{
  "configuration_id": 1,
  "caller_number": "7001003",
  "conference_room": "3010",
  "group_type": "primary",
  "status": "ACTIVE"
}
```
**Socket event:** `enrs::ers_incident_created`

### `POST /api/v1/internal/ers/incidents/:uuid/complete`
**Purpose:** Lua calls when caller disconnects.  
**Body:** `{ recording_file?: "/path/to.wav" }`  
**Socket event:** `enrs::ers_incident_ended`

### `PATCH /api/v1/internal/ers/incidents/:uuid/responder`
**Purpose:** Lua logs responder join/answer.  
**Body:** `{ responder_number, status: "INVITED"|"ANSWERED", joined_via? }`  
**Socket event:** `enrs::ers_responder_update`

### `POST /api/v1/internal/ers/incidents/:uuid/observer`
**Body:** `{ observer_number }`  
**Socket event:** `enrs::ers_observer_joined`

### `GET /api/v1/internal/ers/incidents/rejoin`
**Query:** `configuration_id=&caller_number=`  
**Purpose:** Check if caller can rejoin an active incident (STATIC bridge rejoin)

### `GET /api/v1/internal/ers/incidents/open-join`
**Query:** `configuration_id=`

### `GET /api/v1/internal/ers/incidents/:uuid/status`
**Purpose:** Queue hold-loop poll — returns current incident status + conference_room  
**Response:** `{ status: "ACTIVE"|"QUEUED"|"COMPLETED", conference_room: "3010" }`

---

## ENS Internal API

### `GET /api/v1/internal/ens/lookup?number=<n>`
**Purpose:** Full ENS configuration lookup (first call from `blast_call.lua`).  
**Response:** `{ configuration_id, name, pin_required, no_pending_msg, ... }`

### `POST /api/v1/internal/ens/verify-pin`
**Body:** `{ configuration_id, pin }`  
**Purpose:** Validate DTMF PIN. Raw PIN never in lookup response.  
**Response:** `{ valid: true }` or `{ valid: false }`

### `POST /api/v1/internal/ens/campaign/start`
**Purpose:** Lua calls after recording message — launches campaign.  
**Body:** `{ configuration_id, recording_file, caller_number }`  
**Actions:** Creates `ens_campaigns` row → campaign engine picks it up  
**Socket event:** `enrs::ens_started`

### `GET /api/v1/internal/ens/notifications/queue-status`
**Query:** `configuration_id=`

### `POST /api/v1/internal/ens/notifications`
### `GET /api/v1/internal/ens/notifications/:uuid/pending-contacts`
### `PATCH /api/v1/internal/ens/notifications/:uuid/delivery`
**Body:** `{ contact_id, status: "DELIVERED"|"FAILED", answered_at? }`  
**Socket event:** `enrs::ens_delivery`

### `POST /api/v1/internal/ens/notifications/:uuid/complete`
**Socket event:** `enrs::ens_complete`

### `GET /api/v1/internal/ens/campaigns/latest`
**Query:** `configuration_id=`  
**Purpose:** `ENS_retry_playback.lua` calls this to get recording for playback

### `GET /api/v1/internal/ens/campaigns/:id/playback-log`
### `GET /api/v1/internal/ens/callbacks/authorize`
### `POST /api/v1/internal/ens/callbacks`
**Socket event:** `enrs::ens_callback`

---

## IVR Internal API

### `GET /api/v1/internal/ivr/lookup?number=<n>`
**Purpose:** IVR flow lookup — Lua calls to get flow configuration for a dialed number.  
**Controller:** `ivrInternalController.ivrLookup()`  
**Response:** `{ flow_id, entry_node_id, nodes: {...}, tts_engine, ... }`
