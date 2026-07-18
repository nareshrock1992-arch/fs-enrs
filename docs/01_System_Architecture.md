# 01 — System Architecture

## Overview

`fs-enrs` is an **Enterprise Emergency Notification and Response System** built on a Node.js / Express / PostgreSQL backend with a React frontend. It integrates with **FreeSWITCH** for all telephony operations via the **Event Socket Library (ESL)** protocol, and communicates in real time with the browser via **Socket.IO**.

---

## High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (React + Vite)  :8100                                        │
│   Zustand auth store  ·  Socket.IO client  ·  fetch API client       │
└──────────────────┬──────────────────────────────┬────────────────────┘
                   │  HTTP / REST                  │  WebSocket
                   ▼                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Node.js / Express  :4100                                             │
│   ├── /api/v1/*          — JWT-protected REST API (UI)               │
│   ├── /api/v1/internal/* — X-Internal-Key API  (Lua ↔ backend)       │
│   ├── /socket.io         — Socket.IO server                          │
│   └── /uploads           — static file serving                       │
└──────┬──────────────────────────────────────────────────────┬────────┘
       │ pg driver                                            │ modesl ESL
       ▼                                                      ▼
┌─────────────────┐                            ┌─────────────────────────┐
│  PostgreSQL      │                            │  FreeSWITCH  :8021 ESL  │
│  fs_enrs DB      │                            │   mod_conference        │
│  33+ tables      │                            │   mod_lua               │
└─────────────────┘                            │   mod_sofia             │
                                               │   mod_dptools           │
                                               └────────────┬────────────┘
                                                            │ curl HTTP
                                                            ▼
                                               ┌─────────────────────────┐
                                               │  Lua Scripts (on FS)    │
                                               │  dial_911_conference.lua │
                                               │  blast_call.lua          │
                                               │  ENS_retry_playback.lua  │
                                               └─────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 18 + Vite | SPA, served on :8100 in dev |
| Frontend state | Zustand | Auth token & user state |
| Frontend realtime | Socket.IO client | Live conference & campaign events |
| Backend runtime | Node.js 20 (ESM) | REST API, ESL client, campaign engine |
| Backend framework | Express 5 | HTTP routing, middleware |
| Backend realtime | Socket.IO server | Push events to dashboard |
| Database | PostgreSQL 14+ | Persistent store, soft-delete, multi-tenant |
| ESL client | modesl | Bidirectional ESL TCP to FreeSWITCH :8021 |
| Telephony | FreeSWITCH | Conference bridges, IVR dialplan, outbound dialing |
| IVR scripting | Lua | Runtime dialplan execution on FreeSWITCH |
| Process manager | PM2 | Production clustering, restarts |

---

## Request Flow — Browser to FreeSWITCH

```
Browser
  │
  │ 1. fetch('/api/v1/...')  Bearer token
  ▼
Express app  (server.js)
  │
  │ 2. cors → helmet → body-parse → rate-limit → requireAuth
  ▼
Route handler  (e.g. routes/v1/ers.js)
  │
  │ 3. Zod validation → asyncHandler wrapper
  ▼
Controller  (e.g. controllers/monitoringController.js)
  │
  │ 4. Business logic; query(sql, params)
  ▼
PostgreSQL  (pool.js)
  │
  │ 5. DB result
  ▼
Controller
  │
  │ 6. eslCommand('conference 3010 record /path/file.wav')
  ▼
eslService.js  (modesl TCP connection)
  │
  │ 7. ESL API command over TCP :8021
  ▼
FreeSWITCH
  │
  │ 8. conference::maintenance events over same ESL connection
  ▼
eslService.js  (event handler)
  │
  │ 9. io.emit('conference.recording', {...})
  ▼
Socket.IO  →  Browser  (live update in Monitoring page)
```

---

## Lua ↔ Backend Request Flow

```
Inbound PSTN/SIP call
  │
  ▼
FreeSWITCH dialplan (XML)
  │
  │ matches destination_number
  ▼
Lua script  (e.g. dial_911_conference.lua)
  │
  │ curl GET /api/v1/internal/ers/lookup?number=1222
  │      X-Internal-Key: <shared secret>
  ▼
Express  →  internalRateLimit  →  internalAuth
  │
  ▼
ersInternalController.ersLookup()
  │
  ▼
PostgreSQL  (emergency_numbers JOIN ers_configurations)
  │
  ▼
JSON response → Lua
  │
  │ session:execute("conference", "3010@default")
  ▼
FreeSWITCH conference bridge
  │
  │ curl POST /api/v1/internal/ers/incidents
  ▼
Incident created in DB → Socket.IO → Dashboard
```

---

## Authentication Architecture

### UI Surface (`/api/v1/*`)

- **Login** → issues a **15-minute JWT access token** (Bearer) + a **7-day httpOnly refresh cookie**
- Every subsequent request: `Authorization: Bearer <access_token>`
- On 401: client automatically calls `POST /api/v1/auth/refresh` using the cookie; on success re-issues access token
- `req.user` shape set by `requireAuth` middleware: `{ id, email, role, tenantId }`

### Internal Surface (`/api/v1/internal/*`)

- Protected by `X-Internal-Key` header (timing-safe SHA-256 comparison)
- Separate rate limit bucket: 500 req/min
- **Never** uses JWT — designed for Lua `io.popen(curl ...)` calls
- Should be blocked at the network perimeter (Nginx `deny all` for WAN)

---

## Multi-Tenancy

Every configuration record, contact, incident, campaign, and recording carries a `tenant_id` column that is **always set from `req.user.tenantId`** at INSERT time, never from the request body. All list queries filter by `tenant_id`. Tenants are isolated at the data layer.

---

## Real-Time Event Architecture

```
FreeSWITCH ESL event
  │
  ▼
eslService.js handleEvent()
  │  updates in-memory conferenceRegistry
  │
  ├─► io.emit(event, payload)  ──►  all Socket.IO clients (broadcast)
  │
  └─► eslEvents.emit(...)      ──►  campaignEngine.js (internal bus)
```

The in-memory `conferenceRegistry` (Map) is the live source of truth for conference member state. The DB is only queried for historical/incident data, not for live conference state.

---

## Campaign Engine (ENS Outbound Dialing)

```
campaignEngine.js  (singleton, tick-based, 1s interval)
  │
  │ PostgreSQL advisory lock — safe for PM2 cluster
  │
  ├─► picks pending destinations
  ├─► eslCommand('bgapi originate ...')
  ├─► waits for CHANNEL_ANSWER / CHANNEL_HANGUP on eslEvents bus
  └─► updates delivery status + emits Socket.IO progress event
```

---

## IVR Builder → Deployment Pipeline

```
Browser IVR Builder
  │
  │ PUT /api/v1/ivr/flows/:uuid  (save graph JSONB)
  │
  │ POST /api/v1/ivr/flows/:uuid/validate
  │   → ivrGraphValidator.js (node reachability + tenant-scoped config IDs)
  │
  │ POST /api/v1/ivr/flows/:uuid/publish
  │   → versioned snapshot in ivr_flow_versions
  │
  │ POST /api/v1/deployment/flows/:uuid/deploy
  ▼
deploymentEngine.js
  │
  ├─► luaGenerator.js     → Lua script file  (FS script dir)
  ├─► xmlGenerator.js     → FreeSWITCH dialplan XML
  └─► eslCommand('api reloadxml')   → hot-reload dialplan
```

---

## FreeSWITCH Path Configuration

All FS filesystem paths are resolved once at startup by `freeSwitchPathService.js` from environment variables, with sensible Debian-package defaults. Paths are never hardcoded inside controllers or services.

| Env Var | Default | Purpose |
|---|---|---|
| `FS_CONF_DIR` | `/etc/freeswitch` | FreeSWITCH config root |
| `FS_DIALPLAN_DIR` | `/etc/freeswitch/dialplan` | Dialplan XML files |
| `FS_SCRIPT_DIR` | `/usr/share/freeswitch/scripts` | Lua scripts |
| `FS_RECORDING_DIR` | `/var/lib/freeswitch/recordings` | Recording base dir |
| `FS_SOUND_DIR` | `/usr/share/freeswitch/sounds` | Audio prompts |

Recording sub-directories:

| Sub-path | Module |
|---|---|
| `recordings/ers/` | ERS conference recordings |
| `recordings/ens/` | ENS blast message recordings |
| `recordings/ivr/` | IVR session recordings |
| `recordings/manual/` | Operator-initiated recordings |
| `recordings/conf/` | Legacy (pre-migration 026) |
