# REST API Reference

**Base URL:** `/api/v1/`  
**Transport:** HTTPS (HTTP in development)  
**Content-Type:** `application/json` for all request and response bodies.

---

## Authentication

All routes under `/api/v1/` (except `/auth/login` and `/auth/refresh`) require a valid JWT access token.

**Methods accepted:**
- `Authorization: Bearer <accessToken>` header.
- `accessToken` in the `accessToken` httpOnly cookie (set automatically by `/auth/login`).

**Token lifetime:**
- Access token: 15 minutes (configurable via `system_settings.jwt_access_expiry`).
- Refresh token: 7 days (configurable via `system_settings.jwt_refresh_expiry`), stored as an httpOnly cookie.

**`req.user` shape** (set by `requireAuth` middleware):

```json
{
  "id": 1,
  "email": "admin@enrs.local",
  "role": "ADMIN",
  "tenantId": 1
}
```

---

## Role Hierarchy

Roles in descending order of privilege:

| Role | Description |
|---|---|
| `ADMIN` | Full access to all endpoints including destructive operations. |
| `SUPERVISOR` | Read/write access; can perform conference controls and IVR publishing. |
| `OPERATOR` | Read/write access to operational data; cannot manage system settings. |
| `VIEWER` | Read-only access. |

Named middleware exports in `rbac.js`:

| Export | Allowed roles |
|---|---|
| `adminOnly` | `ADMIN` |
| `adminOrSuper` | `ADMIN`, `SUPERVISOR` |
| `adminOrOp` | `ADMIN`, `SUPERVISOR`, `OPERATOR` |
| `requireRole(...)` | Specified roles only |

---

## Standard Response Formats

### Paginated List

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

> **Important:** List calls that populate dropdowns must pass `limit: 1000` to avoid truncation at the default 20-row limit.

### Error

```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": [{ "field": "email", "message": "Required" }]
}
```

### Standard HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Resource created |
| `204` | Success, no body |
| `400` | Validation error or malformed request |
| `401` | Authentication required or token expired |
| `403` | Insufficient role |
| `404` | Resource not found |
| `409` | Conflict — unique violation (PG `23505`) or FK violation (PG `23503`) |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Authentication (`/auth`)

### `POST /auth/login`

Rate-limited: 10 requests per 15 minutes per IP.

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | `string` | Yes | — |
| `password` | `string` | Yes | — |

**Response `200`:**

```json
{
  "accessToken": "eyJ...",
  "user": {
    "id": 1,
    "email": "admin@enrs.local",
    "role": "ADMIN",
    "tenantId": 1
  },
  "expiresIn": "15m"
}
```

Sets an httpOnly `refreshToken` cookie (7 days, Secure, SameSite=Strict).

**Response `401`:** `{ "error": "Invalid credentials" }` on bad password or unknown email.

**Response `403`:** `{ "error": "Account locked" }` when `locked_until` is in the future.

---

### `POST /auth/refresh`

Reads the `refreshToken` httpOnly cookie and issues a new access token.

**Request:** No body required.

**Response `200`:**

```json
{ "accessToken": "eyJ..." }
```

**Response `401`:** Cookie absent, token expired, or `refresh_token_hash` has been nulled (logout).

---

### `POST /auth/logout`

Requires authentication. Clears the refresh cookie and nulls `refresh_token_hash` in the database.

**Request:** No body required.

**Response `200`:** `{ "ok": true }`

---

### `GET /auth/me`

Requires authentication.

**Response `200`:**

```json
{
  "id": 1,
  "email": "admin@enrs.local",
  "full_name": "System Administrator",
  "role": "ADMIN",
  "tenantId": 1,
  "is_active": true
}
```

---

### `POST /auth/change-password`

Requires authentication.

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `currentPassword` | `string` | Yes | Must match the current `password_hash`. |
| `newPassword` | `string` | Yes | Must not match any entry in `password_history`. |
| `confirmPassword` | `string` | Yes | Must equal `newPassword`. |

**Response `204`:** No body.

**Response `400`:** `{ "error": "Current password is incorrect" }` or `{ "error": "Password was recently used" }`.

---

## Users (`/users`)

All routes require `ADMIN` role (`adminOnly`).

### `GET /users`

**Query parameters:**

| Parameter | Type | Notes |
|---|---|---|
| `page` | `integer` | Default: `1` |
| `limit` | `integer` | Default: `20` |
| `role` | `string` | Filter by role. |
| `active` | `boolean` | Filter by `is_active`. |

**Response `200`:** Paginated list envelope with user objects.

---

### `GET /users/:id`

**Response `200`:** Single user object.  
**Response `404`:** User not found.

---

### `POST /users`

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | `string` | Yes | Must be unique. |
| `fullName` | `string` | Yes | — |
| `role` | `string` | Yes | `ADMIN`, `SUPERVISOR`, `OPERATOR`, or `VIEWER`. |
| `password` | `string` | Yes | — |
| `tenantId` | `integer` | No | Defaults to `req.user.tenantId`. |

**Response `201`:** Created user object.

---

### `PUT /users/:id`

**Request:** Partial user object. All fields optional.

**Response `200`:** Updated user object.

---

### `DELETE /users/:id`

Soft-deletes the user by setting `deleted_at`.

**Response `200`:** `{ "ok": true }`

---

## Organizations (`/organizations`)

`adminOrOp` for reads; `adminOnly` for writes.

### `GET /organizations`

Returns organizations scoped to `req.user.tenantId`.

**Query parameters:** `page`, `limit`, `active`.

**Response `200`:** Paginated list.

---

### `GET /organizations/:id`

**Response `200`:** Single organization object.

---

### `POST /organizations`

`tenant_id` is always set from `req.user.tenantId` — the request body value is ignored.

**Request:**

| Field | Type | Required |
|---|---|---|
| `name` | `string` | Yes |
| `slug` | `string` | No |
| `code` | `string` | No |
| `description` | `string` | No |
| `address` | `string` | No |
| `phone` | `string` | No |
| `email` | `string` | No |

**Response `201`:** Created organization object.

---

### `PUT /organizations/:id`

**Request:** Partial organization object.

**Response `200`:** Updated organization object.

---

### `DELETE /organizations/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

## Emergency Contacts (`/contacts`)

`adminOrOp` for reads; `adminOnly` for writes.

### `GET /contacts`

**Query parameters:** `page`, `limit`, `org_id`, `active`, `search`.

**Response `200`:** Paginated list of contacts.

---

### `GET /contacts/:id`

**Response `200`:** Single contact object.

---

### `POST /contacts`

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `organization_id` | `integer` | Yes | — |
| `first_name` | `string` | Yes | — |
| `last_name` | `string` | Yes | — |
| `mobile_number` | `string` | Yes | — |
| `role` | `string` | No | — |
| `location_id` | `integer` | No | — |
| `department_id` | `integer` | No | — |
| `internal_extension` | `string` | No | — |
| `extension_number` | `string` | No | Dialed alongside mobile for ENS dual-channel blasts. |
| `email` | `string` | No | — |
| `gateway_id` | `integer` | No | Per-contact SIP gateway override. |

**Response `201`:** Created contact object.

---

### `PUT /contacts/:id`

**Request:** Partial contact object.

**Response `200`:** Updated contact object.

---

### `DELETE /contacts/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `POST /contacts/bulk-upload`

Upload contacts via CSV. Multipart `form-data`. Maximum file size: 5 MB.

**Form fields:**

| Field | Notes |
|---|---|
| `file` | CSV file. Required columns: `first_name`, `last_name`, `mobile_number`. |
| `organization_id` | Target organization ID. |

**Response `200`:**

```json
{
  "imported": 42,
  "skipped": 3,
  "errors": [{ "row": 7, "error": "Invalid mobile_number" }]
}
```

---

## Responder Groups (`/groups`)

`adminOrOp` for reads; `adminOnly` for writes.

### `GET /groups`

**Query parameters:** `page`, `limit`, `org_id`.

**Response `200`:** Paginated list.

---

### `GET /groups/:id`

**Response `200`:** Group object with member count.

---

### `POST /groups`

**Request:** `{ organization_id, name, description? }`

**Response `201`:** Created group.

---

### `PUT /groups/:id`

**Request:** Partial group object.

**Response `200`:** Updated group.

---

### `DELETE /groups/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `POST /groups/:id/members`

Add a contact to a group.

**Request:**

| Field | Type | Required |
|---|---|---|
| `contactId` | `integer` | Yes |

**Response `201`:** `{ "ok": true }`

**Response `409`:** Contact already a member.

---

### `DELETE /groups/:id/members/:contactId`

Remove a contact from a group.

**Response `200`:** `{ "ok": true }`

---

## ENS Configurations (`/ens`)

`adminOrOp` for reads; `adminOnly` for writes.

### `GET /ens/configurations`

**Response `200`:** List of ENS configurations for the current tenant.

---

### `GET /ens/configurations/:id`

**Response `200`:** ENS configuration with associated contacts and groups.

---

### `POST /ens/configurations`

**Request:** ENS configuration object. Key fields:

| Field | Type | Notes |
|---|---|---|
| `organization_id` | `integer` | Required. |
| `name` | `string` | Required. |
| `pin` | `string` | Optional PIN gatekeeping. |
| `blast_clid` | `string` | Caller ID shown to blast recipients. |
| `reply_clid` | `string` | Caller ID for callback replay. |
| `destination_number` | `string` | Trigger number (must be unique across active configs). |
| `max_concurrent_calls` | `integer` | Default: 30. |
| `calls_per_second` | `number` | Default: 2.0. |
| `max_attempts` | `integer` | Default: 3. |
| `retry_interval_sec` | `integer` | Default: 60. |

**Response `201`:** Created configuration.

---

### `PUT /ens/configurations/:id`

**Request:** Partial configuration object.

**Response `200`:** Updated configuration.

---

### `PATCH /ens/configurations/:id/toggle`

Toggle `is_active` for the configuration.

**Response `200`:** `{ "is_active": true }`

---

### `DELETE /ens/configurations/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `GET /ens/notifications`

**Query parameters:** `from` (date), `to` (date), `status`, `page`, `limit`.

**Response `200`:** Paginated list of notification records.

---

### `POST /ens/notifications`

Manually create a notification (UI/API trigger).

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `configuration_id` | `integer` | Yes | — |
| `triggered_via` | `string` | No | `UI` or `API`. Default: `API`. |
| `caller_number` | `string` | No | — |
| `recording_file` | `string` | No | Path to pre-recorded message. |

**Response `201`:** `{ "notification_uuid": "...", "notification_id": 1 }`

---

## ERS Configurations (`/ers`)

`adminOrOp` for reads; `adminOnly` for writes.

### `GET /ers/configurations`

**Response `200`:** List of ERS configurations for the current tenant.

---

### `GET /ers/configurations/:id`

**Response `200`:** Full ERS configuration including tier groups and tier contacts.

---

### `POST /ers/configurations`

**Request:** ERS configuration object. Key fields:

| Field | Type | Notes |
|---|---|---|
| `organization_id` | `integer` | Required. |
| `name` | `string` | Required. |
| `primary_bridge_number` | `string` | Conference room name for primary tier (STATIC mode). |
| `secondary_bridge_number` | `string` | Conference room name for secondary tier (STATIC mode). |
| `conference_type` | `string` | `STATIC` or `DYNAMIC`. Default: `STATIC`. |
| `max_concurrent_conferences` | `integer` | Default: 2. |
| `queue_enabled` | `boolean` | Default: true. |
| `record_conferences` | `boolean` | Enable Lua per-channel recording. |
| `recording_enabled` | `boolean` | Enable backend ESL conference recording. |
| `recording_mode` | `string` | `AUTO` or `MANUAL`. |

**Response `201`:** Created configuration.

---

### `PUT /ers/configurations/:id`

**Request:** Partial configuration object.

**Response `200`:** Updated configuration.

---

### `PATCH /ers/configurations/:id/toggle`

**Response `200`:** `{ "is_active": true }`

---

### `DELETE /ers/configurations/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `GET /ers/configurations/:id/tier-groups`

Returns current primary and secondary tier assignments (both groups and individual contacts).

**Response `200`:**

```json
{
  "primary": {
    "groups": [{ "id": 1, "name": "Security Team" }],
    "contacts": [{ "id": 5, "first_name": "Alice", "last_name": "Wong" }]
  },
  "secondary": {
    "groups": [],
    "contacts": []
  }
}
```

---

### `PUT /ers/configurations/:id/tier-groups`

Replace all tier assignments atomically.

**Request:**

```json
{
  "primary":   { "group_ids": [1, 2], "contact_ids": [5] },
  "secondary": { "group_ids": [3],    "contact_ids": [] }
}
```

**Response `200`:** Updated tier assignments.

---

### `GET /ers/incidents`

**Query parameters:** `page`, `limit`, `from`, `to`, `status`, `org_id`.

**Response `200`:** Paginated list of incidents.

---

### `GET /ers/incidents/:uuid/detail`

**Response `200`:** Full incident with responders and participants.

---

### `GET /ers/incidents/:id/responders`

**Response `200`:** List of `ers_incident_responders` rows for the incident.

---

### `POST /ers/incidents/:uuid/complete`

Mark an active incident as COMPLETED from the UI (supervisor action).

**Response `200`:** `{ "ok": true }`

---

### `POST /ers/incidents/:uuid/cancel`

Cancel a QUEUED incident.

**Response `200`:** `{ "ok": true }`

---

### `GET /ers/queue`

Returns all currently QUEUED incidents.

**Response `200`:** `{ "queue": [...] }`

---

### `GET /ers/conference/:room/members`

Returns live member list from the in-memory conference registry for the given room.

**Response `200`:** `{ "members": [...] }`

---

### `POST /ers/conference/:room/kick`

Kick a member from a conference (supervisor action).

**Request:** `{ "member_id": "1" }`

**Response `200`:** `{ "ok": true }`

---

### `POST /ers/conference/:room/mute`

Mute a member.

**Request:** `{ "member_id": "1" }`

**Response `200`:** `{ "ok": true }`

---

### `POST /ers/conference/:room/play`

Play an audio file into a conference.

**Request:** `{ "audio_path": "/path/to/file.wav" }`

**Response `200`:** `{ "ok": true }`

---

## IVR Flows (`/ivr`)

### `GET /ivr/node-types`

Returns the public IVR node type registry — type names, labels, config schemas, and icon hints. Does not include Lua source code.

Requires authentication. No role restriction.

**Response `200`:**

```json
{
  "nodeTypes": [
    { "type": "play_audio", "label": "Play Audio", "configSchema": {...} }
  ]
}
```

---

### `GET /ivr/flows`

Requires authentication. All roles.

**Query parameters:** `page`, `limit`, `org_id`.

**Response `200`:** Paginated list of IVR flows.

---

### `GET /ivr/flows/:uuid`

**Response `200`:** Full flow object including `graph` JSONB.

**Response `400`:** Returned immediately by the `router.param('uuid', ...)` guard when the UUID format is invalid — the DB is never queried.

---

### `GET /ivr/flows/:uuid/versions`

**Response `200`:** List of published versions (summary, no full `graph`).

---

### `GET /ivr/flows/:uuid/versions/:vnum`

Retrieve a specific published version. Use to restore a flow to a prior snapshot.

**Response `200`:** Version object including the snapshot `graph`.

---

### `POST /ivr/flows`

Requires `ADMIN` or `SUPERVISOR`.

**Request:**

| Field | Type | Required |
|---|---|---|
| `name` | `string` | Yes |
| `organization_id` | `integer` | No |
| `description` | `string` | No |
| `graph` | `object` | No. Default: `{}`. |

**Response `201`:** Created flow with `flow_uuid`.

---

### `PUT /ivr/flows/:uuid`

Requires `ADMIN` or `SUPERVISOR`. Updates the working graph in-place (does not create a version).

**Request:** `{ name?, description?, graph?, is_active? }`

**Response `200`:** Updated flow.

---

### `DELETE /ivr/flows/:uuid`

Requires `ADMIN` or `SUPERVISOR`. Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `POST /ivr/flows/:uuid/validate`

Requires `ADMIN` or `SUPERVISOR`. Runs `ivrGraphValidator.js` against the current graph without publishing.

**Response `200`:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["Unreachable node: node_abc"],
  "stats": { "nodeCount": 5, "edgeCount": 4 }
}
```

---

### `POST /ivr/flows/:uuid/publish`

Requires `ADMIN` or `SUPERVISOR`. Creates an immutable `ivr_flow_versions` snapshot at `version_number + 1`.

**Request:** `{ "change_notes": "Optional release notes" }`

**Response `201`:** `{ "version_number": 3, "version_uuid": "..." }`

**Response `400`:** Validation failed — flow is invalid and cannot be published.

---

### `PATCH /ivr/flows/:uuid/bind`

Requires `ADMIN` or `SUPERVISOR`. Binds an `emergency_numbers` entry to this flow.

**Request:** `{ "number_id": 7 }`

**Response `200`:** `{ "ok": true }`

---

### `PATCH /ivr/flows/:uuid/unbind`

Requires `ADMIN` or `SUPERVISOR`. Removes the `ivr_flow_id` FK from the bound `emergency_numbers` row.

**Response `200`:** `{ "ok": true }`

---

### `GET /ivr/flows/templates`

List available IVR templates.

**Response `200`:** List of `ivr_templates` rows.

---

### `POST /ivr/flows/templates/:id/create`

Requires `ADMIN` or `SUPERVISOR`. Instantiate a new flow from a template.

**Request:** `{ "name": "My Flow", "organization_id": 1 }`

**Response `201`:** Created flow (same shape as `POST /ivr/flows`).

---

## Deployment (`/deployment`)

`adminOrOp` for reads and previews; `adminOnly` for mutating operations.

### Audio Library

#### `GET /deployment/audio`

**Response `200`:** List of audio files with metadata.

#### `GET /deployment/audio/categories`

**Response `200`:** `{ "categories": ["general","announcement","hold_music","ivr_prompt","recording"] }`

#### `POST /deployment/audio/upload`

`adminOnly`. Multipart upload. Validates MIME type and file size.

**Form fields:** `file` (audio file), `name`, `category`, `organization_id?`, `description?`.

**Response `201`:** Created audio library record.

#### `POST /deployment/audio/:id/deploy`

`adminOnly`. Copies the audio file to the configured FreeSWITCH sound paths.

**Response `200`:** `{ "ok": true, "path": "/usr/share/freeswitch/sounds/..." }`

#### `GET /deployment/audio/:id/stream`

Stream audio for in-browser preview. Authenticated via JWT or `?token=` query parameter.

#### `DELETE /deployment/audio/:id`

`adminOnly`. Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### Flow Deployment

#### `GET /deployment/flows`

Returns all IVR flows with deployment status (deployed version vs. current version).

**Response `200`:** `{ "flows": [{ "flow_uuid": "...", "deployed_version": 2, "current_version": 3 }] }`

#### `GET /deployment/flows/:uuid/preview`

Preview what Lua and XML will be generated without writing to disk.

**Response `200`:** `{ "lua": "...", "xml": "..." }`

#### `POST /deployment/flows/:uuid/deploy`

`adminOnly`. Full deployment pipeline:
1. Validate the published graph.
2. Generate Lua script.
3. Generate FreeSWITCH XML dialplan fragment.
4. Write files to FreeSWITCH filesystem paths (resolved by `freeSwitchPathService.js`).
5. Send `reloadxml` via ESL.
6. Verify the deployed dialplan.

**Response `200`:** `{ "ok": true, "version": 3, "lua_path": "...", "xml_path": "..." }`

**Response `400`:** Flow is not published or validation failed.

#### `GET /deployment/flows/:uuid/history`

**Response `200`:** List of deployment history records.

#### `POST /deployment/redeploy-all`

`adminOnly`. Regenerate Lua + XML for all published flows and send `reloadxml`.

**Response `200`:** `{ "deployed": 5, "failed": 0 }`

---

### Diagnostics

#### `GET /deployment/diagnostics`

Run the full diagnostics suite: ESL connection health, FreeSWITCH version, path existence and write permissions, deployed dialplan integrity.

**Response `200`:**

```json
{
  "esl": { "connected": true, "version": "1.10.7" },
  "paths": { "/usr/share/freeswitch/scripts": { "exists": true, "writable": true } },
  "conflicts": []
}
```

#### `POST /deployment/diagnostics/reloadxml`

`adminOnly`. Force FreeSWITCH to reload XML configuration via ESL `reloadxml`.

**Response `200`:** `{ "ok": true }`

#### `GET /deployment/diagnostics/paths`

Returns all resolved FreeSWITCH filesystem paths from `freeSwitchPathService.js`.

**Response `200`:** `{ "scripts": "...", "sounds": "...", "dialplan": "..." }`

#### `GET /deployment/diagnostics/esl`

ESL connection health check.

**Response `200`:** `{ "connected": true, "host": "127.0.0.1", "port": 8021 }`

---

## Campaigns (`/campaigns`)

`adminOrOp` required for all routes.

### `GET /campaigns/engine/stats`

Returns campaign engine state.

**Response `200`:**

```json
{
  "active_campaigns": 1,
  "is_running": true,
  "campaign_ids": ["3fa85f64-..."]
}
```

---

### `GET /campaigns`

**Query parameters:** `page`, `limit`, `status`, `from`, `to`.

**Response `200`:** Paginated list of campaigns.

---

### `GET /campaigns/:id`

**Response `200`:** Campaign detail including running statistics.

---

### `GET /campaigns/:id/destinations`

**Query parameters:** `page`, `limit`, `status`.

**Response `200`:** Paginated list of `ens_campaign_destinations` rows.

---

### `POST /campaigns`

Manually trigger a new campaign.

**Request:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `configuration_id` | `integer` | Yes | ENS configuration to use. |
| `recording_file` | `string` | Cond. | Required if `message_text` not provided. |
| `message_text` | `string` | Cond. | Required if `recording_file` not provided. |
| `triggered_via` | `string` | No | `UI`, `API`, or `SCHEDULE`. Default: `API`. |

**Response `201`:** Campaign object.

---

### `POST /campaigns/:id/pause`

**Response `200`:** `{ "ok": true, "status": "paused" }`

---

### `POST /campaigns/:id/resume`

**Response `200`:** `{ "ok": true, "status": "running" }`

---

### `POST /campaigns/:id/cancel`

**Response `200`:** `{ "ok": true, "status": "cancelled" }`

---

## Monitoring (`/monitoring`)

All routes require authentication. Conference controls require `adminOrSuper`.

### `GET /monitoring/conferences`

Returns all active conferences from the in-memory conference registry, including per-member details (mute state, floor, energy level, call UUID).

**Response `200`:**

```json
{
  "conferences": [
    {
      "name": "ers_3010_p",
      "memberCount": 3,
      "members": [{ "id": "1", "caller_id_number": "...", "mute": false }]
    }
  ]
}
```

---

### `GET /monitoring/status`

ESL connection status and total active conference count.

**Response `200`:** `{ "eslConnected": true, "conferenceCount": 2 }`

---

### Conference-Level Controls

All require `adminOrSuper`. Body: `{ "room": "<room_name>" }` (room name also in URL path).

| Method | Path | Action |
|---|---|---|
| `POST` | `/monitoring/conferences/:room/lock` | Lock the conference. |
| `POST` | `/monitoring/conferences/:room/unlock` | Unlock the conference. |
| `POST` | `/monitoring/conferences/:room/record/start` | Start backend ESL recording. |
| `POST` | `/monitoring/conferences/:room/record/stop` | Stop backend ESL recording. |
| `POST` | `/monitoring/conferences/:room/play` | Play audio file into conference. Body: `{ "audio_path": "..." }` |
| `POST` | `/monitoring/conferences/:room/say` | Speak TTS text into conference. Body: `{ "text": "...", "voice"?: "..." }` |
| `POST` | `/monitoring/conferences/:room/invite` | Invite an external number. Body: `{ "number": "...", "gateway"?: "..." }` |
| `DELETE` | `/monitoring/conferences/:room` | Terminate (destroy) the conference. |

**Response `200`:** `{ "ok": true }` for all controls.

---

### Member-Level Controls

All require `adminOrSuper`. `:memberId` is the FreeSWITCH member ID string.

| Method | Path | Action |
|---|---|---|
| `POST` | `/monitoring/conferences/:room/members/:memberId/mute` | Mute the member. |
| `POST` | `/monitoring/conferences/:room/members/:memberId/unmute` | Unmute the member. |
| `DELETE` | `/monitoring/conferences/:room/members/:memberId` | Kick the member. |
| `POST` | `/monitoring/conferences/:room/members/:memberId/deaf` | Deaf the member (no conference audio). |
| `POST` | `/monitoring/conferences/:room/members/:memberId/undeaf` | Restore audio. |
| `POST` | `/monitoring/conferences/:room/members/:memberId/volume` | Set output volume. Body: `{ "level": 2 }` |
| `POST` | `/monitoring/conferences/:room/members/:memberId/energy` | Set energy threshold. Body: `{ "level": 200 }` |
| `POST` | `/monitoring/conferences/:room/members/:memberId/floor` | Grant conference floor. |
| `POST` | `/monitoring/conferences/:room/members/:memberId/transfer` | Transfer to another room. Body: `{ "destination": "other_room" }` |
| `POST` | `/monitoring/conferences/:room/members/:memberId/moderator` | Promote to moderator. |

**Response `200`:** `{ "ok": true }` for all controls.

---

## Recordings (`/recordings`)

`adminOrOp` for list/detail/mutation. Streaming routes accept `?token=` for `<audio src>` compatibility.

### `GET /recordings`

**Query parameters:** `type` (`ERS`|`ENS`|`IVR`|`MANUAL`), `from`, `to`, `status`, `page`, `limit`.

**Response `200`:** Paginated list of recordings.

---

### `GET /recordings/:id`

**Response `200`:** Single recording detail.

---

### `PUT /recordings/:id`

Update metadata (notes, status, participant snapshot).

**Request:** Partial recording object.

**Response `200`:** Updated recording.

---

### `POST /recordings/:id/archive`

Mark the recording as `ARCHIVED`.

**Response `200`:** `{ "ok": true }`

---

### `DELETE /recordings/:id`

Soft-delete.

**Response `200`:** `{ "ok": true }`

---

### `GET /recordings/:id/stream`

Stream audio. Accepts `Authorization: Bearer` header or `?token=<accessToken>` query parameter (for `<audio src>` tags).

**Response `200`:** Audio stream with appropriate `Content-Type`.

---

### `GET /recordings/:id/download`

Download audio file. Same auth as stream.

**Response `200`:** Audio file with `Content-Disposition: attachment`.

---

### `GET /recordings/:id/waveform`

Returns the pre-computed waveform peak data.

**Response `200`:** `{ "peaks": [...] }`

---

## Reports (`/reports`)

All routes require `adminOrOp`.

### `GET /reports/ers`

ERS incident summary with responder and participant counts. Paginated.

**Query parameters:** `page`, `limit`, `from`, `to`, `status`, `org_id`.

**Response `200`:**

```json
{
  "incidents": [
    {
      "incident_uuid": "...",
      "status": "COMPLETED",
      "caller_number": "100",
      "started_at": "...",
      "duration_seconds": 420,
      "responder_count": 3,
      "answered_count": 2,
      "ers_name": "Security Bridge",
      "org_name": "Head Office"
    }
  ],
  "total": 50,
  "page": 1,
  "limit": 50
}
```

---

### `GET /reports/ers/:incidentUuid`

Full incident detail: incident metadata + all participants (timeline) + all responders (dispatch record) + linked recording.

**Response `200`:**

```json
{
  "incident": {
    "incident_uuid": "...",
    "participants": [
      {
        "name": "Alice Wong",
        "number": "1001",
        "role": "responder",
        "joined_at": "...",
        "left_at": "...",
        "rejoined_at": null
      }
    ],
    "responders": [...],
    "recording": { "id": "...", "duration_sec": 420 }
  }
}
```

---

### `GET /reports/ens`

ENS broadcast summary. Paginated.

**Query parameters:** `page`, `limit`, `from`, `to`, `status`, `org_id`.

**Response `200`:**

```json
{
  "notifications": [
    {
      "notification_uuid": "...",
      "total_targets": 50,
      "total_answered": 43,
      "total_no_answer": 7,
      "ens_name": "Blast Line A",
      "triggered_by_name": "John Smith"
    }
  ],
  "total": 12,
  "page": 1,
  "limit": 50
}
```

---

### `GET /reports/ens/:notificationUuid`

Full notification detail including per-contact delivery breakdown.

**Response `200`:**

```json
{
  "notification": {
    "notification_uuid": "...",
    "deliveries": [
      {
        "contact_number": "0412000001",
        "name": "Bob Smith",
        "delivery_status": "ANSWERED",
        "attempt_number": 1,
        "answered_at": "...",
        "hangup_cause": null
      }
    ]
  }
}
```

---

### `GET /reports/notifications`

Flat list of ENS notifications with configuration and organization names. Up to 500 rows.

**Query parameters:** `from`, `to`, `status`, `org_id`.

**Response `200`:** `{ "notifications": [...] }`

---

### `GET /reports/incidents`

Flat list of ERS incidents with responder counts. Up to 500 rows.

**Query parameters:** `from`, `to`, `status`, `org_id`.

**Response `200`:** `{ "incidents": [...] }`

---

### `GET /reports/contact-usage`

Contact utilization report: how many ENS configurations and ERS incidents each contact is associated with.

**Response `200`:**

```json
{
  "contacts": [
    {
      "id": 1,
      "first_name": "Alice",
      "last_name": "Wong",
      "ens_direct_configs": 2,
      "ens_group_configs": 1,
      "ers_incidents": 5
    }
  ]
}
```

---

### `GET /reports/ers-incidents`

Detailed ERS incident report with per-participant join/leave/rejoin timelines. Up to 200 rows.

**Query parameters:** `from`, `to`.

**Response `200`:** `{ "incidents": [{ ..., "participants": [...] }] }`

---

### `GET /reports/ens-broadcasts`

Detailed ENS broadcast report with per-contact delivery rows and playback access log. Up to 200 rows.

**Query parameters:** `from`, `to`.

**Response `200`:** `{ "broadcasts": [...], "playback_access_log": [...] }`

---

## Internal API (`/api/v1/internal`)

The internal API is a completely separate route surface used exclusively by FreeSWITCH Lua scripts. It is **not** protected by JWT — it uses a shared secret instead.

**Authentication:** `X-Internal-Key: <INTERNAL_API_KEY>` header (timing-safe comparison).  
**Rate limit:** 500 requests per minute (separate limit pool from the UI API).  
**Implementation:** `backend/src/middleware/internalAuth.js` + `backend/src/controllers/internal/`.

> Do not mix `requireAuth` and `requireInternalKey` middleware between the two API surfaces.

---

### IVR Internal (`/internal/ivr`)

#### `GET /internal/ivr/lookup`

Called by the Lua IVR handler to fetch the flow graph for a dialled number.

**Query parameters:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `number` | `string` | Yes | Dialled number to look up in `emergency_numbers` (type = `IVR`). |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "flow_uuid": "3fa85f64-...",
    "entry_node_id": "node_001",
    "nodes": {
      "node_001": { "type": "play_audio", "label": "Welcome", "config": {...}, "next": "node_002" }
    }
  }
}
```

**Response `404`:** `{ "success": false, "error": "IVR number not found" }`

---

### ERS Internal (`/internal/ers`)

#### `GET /internal/ers/lookup`

First call from `ers_conference_bridge.lua`. Returns everything Lua needs to manage a conference incident.

**Query parameters:**

| Parameter | Type | Required |
|---|---|---|
| `number` | `string` | Yes |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "configuration_id": 1,
    "name": "Security Bridge",
    "primary_bridge_number": "3010",
    "secondary_bridge_number": "3011",
    "conference_profile": "default",
    "conference_room_prefix": "ers",
    "conference_type": "STATIC",
    "max_concurrent_conferences": 2,
    "max_conference_duration_min": 0,
    "primary_responders": ["0412000001", "0412000002"],
    "secondary_responders": ["0412000003"],
    "primary_retry_count": 3,
    "primary_retry_interval_sec": 30,
    "secondary_retry_count": 3,
    "secondary_retry_interval_sec": 30,
    "retry_ring_count": 3,
    "retry_ring_interval": 30,
    "queue_enabled": true,
    "queue_announcement_audio": null,
    "queue_music_path": null,
    "queue_hold_audio": null,
    "queue_timeout_sec": 0,
    "record_conferences": false,
    "recording_directory": null,
    "recording_enabled": false,
    "recording_mode": "MANUAL",
    "recording_trigger": "CONFERENCE_CREATED",
    "recording_format": "wav",
    "pin_required": false,
    "allow_rejoin": true,
    "cli_authentication": false,
    "active_conferences": 0,
    "slot": 1,
    "group_type": "primary",
    "can_accept": true
  }
}
```

`slot` and `group_type` encode which conference bridge Lua should use. `can_accept` being `false` means all slots are occupied and Lua should enqueue the caller.

**Response `404`:** `{ "success": false, "error": "ERS number not found" }`

---

#### `GET /internal/ers/tier-status`

Returns live member occupancy per tier. Used before initiating ring-all to avoid double-ringing an occupied bridge.

**Query parameters:**

| Parameter | Type | Required |
|---|---|---|
| `configuration_id` | `integer` | Yes |

**Response `200`:**

```json
{
  "primary":   { "room": "3010", "member_count": 2, "occupied": true },
  "secondary": { "room": "3011", "member_count": 0, "occupied": false }
}
```

---

#### `POST /internal/ers/ring-all`

Simultaneous dial-all to tier responders (or rejoin path if the conference is already active).

**Request body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `configuration_id` | `integer` | Yes | — |
| `incident_uuid` | `string` | Yes | UUID of the existing incident. |
| `conference_room` | `string` | Yes | Target conference room name. |
| `tier` | `string` | Yes | `primary` or `secondary`. |
| `caller_number` | `string` | Yes | Initiating caller's number. |

**Response `200`:**

```json
{
  "success": true,
  "rejoin": false,
  "incident_uuid": "...",
  "conference_room": "3010",
  "responders_dialed": 3
}
```

---

#### `POST /internal/ers/overflow/enqueue`

Called when all conference slots are occupied. Creates a QUEUED incident and returns a queue position.

**Request body:**

| Field | Type | Required |
|---|---|---|
| `configuration_id` | `integer` | Yes |
| `caller_number` | `string` | Yes |
| `caller_name` | `string` | No |
| `destination_number` | `string` | No |

**Response `200`:**

```json
{
  "queue_id": 5,
  "position": 2,
  "incident_uuid": "..."
}
```

---

#### `GET /internal/ers/overflow/poll`

Lua hold-loop polls this endpoint (approximately every 3 seconds) while a caller is queued. Returns `ready: true` when the queued incident has been promoted to ACTIVE.

**Query parameters:** `queue_id` (integer).

**Response `200`:**

```json
{ "ready": false, "position": 2, "conference_room": null }
```

or when promoted:

```json
{ "ready": true, "position": 0, "conference_room": "3010" }
```

---

#### `POST /internal/ers/overflow/cancel`

Caller hung up while queued. Cancels the queue entry and the associated incident.

**Request body:** `{ "queue_id": 5 }`

**Response `200`:** `{ "success": true }`

---

#### `GET /internal/ers/playback/authorize`

Authorizes a caller on the ERS playback/observer line.

**Query parameters:** `caller` (string), `configuration_id` (integer).

**Response `200`:**

```json
{ "authorized": true, "role": "observer" }
```

or:

```json
{ "authorized": false, "reason": "not_in_authorized_list" }
```

---

#### `POST /internal/ers/incidents`

Create a new incident record. Called by `ers_conference_bridge.lua` immediately after the initiating caller enters the conference.

**Request body (validated with Zod `IncidentCreateSchema`):**

| Field | Type | Required | Validation |
|---|---|---|---|
| `configuration_id` | `integer` | Yes | Positive integer. |
| `caller_number` | `string` | Yes | 7–32 characters. |
| `caller_name` | `string` | No | Max 128 characters. |
| `conference_room` | `string` | Yes | `/^[a-z0-9_]{1,64}$/` |
| `group_type` | `string` | Yes | `primary` or `secondary`. |
| `recording_path` | `string` | No | Max 512 characters. |
| `status` | `string` | No | `ACTIVE` or `QUEUED`. Default: `ACTIVE`. |

**Response `201`:**

```json
{
  "incident_id": 42,
  "incident_uuid": "3fa85f64-..."
}
```

Emits `enrs::ers_incident_created` Socket.IO event.

---

#### `POST /internal/ers/incidents/:uuid/complete`

Mark an incident as COMPLETED. Automatically promotes the next queued entry if one exists.

**Request body (Zod `IncidentCompleteSchema`):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `recording_file` | `string` | No | Path to Lua record_session output. Registers in `recordings` table. |

**Response `200`:** `{ "ok": true }`

Emits `enrs::ers_incident_ended` Socket.IO event.

---

#### `PATCH /internal/ers/incidents/:uuid/responder`

Update responder join/miss/rejoin status for an incident. Upserts on `(ers_incident_id, mobile_number)`.

**Request body (Zod `ResponderUpdateSchema`):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `responder_number` | `string` | Yes | 7–32 characters. Resolved to `emergency_contact_id` via last-9-digit fuzzy match. |
| `status` | `string` | Yes | `JOINED`, `MISSED`, or `REJOINED`. |
| `joined_at` | `string` (ISO 8601) | No | — |
| `joined_via` | `string` | No | e.g. `ring_all`, `rejoin`. Max 32 characters. |
| `role` | `string` | No | `primary` or `secondary`. |

**Response `200`:** `{ "ok": true }` or `{ "ok": true, "skipped": true }` when the mobile number cannot be resolved to a known contact.

Emits `enrs::ers_responder_update` Socket.IO event.

---

#### `POST /internal/ers/incidents/:uuid/observer`

Log an anonymous observer join (open-access or playback line).

**Request body (Zod `ObserverSchema`):**

| Field | Type | Required |
|---|---|---|
| `observer_number` | `string` | Yes |
| `joined_via` | `string` | No |
| `joined_at` | `string` (ISO 8601) | No |

**Response `200`:** `{ "ok": true }`

---

#### `GET /internal/ers/incidents/rejoin`

Lua calls this when a caller dials the rejoin number. Verifies the caller is an authorized tier responder and returns the active conference room.

**Query parameters:**

| Parameter | Type | Required |
|---|---|---|
| `rejoin_number` | `string` | Yes |
| `caller` | `string` | Yes |

**Response `200`:**

```json
{ "authorized": true, "conference_room": "3010", "role": "responder" }
```

or:

```json
{ "authorized": false, "reason": "no_active_incident" }
```

`reason` values: `no_config`, `no_active_incident`, `not_authorized`.

---

#### `GET /internal/ers/incidents/open-join`

Anonymous join for OPEN_ACCESS type numbers.

**Query parameters:** `number` (string).

**Response `200`:**

```json
{ "authorized": true, "conference_room": "3010", "role": "observer" }
```

---

#### `GET /internal/ers/incidents/:uuid/status`

Lua queue-poll endpoint. Called approximately every 3 seconds while a caller waits in queue.

**Response `200`:**

```json
{ "status": "QUEUED", "conference_room": null }
```

or when promoted:

```json
{ "status": "ACTIVE", "conference_room": "3010" }
```

---

### ENS Internal (`/internal/ens`)

#### `GET /internal/ens/lookup`

First call from `ens_blast_trigger.lua` and `ens_playback_handler.lua`. Returns the full ENS configuration and the resolved contact list for the blast.

**Query parameters:**

| Parameter | Type | Required |
|---|---|---|
| `number` | `string` | Yes |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "configuration_id": 3,
    "name": "Blast Line A",
    "blast_clid": "0800001001",
    "reply_clid": "0800001002",
    "sip_gateway": "avaya-trunk",
    "pin_required": true,
    "max_concurrent_calls": 30,
    "calls_per_second": 2.0,
    "batch_size": 30,
    "max_attempts": 3,
    "retry_interval_sec": 60,
    "campaign_timeout_min": 60,
    "recording_retention_hours": 24,
    "campaign_priority": 5,
    "adaptive_throttling": true,
    "retry_failed_only": false,
    "playback_number": "0800001003",
    "no_pending_msg": null,
    "expiry_announcement": null,
    "contacts": ["0412000001", "0412000002"]
  }
}
```

`pin_required` is `true`/`false` — the actual PIN value is never returned. Lua must call `/verify-pin` to authenticate.

`contacts` contains all resolved mobile and extension numbers (dual-channel, deduplicated).

**Response `404`:** `{ "success": false, "error": "ENS number not found" }`

---

#### `POST /internal/ens/verify-pin`

PIN verification step. Lua calls this after collecting DTMF, before recording the blast message.

**Request body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `trigger_number` | `string` | Yes | The dialled trigger number. |
| `pin` | `string` | Yes | DTMF-collected PIN. |

**Response `200`:** `{ "success": true, "authorized": true, "pin_required": true }`

**Response `401`:** `{ "success": false, "authorized": false, "pin_required": true, "error": "Invalid PIN" }`

**Response `404`:** `{ "success": false, "error": "ENS service not found" }`

When no PIN is configured on the service: `{ "success": true, "authorized": true, "pin_required": false }`

---

#### `POST /internal/ens/campaign/start`

Called by `ens_blast_trigger.lua` after recording the blast message. Creates and enqueues the campaign.

**Request body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `trigger_number` | `string` | Yes | Dialled trigger number (used to resolve config). |
| `recording_file` | `string` | Cond. | Required if `message_text` not provided. |
| `message_text` | `string` | Cond. | TTS message. Required if `recording_file` not provided. |
| `caller_number` | `string` | No | Triggering caller's number. |
| `pin` | `string` | No | Defense-in-depth PIN re-check (Lua should have called `/verify-pin` first). |

**Response `201`:**

```json
{
  "success": true,
  "campaign_id": "3fa85f64-...",
  "status": "queued",
  "total_destinations": 50
}
```

Also registers the recording in the `recordings` table with type `ENS`.

---

#### `GET /internal/ens/notifications/queue-status`

Check whether an active notification exists for a configuration (prevents concurrent blasts).

**Query parameters:** `configuration_id` (integer).

**Response `200`:**

```json
{ "can_proceed": true, "active_uuid": null }
```

or:

```json
{ "can_proceed": false, "active_uuid": "3fa85f64-..." }
```

---

#### `POST /internal/ens/notifications`

Create a new notification record and pre-populate PENDING delivery rows for all resolved contacts.

**Request body (Zod `NotificationCreateSchema`):**

| Field | Type | Required | Validation |
|---|---|---|---|
| `configuration_id` | `integer` | Yes | Positive integer. |
| `triggered_via` | `string` | No | `PHONE`, `UI`, or `API`. Default: `PHONE`. |
| `caller_number` | `string` | No | 7–20 characters. |
| `recording_file` | `string` | No | Max 512 characters. |

**Response `201`:**

```json
{
  "notification_uuid": "3fa85f64-...",
  "notification_id": 7
}
```

Emits `enrs::ens_started` Socket.IO event.

---

#### `GET /internal/ens/notifications/:uuid/pending-contacts`

Returns phone numbers with delivery status not yet terminal (`ANSWERED`, `REPLAYED`, `CANCELLED`).

**Response `200`:** `{ "contacts": ["0412000001", "0412000002"] }`

---

#### `PATCH /internal/ens/notifications/:uuid/delivery`

Update a per-contact delivery outcome. Upserts on `(ens_notification_id, contact_number)`. Atomically increments `total_answered` or `total_no_answer` on the parent notification.

**Request body (Zod `DeliverySchema`):**

| Field | Type | Required | Validation |
|---|---|---|---|
| `contact_number` | `string` | Yes | 7–20 characters. |
| `status` | `string` | Yes | `ANSWERED`, `NO_ANSWER`, `FAILED`, or `CANCELLED`. |
| `call_uuid` | `string` | No | — |
| `hangup_cause` | `string` | No | FreeSWITCH hangup cause string. |
| `answered_at` | `string` (ISO 8601) | No | — |

**Response `200`:** `{ "ok": true }`

Emits `enrs::ens_delivery` Socket.IO event.

---

#### `POST /internal/ens/notifications/:uuid/complete`

Mark a notification as COMPLETED.

**Response `200`:** `{ "ok": true }`

Emits `enrs::ens_complete` Socket.IO event.

---

#### `GET /internal/ens/campaigns/latest`

Called by `ens_playback_handler.lua` to find the most recent blast recording for a configuration. Checks recording retention window.

**Query parameters:** `configuration_id` (integer).

**Response `200`:**

```json
{
  "success": true,
  "status": "ACTIVE",
  "campaign_id": 7,
  "recording_file": "/recordings/ens/2025/01/ens_7_1234567890.wav",
  "created_at": "2025-01-15T09:00:00Z",
  "expires_at": "2025-01-16T09:00:00Z"
}
```

`status` values: `ACTIVE` (recording exists and within retention window), `EXPIRED` (recording exists but past retention), `NO_CAMPAIGN` (no notification found or no recording file).

---

#### `GET /internal/ens/campaigns/:id/playback-log`

Increments the `callback_count` on the notification (best-effort). Called each time a recipient listens to the blast recording.

**Query parameters:** `caller` (string).

**Response `200`:** `{ "success": true }`

---

#### `GET /internal/ens/callbacks/authorize`

Authorizes a caller on the callback replay line. Verifies the caller's number against delivery rows for the most recent notification within the retention window (last-9-digit fuzzy match).

**Query parameters:**

| Parameter | Type | Required |
|---|---|---|
| `reply_clid` | `string` | Yes |
| `caller` | `string` | Yes |

**Response `200` (authorized):**

```json
{
  "authorized": true,
  "notification_uuid": "3fa85f64-...",
  "recording_file": "/recordings/ens/...",
  "delivery_id": 99
}
```

**Response `200` (not authorized):**

```json
{ "authorized": false, "reason": "not_in_blast_list" }
```

`reason` values: `no_active_notification`, `recording_expired`, `not_in_blast_list`.

---

#### `POST /internal/ens/callbacks`

Log a callback replay event. Updates the delivery row to `REPLAYED` and increments `total_replayed` and `callback_count` on the notification.

**Request body (Zod `CallbackLogSchema`):**

| Field | Type | Required | Validation |
|---|---|---|---|
| `notification_uuid` | `string` | Yes | UUID format. |
| `caller_number` | `string` | Yes | 7–20 characters. |
| `reply_clid` | `string` | Yes | 1–32 characters. |
| `delivery_id` | `integer` | Yes | Positive integer (from `/callbacks/authorize`). |
| `replayed_at` | `string` (ISO 8601) | No | — |

**Response `200`:** `{ "ok": true }`

Emits `enrs::ens_callback` Socket.IO event.

---

## Real-Time Events (Socket.IO)

The backend broadcasts real-time events via Socket.IO. Clients authenticate the Socket.IO connection using the JWT access token. The `emitInternal(event, data)` function in `socketService.js` broadcasts to all authenticated sockets.

| Event | Trigger |
|---|---|
| `enrs::ers_incident_created` | New ERS incident created by `POST /internal/ers/incidents`. |
| `enrs::ers_incident_ended` | Incident completed by `POST /internal/ers/incidents/:uuid/complete`. |
| `enrs::ers_responder_update` | Responder status updated by `PATCH /internal/ers/incidents/:uuid/responder`. |
| `enrs::ens_started` | Notification created by `POST /internal/ens/notifications`. |
| `enrs::ens_delivery` | Per-contact delivery update by `PATCH /internal/ens/notifications/:uuid/delivery`. |
| `enrs::ens_complete` | Notification completed by `POST /internal/ens/notifications/:uuid/complete`. |
| `enrs::ens_callback` | Callback replay logged by `POST /internal/ens/callbacks`. |
