# 02 — Backend Folder Structure

## Root Layout

```
fs-enrs/
├── backend/
│   ├── server.js                   Main Express app entry point
│   ├── package.json                Dependencies + npm scripts
│   ├── .env / .env.example         Environment variables
│   ├── ecosystem.config.cjs        PM2 cluster configuration
│   ├── Dockerfile                  Container image
│   ├── vitest.config.js            Test runner config
│   └── src/
│       ├── config/
│       ├── controllers/
│       ├── db/
│       ├── middleware/
│       ├── nodeTypes/
│       ├── routes/
│       ├── services/
│       ├── utils/
│       ├── validators/
│       └── __tests__/
├── frontend/                       Vite + React application
├── Lua-scripts/                    FreeSWITCH Lua dialplan scripts
└── docs/                           This documentation
```

---

## `src/config/`

**Purpose:** Single source of truth for all configuration. Controllers never read `process.env` directly.

| File | Responsibility |
|---|---|
| `index.js` | Exports `config` object: DB, JWT, ESL, CORS, upload, FreeSWITCH API settings |
| `fsConfig.js` | Resolves all FreeSWITCH filesystem paths from env vars with Debian defaults; exports `fsConfig` |

---

## `src/routes/`

**Purpose:** Express Router files. Each file groups endpoints for one domain. They import controllers and apply auth middleware.

### `routes/v1/` — UI API (JWT-protected)

| File | Mount Point | Domain |
|---|---|---|
| `auth.js` | `/api/v1/auth` | Login, logout, token refresh, password change |
| `users.js` | `/api/v1/users` | User CRUD |
| `organizations.js` | `/api/v1/organizations` | Org + location + department CRUD |
| `contacts.js` | `/api/v1/contacts` | Emergency contact CRUD + bulk CSV upload |
| `groups.js` | `/api/v1/groups` | Responder group CRUD + member management |
| `ens.js` | `/api/v1/ens` | ENS configuration CRUD + notification history |
| `ers.js` | `/api/v1/ers` | ERS configuration + incident management + conference ops |
| `ivr.js` | `/api/v1/ivr/flows` | IVR flow CRUD, publish, version, bind |
| `deployment.js` | `/api/v1/deployment` | Deploy flows, audio, diagnostics, reloadxml |
| `services.js` | `/api/v1/services` | Emergency number service registry CRUD |
| `campaigns.js` | `/api/v1/campaigns` | Campaign CRUD + engine control (pause/resume/cancel) |
| `dashboard.js` | `/api/v1/dashboard` | Metrics, active incidents, chart data |
| `reports.js` | `/api/v1/reports` | Historical reports (incidents, notifications, usage) |
| `media.js` | `/api/v1/media` | Legacy audio file upload |
| `settings.js` | `/api/v1/settings` | System settings, ESL status, feature flags, emergency numbers |
| `gateways.js` | `/api/v1/gateways` | SIP gateway CRUD + deploy |
| `monitoring.js` | `/api/v1/monitoring` | Live conference operations center |
| `mediaLibrary.js` | `/api/v1/media-library` | Enterprise media library (upload, scan, stream, waveform) |
| `recordings.js` | `/api/v1/recordings` | Conference recording management |
| `index.js` | `/api/v1` | Aggregates all v1 routers; mounts `/ivr/node-types` directly |

### `routes/internal/` — Lua Contract API (X-Internal-Key)

| File | Mount Point | Domain |
|---|---|---|
| `ens.js` | `/api/v1/internal/ens` | ENS: lookup, verify-pin, start campaign, delivery update |
| `ers.js` | `/api/v1/internal/ers` | ERS: lookup, incidents CRUD, ring-all, queue, auth, rejoin |
| `ivr.js` | `/api/v1/internal/ivr` | IVR: lookup, PIN verify, callback, CDR |
| `index.js` | `/api/v1/internal` | Aggregates internal routers; mounts `/services/:number` |

---

## `src/controllers/`

**Purpose:** Request handlers. Receive validated `req`, execute business logic, call services/DB, respond. Wrapped in `asyncHandler` — no try/catch needed in handler bodies.

### Standard Controllers (UI)

| File | Responsibility |
|---|---|
| `authController.js` | Login (JWT issue), refresh, logout, me, change-password |
| `campaignController.js` | Campaign list/get/trigger/pause/resume/cancel; engine stats |
| `contactController.js` | Emergency contact CRUD; CSV bulk import |
| `dashboardController.js` | KPI metrics, active incidents summary, chart data |
| `deploymentController.js` | Flow deploy, audio file management, diagnostics, reloadxml |
| `ensController.js` | ENS configuration CRUD; notification history; toggle active |
| `ersController.js` | ERS configuration CRUD; incident list/detail; conference ops; queue |
| `gatewayController.js` | SIP gateway CRUD; deploy gateway XML to FreeSWITCH |
| `groupController.js` | Responder group CRUD; member add/remove |
| `ivrController.js` | IVR flow CRUD; publish; version history; bind/unbind; templates; node-types |
| `ivrTemplates.js` | Static IVR template definitions (data, not handler) |
| `mediaLibraryController.js` | Media library upload/list/stream/waveform/deploy/scan |
| `monitoringController.js` | Live conference controls: mute/kick/lock/record/play/invite |
| `organizationController.js` | Organization + location + department CRUD |
| `recordingController.js` | Recording list/get/stream/waveform/archive; DB upsert on ESL events; startup scan |
| `serviceController.js` | Emergency number (service registry) CRUD; internal lookup |

### Internal Controllers (Lua Contract)

| File | Responsibility |
|---|---|
| `internal/ersInternalController.js` | ERS lookup, incident create/complete/cancel, ring-all, queue management, auth/rejoin |
| `internal/ensInternalController.js` | ENS lookup, PIN verify, campaign start, delivery updates, playback lookup |
| `internal/ivrInternalController.js` | IVR flow lookup, PIN verify, CDR recording, TTS |

---

## `src/services/`

**Purpose:** Stateful singletons and reusable business logic. Controllers call services; services never call controllers.

| File | Responsibility |
|---|---|
| `eslService.js` | ESL TCP connection to FreeSWITCH; in-memory conference registry; all ESL commands; event handling → Socket.IO; reconnect loop; background jobs |
| `campaignEngine.js` | Tick-based outbound call engine (1s interval); PostgreSQL advisory lock; originate → answer/hangup lifecycle |
| `conferenceManager.js` | Single source of truth for conference room naming (STATIC/DYNAMIC) and auto-recording; `resolveConferenceRoom()`, `getConferenceProfile()`, `getConferenceString()`, `handleConferenceCreated()`, `handleFirstParticipant()` |
| `ersRingService.js` | ERS ring-all loop: parallel originate per responder, re-ring until answered, recording start on first join |
| `deploymentEngine.js` | Orchestrates IVR deployment: generate Lua + XML → write to FS paths → reloadxml |
| `dialResolver.js` | Gateway-agnostic dial string resolution: looks up SIP gateway for a contact, returns `sofia/gateway/<gw>/<number>` or `user/<ext>@<domain>` |
| `freeSwitchPathService.js` | Wraps `fsConfig`; typed accessors for every FS directory; `getRecordingDirForType(type)` |
| `socketService.js` | Socket.IO server init; JWT auth on socket; `emitInternal(event, data)` broadcaster |
| `diagnosticsService.js` | FreeSWITCH path discovery, health checks |
| `gatewayDeployment.js` | Generates SIP gateway XML and writes to FS sip_profiles directory |

---

## `src/middleware/`

**Purpose:** Express middleware functions applied to routes.

| File | Exports | Purpose |
|---|---|---|
| `auth.js` | `requireAuth`, `requireAuthOrToken`, `optionalAuth` | JWT verification; populates `req.user` |
| `rbac.js` | `adminOnly`, `adminOrSuper`, `adminOrOp`, `canTriggerEns`, `canManageIncidents`, `canViewRecordings`, `canExportReports`, `anyRole` | Role-based access control guards |
| `internalAuth.js` | `internalAuth`, `internalRateLimit` | Timing-safe key comparison for Lua routes; 500 req/min rate limiter |
| `asyncHandler.js` | `asyncHandler`, `errorHandler` | Wraps async route handlers to catch promise rejections; global error response formatter |
| `validate.js` | `validate(schema)` | Zod schema validation middleware (used selectively) |

---

## `src/db/`

**Purpose:** Database access layer and migration tooling.

| File/Folder | Purpose |
|---|---|
| `pool.js` | pg `Pool` singleton; `query(sql, params)` with error annotation; `withTransaction(fn)` |
| `schema.sql` | Full schema for fresh install (covers migrations 001–005 equivalent) |
| `migrate.js` | Migration runner: auto-detects fresh vs existing DB; applies `schema.sql` then 006–027 |
| `seed.js` | Creates admin user + feature flags for development |
| `validateSchema.js` | Boot-time check: verifies all required columns exist against a hardcoded list; exits clearly if migrations are missing |
| `migrations/001–027` | Numbered SQL migrations (idempotent, self-contained `BEGIN/COMMIT`) |
| `utils/` | One-off maintenance scripts (orphan cleanup, flow graph checker) |

---

## `src/nodeTypes/`

**Purpose:** IVR node type registry — single source of truth for what node types exist, their config schemas, and their Lua/XML generation templates.

| File | Purpose |
|---|---|
| `registry.js` | Defines all node types (MENU, PLAYBACK, RECORD, ERS_BRIDGE, ENS_TRIGGER, CONDITION, etc.); generates Lua/XML for each |
| `selfCheck.js` | Boot-time self-check: verifies that every node type's referenced internal API endpoints are registered |

---

## `src/utils/`

**Purpose:** Pure code-generation utilities.

| File | Purpose |
|---|---|
| `luaGenerator.js` | Generates Lua script text from a published IVR flow graph |
| `xmlGenerator.js` | Generates FreeSWITCH dialplan XML from a published IVR flow graph |
| `gatewayXmlGenerator.js` | Generates FreeSWITCH SIP gateway XML for a given `sip_gateways` row |
| `ivrGraphValidator.js` | Validates IVR graph: reachability from entry node, ERS/ENS config ID tenant scope |

---

## `src/validators/`

| File | Purpose |
|---|---|
| `ivrValidator.js` | Zod schema for IVR flow create/update request body |

---

## `src/__tests__/`

**Purpose:** Vitest test suite.

### Integration tests
| File | Coverage |
|---|---|
| `internal-api.test.js` | ERS/ENS internal API contract |
| `ivr.test.js` | IVR CRUD + publish + validate |
| `ivr_new_nodes.test.js` | New IVR node types |
| `phase1-regression.test.js` | 13-item regression checklist |
| `deployPipeline.test.js` | Full IVR deploy pipeline |
| `ersRingAllPhase5.test.js` | ERS ring-all scenarios |
| `dialResolver.test.js` | Dial string resolution |
| `tierStatus.test.js` | ERS tier occupancy logic |

### Unit tests
| File | Coverage |
|---|---|
| `eslService.test.js` | ESL event parsing |
| `ivrGraphValidator.test.js` | Graph validation rules |
| `luaGenerator.test.js` | Lua code output |
| `xmlGenerator.test.js` | XML dialplan output |
| `nodeTypeRegistry.test.js` | Node type registry |
| `nodeTypeSelfCheck.test.js` | Self-check pass/fail |
| `recordingFSM.test.js` | Recording state machine |
| `ersPhase5Fixes.test.js` | ERS edge cases |
| `detectDialplanTarget.test.js` | Dial target detection |

---

## `Lua-scripts/`

| File | Triggered by | Purpose |
|---|---|---|
| `dial_911_conference.lua` | Inbound call to ERS number | Lookup config → create incident → join conference → invite responders → record |
| `blast_call.lua` | Outbound call from ENS campaign | Record message → POST /internal/ens/campaign/start |
| `ENS_retry_playback.lua` | Re-dial of ENS number | Lookup latest campaign → play recording or speak TTS |
| `INTERNAL_API.md` | — | Lua ↔ backend API contract documentation |
