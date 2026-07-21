# System Architecture

## Platform Overview

fs-enrs is an enterprise emergency notification and response platform that integrates Voice over IP telephony with a real-time web application. The platform provides two primary services:

- **Emergency Notification System (ENS)**: Outbound blast calls that deliver a recorded or TTS message to a configured contact list. An authorised caller dials in, records a message, and the system simultaneously calls every contact on the list — both their SIP extensions and mobile numbers.

- **Emergency Response System (ERS)**: Inbound conference bridge for emergency events. When a caller dials an ERS number, the system immediately creates a conference room, rings all configured tier responders simultaneously, and connects responders as they answer. The caller hears ring-back until the first responder joins.

Both services are orchestrated through an IVR (Interactive Voice Response) flow builder. Flows are designed visually in the React frontend, published as versioned graphs, and deployed as a single Lua script and a FreeSWITCH XML dialplan fragment.

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Inbound PSTN / SIP                           │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │        FreeSWITCH          │
                     │  mod_lua · mod_conference  │
                     │  mod_sofia · mod_event_socket│
                     │  :5060 SIP  :8021 ESL TCP  │
                     └──────┬──────────┬──────────┘
                            │ ESL TCP  │ Lua curl HTTP
                            │          │
               ┌────────────▼──┐   ┌───▼────────────────────────┐
               │  Backend      │   │  /api/v1/internal/*         │
               │  Node.js :4100│◄──│  X-Internal-Key auth        │
               │  Express + ESM│   │  Rate-limited 500 req/min   │
               └───┬───────────┘   └────────────────────────────┘
                   │
        ┌──────────┼──────────────────┐
        │          │                  │
┌───────▼──┐  ┌────▼──────┐  ┌───────▼──────┐
│PostgreSQL│  │Socket.IO  │  │Frontend       │
│fs_enrs DB│  │(JWT auth) │  │React/Vite     │
│:5432     │  │           │  │:8100 (dev)    │
│33 tables │  │           │  │nginx (prod)   │
└──────────┘  └───────────┘  └──────────────┘
```

---

## System Boundaries

### FreeSWITCH → Backend (ESL TCP)

The backend maintains a persistent modesl TCP connection to FreeSWITCH on `127.0.0.1:8021` (password: `ClueCon`, configurable via `ESL_HOST`, `ESL_PORT`, `ESL_PASSWORD`). All conference control commands (mute, kick, record, ring-all originate) travel over this channel as `bgapi` calls. The connection reconnects with exponential backoff starting at `ESL_RECONNECT_MS` (default 3000 ms), capping at 30 seconds.

### Lua Scripts → Backend (HTTP curl)

FreeSWITCH Lua scripts communicate with the backend exclusively via `io.popen(curl ...)` — there is no luasocket dependency. All decisions (bridge numbers, retry counts, responder lists, PIN verification, queue state) are resolved by a single API lookup per call session. The Lua script contains no hardcoded business logic.

### Frontend → Backend (HTTP + WebSocket)

The Vite development server proxies three path prefixes to `localhost:4100`:

| Prefix | Purpose |
|---|---|
| `/api` | All REST API calls |
| `/socket.io` | WebSocket upgrade for real-time events |
| `/uploads` | Media file serving |

In production the same proxying is configured in nginx. The frontend React application never talks to FreeSWITCH directly.

---

## Two API Surfaces

The backend exposes two completely independent route trees, each with its own authentication middleware. These must never be mixed.

### `/api/v1/*` — Frontend REST API

Protected by `requireAuth` middleware (`backend/src/middleware/auth.js`). Accepts either:

- `Authorization: Bearer <access_token>` header (JWT, 15-minute lifetime)
- httpOnly refresh cookie to obtain a new access token via `POST /api/v1/auth/refresh`

All handlers are wrapped with `asyncHandler` and use Zod schemas for request validation. The `req.user` object shape set by `requireAuth`:

```js
req.user = {
  id:       number,   // users.id
  email:    string,
  role:     'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER',
  tenantId: number,   // from JWT payload — always use this, never req.body.tenant_id
}
```

### `/api/v1/internal/*` — Lua Contract API

Protected by `requireInternalKey` middleware (`backend/src/middleware/internalAuth.js`). Performs a timing-safe comparison of the `X-Internal-Key` request header against the `INTERNAL_API_KEY` environment variable. Rate-limited separately at **500 requests per minute**. All handlers live in `backend/src/controllers/internal/`.

The Lua executor and the two standalone Lua scripts (`ens_blast_trigger.lua`, `ens_playback_handler.lua`) call only these endpoints:

| Endpoint | Called by |
|---|---|
| `GET /internal/ivr/lookup` | `ivr_executor.lua` — resolves flow graph |
| `GET /internal/ers/lookup` | `ers_conference_bridge.lua` — resolves ERS config |
| `POST /internal/ers/incidents` | `ivr_executor.lua` — creates ERS incident |
| `POST /internal/ers/ring-all` | `ivr_executor.lua` — ring-all tier |
| `GET /internal/ers/tier-status` | `ivr_executor.lua` — overflow check |
| `POST /internal/ers/overflow/enqueue` | `ivr_executor.lua` — queue caller |
| `GET /internal/ers/overflow/poll` | `ivr_executor.lua` — poll queue |
| `POST /internal/ers/incidents/:uuid/complete` | `ivr_executor.lua` — close incident |
| `GET /internal/ens/lookup` | `ens_blast_trigger.lua`, `ens_playback_handler.lua` |
| `POST /internal/ens/verify-pin` | `ivr_executor.lua`, `ens_blast_trigger.lua` |
| `POST /internal/ens/notifications` | `ivr_executor.lua` |
| `GET /internal/ens/campaigns/latest` | `ens_playback_handler.lua` |

---

## Multi-Tenancy

Every configuration row (`ers_configurations`, `ens_configurations`, `ivr_flows`, `emergency_numbers`, and all their children) carries a `tenant_id` column. At INSERT time, `tenant_id` **must** come from `req.user.tenantId` — not from the request body. This is enforced by design: the JWT payload is the authority on which tenant the authenticated user belongs to, and the request body is untrusted input.

The IVR graph validator (`ivrGraphValidator.js`) enforces cross-entity tenant isolation: ERS and ENS node config IDs referenced in a flow's graph must belong to the same `tenant_id` as the flow itself.

Socket.IO rooms are tenant-scoped: after authentication a socket joins `tenant:<tenantId>`. `emitInternal(event, data, tenantId)` in `socketService.js` scopes broadcasts to this room.

---

## Soft-Delete Pattern

All 33 tables use soft-delete. Rows are never physically deleted. The deletion is recorded with:

```sql
deleted_at TIMESTAMPTZ  -- NULL = active, non-NULL = deleted
```

**Every query that reads from any table must include `AND deleted_at IS NULL`** in its WHERE clause. The only exceptions are explicit undelete operations and admin audit views.

---

## Role Hierarchy and RBAC

Roles are ordered: `ADMIN > SUPERVISOR > OPERATOR > VIEWER`.

Named middleware exports in `backend/src/middleware/rbac.js` are used instead of inline role checks:

| Export | Grants access to |
|---|---|
| `requireAdmin` | ADMIN only |
| `adminOrSuper` | ADMIN or SUPERVISOR |
| `canTriggerEns` | ADMIN, SUPERVISOR, or OPERATOR |
| `requireViewer` | Any authenticated user |

---

## Service Registry — `emergency_numbers` Table

The `emergency_numbers` table is the single source of truth that connects a dialled number to a service and its configuration:

| Column | Purpose |
|---|---|
| `number` | The E.164 or extension number that FreeSWITCH routes on |
| `service_type` | `ENS`, `ERS`, `IVR`, `REJOIN`, or `OPEN_ACCESS` |
| `ivr_flow_id` | Foreign key to `ivr_flows` (IVR service type) |
| `ers_configuration_id` | Foreign key to `ers_configurations` |
| `ens_configuration_id` | Foreign key to `ens_configurations` |
| `tenant_id` | Tenant isolation |
| `is_active` | Only active numbers are included in deployments |

The Bind Numbers modal in the IVR Builder calls `GET /settings/emergency-numbers` which reads from this table filtered by `tenant_id + is_active = true`.

---

## ERS Conference Bridge Architecture

When a caller dials an ERS number:

1. FreeSWITCH matches the dialplan extension (generated by deployment).
2. `ivr_executor.lua` is invoked (or `ers_conference_bridge.lua` for standalone ERS).
3. The Lua script calls `POST /internal/ers/incidents` to register the incident and receive a `conference_room` name.
4. The conference room name follows the pattern `ers_<config_id>_<epoch>` (generated by Lua).
5. The backend rings all tier responders simultaneously using FreeSWITCH `bgapi originate`.
6. The conference uses slot assignment to distinguish primary (`ers_{id}_p`) and secondary (`ers_{id}_s`) tiers.
7. Callers beyond the configured `max_concurrent_conferences` are placed in `ers_queues`.
8. Responder identity is resolved via `emergency_contacts` (individual) and `responder_group_members` (group-based), merged and deduplicated.

---

## ENS Blast and Playback

**Blast trigger flow:**

1. `ens_blast_trigger.lua` → `GET /internal/ens/lookup` (returns `pin_required` only — never the raw PIN).
2. If PIN required: `POST /internal/ens/verify-pin` with the collected digit string.
3. Lua records the initiator's message to disk (`/var/lib/freeswitch/recordings/ens/`).
4. `POST /internal/ens/campaign/start` launches the campaign engine.

**Playback flow:**

1. `ens_playback_handler.lua` → `GET /internal/ens/lookup`.
2. `GET /internal/ens/campaigns/latest?configuration_id=<id>` — returns the recording path if a campaign is active and within its expiry window, or the `no_pending_msg` announcement text if not.

---

## IVR Builder and Deployment Chain

1. Flow designer saves a graph to `ivr_flows` (JSONB, `{ entry_node_id, nodes: { [id]: { type, label, config, next } } }`).
2. User publishes the flow — a new immutable row is written to `ivr_flow_versions` with an incrementing `version_number`.
3. User triggers Deploy from the UI, which calls `POST /api/v1/deployment/:flowUuid`.
4. `deploymentEngine.js` runs the following ordered steps:
   - Fetch published version from `ivr_flow_versions`
   - Validate graph with `ivrGraphValidator.js` (reachability + tenant cross-reference)
   - Validate referenced audio files exist on disk
   - Generate `ivr_executor.lua` from node type registry and write to `getExecutorLuaFile()`
   - Generate `enrs_ivr.xml` from all bound numbers and write to `getIvrDialplanFile()`
   - Send `bgapi reloadxml` via ESL
   - Verify each bound extension loaded via `xml_locate dialplan context name default` (3 retries, 500 ms delay)
   - Record deployment result in `ivr_flow_deployments`
5. If ESL is offline during deploy, files are still written; reload happens on FreeSWITCH restart.

---

## PM2 Cluster Safety

The campaign engine (`src/services/campaignEngine.js`) is a singleton that runs on a 1-second tick. In a PM2 cluster with multiple Node.js workers, multiple instances would race on the same campaign rows. Safety is provided by PostgreSQL advisory locks:

- Each tick attempts `pg_try_advisory_lock(campaign_id)` before processing.
- Only one worker acquires the lock; others skip silently.
- The lock is released at the end of each tick.

This means the campaign engine is safe under both `fork` and `cluster` PM2 modes with no additional configuration.
