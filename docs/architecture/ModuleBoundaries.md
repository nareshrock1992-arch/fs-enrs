# Module Boundaries

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Reading This Document

Each module has:
- **One responsibility** — the single thing it owns
- **Public interface** — the only surface other modules may call
- **Permitted dependencies** — what it may import or call
- **Forbidden dependencies** — hard rules enforced at code review

No module may access another module's internal implementation. Cross-module access is only through public interfaces.

---

## Communication Engine
_File: `src/services/communicationEngine.js` (Wave 3)_

**Responsibility:** Single entry point for all outbound communication. Creates, tracks, and updates Communication Sessions.

**Public interface:**
- `request(CommunicationRequest)` → `Promise<sessionUuid>`
- `getSession(sessionUuid)` → session status object
- `cancel(sessionUuid)` → void
- `on('session:status', handler)` → event subscription

**Permitted dependencies:**
- Outbound Router (dispatches to)
- DB pool (`communication_sessions` table only)
- Socket service (event emission)

**Forbidden:**
- `eslService.js` — no direct ESL calls
- ENS / ERS / IVR business objects
- FreeSWITCH-specific concepts in public interface
- Provider-specific hangup codes (Engine translates to standard codes before emitting)

---

## Outbound Router
_File: `src/services/outboundRouter.js` (Wave 1)_

**Responsibility:** Translate a routing intent into a provider-specific CallInstruction.

**Public interface:**
- `placeCall(RouteRequest)` → `Promise<CallResult>`
  - RouteRequest: `{ tenantId, destination, callerIdentity, action, hints, async, timeoutSeconds }`
  - CallResult: `{ providerSessionId, gateway, dialString, mode }`

**Permitted dependencies:**
- Destination Classifier
- `dialResolver.js` (gateway resolution)
- `numberNormalizer.js`
- Provider Layer (dispatch)

**Forbidden:**
- ENS / ERS / IVR business objects
- `communication_sessions` table (belongs to Communication Engine)
- Business module state machines
- `eslCommand()` directly (delegates to Provider Layer)

---

## Destination Classifier
_File: `src/services/destinationClassifier.js` (Wave 2)_

**Responsibility:** Determine what type of destination a call target is before any routing decision is made.

**Public interface:**
- `classify(destination, context)` → `{ type: DestinationType, normalizedNumber, metadata }`

**DestinationType values:**
```
INTERNAL_EXTENSION | INTERNAL_SIP_USER | EXTERNAL_MOBILE | EXTERNAL_LANDLINE
EXTERNAL_SIP_URI   | GATEWAY_ROUTE     | EMERGENCY_NUMBER | CONFERENCE
WEBRTC_PEER (future)
```

**Permitted dependencies:**
- DB pool (contact lookup only — one optional query)
- `numberNormalizer.js`

**Forbidden:**
- `dialResolver.js` (routing is not classifying)
- Provider Layer
- Any business module

---

## Provider Layer
_Files: `src/providers/freeswitchProvider.js`, `src/providers/providerRegistry.js` (Wave 4)_

**Responsibility:** Translate a provider-agnostic CallInstruction into provider-specific protocol and emit standard CallEvents.

**Provider interface (every provider implements):**
- `get id()` → string
- `isAvailable()` → `Promise<boolean>`
- `placeCall(instruction)` → `Promise<{ providerSessionId }>`
- `hangup(providerSessionId)` → `Promise<void>`
- `on(event, handler)` → event subscription

**Standard CallEvents:** `answer` | `hangup` | `ringing` | `dtmf` | `media`

**Permitted dependencies:**
- `eslService.js` (FreeSWITCH provider only)
- External provider SDKs (future providers)

**Forbidden:**
- Any business module (ENS, ERS, IVR)
- `communication_sessions` table
- Routing logic (already resolved by Outbound Router)
- Business context of any kind

---

## Gateway Manager
_Files: `src/controllers/gatewayController.js`, `src/services/gatewayDeployment.js`, `src/utils/gatewayXmlGenerator.js`_

**Responsibility:** CRUD for gateway configurations, deployment to FreeSWITCH filesystem, sofia profile management.

**Public interface:**
- REST: `GET/POST/PUT/DELETE /api/v1/gateways`
- REST: `POST /api/v1/gateways/:id/deploy`
- DB: `sip_gateways` table (read by Outbound Router)

**Permitted dependencies:**
- DB pool (`sip_gateways` table)
- `freeSwitchPathService`
- `eslService.js` (sofia profile rescan only)

**Forbidden:**
- ENS / ERS / IVR business objects
- Communication Engine
- Outbound Router
- Business module state

---

## ENS Module
_Files: `src/controllers/ensController.js`, `src/services/campaignEngine.js`, `src/controllers/internal/ensInternalController.js`_

**Responsibility:** ENS configuration management, campaign lifecycle, blast origination, playback authorization, PIN verification.

**Public interface:**
- REST: `/api/v1/ens/*`
- Internal: `/api/v1/internal/ens/*` (Lua contract)
- Socket events: `enrs::ens_campaign_*`

**Permitted dependencies:**
- Communication Engine (for all outbound calls — Wave 3; Outbound Router directly in Wave 1)
- DB pool (`ens_*` tables)
- Socket service
- Media Library (recording paths)
- Recording module (blast recording)

**Forbidden:**
- `eslService.js` — no direct ESL calls
- `dialResolver.js` — no gateway selection
- `bgapi` / `originate` / channel variable names in any form
- FreeSWITCH hangup cause strings in business logic (use standard codes)
- ERS / IVR internal modules
- Any routing decisions

---

## ERS Module
_Files: `src/controllers/ersController.js`, `src/controllers/internal/ersInternalController.js`, `src/services/ersRingService.js`_

**Responsibility:** ERS configuration management, incident lifecycle, ring-all service, responder tier resolution, participant tracking (via ESL events, read-only).

**Public interface:**
- REST: `/api/v1/ers/*`
- Internal: `/api/v1/internal/ers/*` (Lua contract)
- Socket events: `enrs::ers_*`

**Permitted dependencies:**
- Communication Engine (for all outbound calls — Wave 3; Outbound Router directly in Wave 1)
- DB pool (`ers_*` tables)
- Socket service
- Recording module

**Forbidden:**
- Inline `bgapi originate` construction (resolved in Wave 1)
- FreeSWITCH dial strings in business logic
- FreeSWITCH hangup cause strings in business logic
- ENS / IVR internal modules
- Any routing decisions

---

## IVR Module
_Files: `src/controllers/ivrController.js`, `src/utils/luaGenerator.js`, `src/nodeTypes/registry.js`, `src/services/deploymentEngine.js`_

**Responsibility:** IVR flow graph CRUD, validation, publishing, Lua script generation, deployment to FreeSWITCH filesystem.

**Public interface:**
- REST: `/api/v1/ivr/flows/*`
- Internal: `/api/v1/internal/ivr/*` (Lua contract)
- Node Registry: read-only export from `registry.js`

**Permitted dependencies:**
- Communication Engine (for IVR-triggered outbound calls — Wave 3)
- DB pool (`ivr_*` tables)
- `freeSwitchPathService` (deployment paths)
- `ivrGraphValidator.js`

**Forbidden:**
- Direct ESL calls from IVR controller
- ENS / ERS internal state (must call their public APIs)
- Gateway or routing selection

---

## Conference Manager
_File: `src/services/conferenceManager.js`_

**Responsibility (current — boundary violation exists):** Conference room naming, profile validation, AND ERS recording trigger decisions.

**Target responsibility (Wave 3):** Conference room naming and profile validation only. Recording trigger logic moves to ERS module.

**Public interface (target):**
- `resolveConferenceRoom(config, slot)` → room name string
- `getConferenceProfile(config)` → validated FS profile name
- `getConferenceString(config, slot)` → `"room@profile"`

**Known violation:** `conferenceManager.js` currently contains ERS-specific recording trigger logic and queries `ers_incidents` and `ers_configurations` directly. This is business logic in a platform service. Resolved in Wave 3.

---

## Recording Module
_File: `src/controllers/recordingController.js`_

**Responsibility:** Own the `recordings` table. Provide `upsertRecordingStart()` and recording lifecycle management. Serve recording files for playback and download.

**Public interface:**
- REST: `/api/v1/recordings/*`
- Function: `upsertRecordingStart({ type, confName, recPath, createdBy })`

**Permitted dependencies:**
- DB pool (`recordings` table)
- File system (recording directories)

**Forbidden:**
- Writing to ERS or ENS business tables
- Routing decisions
- ESL commands (except via ESL event handlers in `eslService.js`)

---

## Reporting
_File: `src/routes/v1/reports.js`_

**Responsibility:** Query and aggregate stored data for display. Never mutate business state. Never recalculate values that business modules are responsible for storing.

**Public interface:**
- REST: `/api/v1/reports/*` — read-only endpoints

**Permitted dependencies:**
- DB pool (read-only queries)
- `communication_sessions` (Wave 3+)
- `ers_*`, `ens_*` tables (read-only)
- `recordings` table (read-only)

**Forbidden:**
- Writing to any business table
- Calling Communication Engine
- ESL or provider access
- Recalculating business values that should be stored by business modules

---

## Authentication
_Files: `src/middleware/auth.js`, `src/middleware/rbac.js`, `src/controllers/authController.js`_

**Responsibility:** JWT issuance and verification, refresh token management, role-based access control.

**Roles:** `ADMIN > SUPERVISOR > OPERATOR > VIEWER`

**Rule:** Role checks use named RBAC middleware exports (`adminOrSuper`, `canTriggerEns`, etc.) — never inline role checks.

---

## Dependency Graph (simplified)

```
ENS ──────────────────────────────────────────────┐
ERS ─────────────────────────────────────────────►│ Communication Engine
IVR ──────────────────────────────────────────────┘
                                                   │
                                           Outbound Router
                                                   │
                                     ┌─────────────┴──────────────┐
                                Destination                  dialResolver.js
                                Classifier                  (gateway selection)
                                                                   │
                                                          Provider Layer
                                                                   │
                                                        FreeSWITCH ESL
```
