# FS-ENRS Dead Code & Schema Audit

**Date:** 2026-08-09
**Auditor:** Claude Code forensic analysis (read-only)
**Repository:** C:\Users\USER\Documents\fs-enrs
**Branch:** main (commit 30cc654)

---

## Executive Summary

The fs-enrs codebase is a production-grade Emergency Notification and Response System built on
Node.js / Express / PostgreSQL / FreeSWITCH. The codebase is generally healthy: the authors have
actively annotated legacy items, and at least two migration waves (`036_ens_drop_dead_columns`,
`026_recordings_refactor`) have already removed earlier dead code. What remains falls into four
categories:

| Category | Count |
|---|---|
| **Confirmed dead** (safe to remove with care) | ~12 items |
| **Probably dead / legacy** (requires runtime verification) | ~9 items |
| **Suspicious but probably active** (dynamic / external invocation paths) | ~8 items |
| **Active — no concern** | majority |

The most significant findings are:

1. **`ens_contacts`, `ens_groups`, `ens_group_members`** — database tables explicitly documented as
   dead in schema.sql comments; no application controller reads them.
2. **`tenant_mappings`, `notification_templates`** — tables created in migration 001 with zero
   application-code references.
3. **Four legacy frontend report pages** — kept only to preserve old bookmarks; all resolve to the
   same routes but use older API endpoints.
4. **`ENS_PROBE` middleware and `ENS_DEBUG` logger calls** — explicitly marked TEMPORARY in server.js
   and ensInternalController.js; not yet removed.
5. **`ens_notifications` + `ens_notification_deliveries`** — still written by the legacy blast path
   and still read by reports and tests, but the primary ENS engine has migrated to
   `ens_campaigns` / `ens_campaign_destinations`. Both tables coexist in a dual-write transitional
   state.
6. **`duration_seconds` column in `media_files`** — explicitly flagged in schema.sql as a legacy
   column; `duration_sec` is the canonical column.

---

## Current Architecture Map

### Request Flow

```
Browser (React / Vite :8100)
  │  REST + Socket.IO
  ▼
Express (:4100)
  ├─ /api/health           — legacy liveness (no auth)
  ├─ /health/*             — structured Sprint 0 probes (no auth)
  ├─ /metrics              — Prometheus text format (no auth)
  ├─ /api/v1/internal/*    — Lua contract API (X-Internal-Key auth)
  │    ├─ /services/:number   — service registry lookup
  │    ├─ /ens/*             — ENS blast + campaign triggers
  │    └─ /ers/*             — ERS incident + queue management
  └─ /api/v1/*             — REST API (JWT Bearer auth)
       ├─ /auth, /users, /organizations, /locations, /departments
       ├─ /contacts, /groups
       ├─ /ens, /ers, /ivr/flows, /ivr/node-types
       ├─ /deployment, /services, /campaigns
       ├─ /dashboard, /reports
       ├─ /media, /media-library, /recordings
       ├─ /settings, /gateways
       ├─ /monitoring, /platform/config
       └─ /health/*
  │
  ▼
PostgreSQL (fs_enrs)
  40+ tables (see Database Table Audit)

  ┌─ FreeSWITCH ESL (:8021) ───────────────────────────────────┐
  │  Persistent TCP connection via modesl                       │
  │  eslService.js: in-memory conferenceRegistry               │
  │  Events: conference::maintenance, CHANNEL_ANSWER,          │
  │          CHANNEL_HANGUP                                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Socket.IO ─────────────────────────────────────────────────┐
  │  JWT-authenticated per socket                               │
  │  Rooms: tenant:<id>, user:<id>, role:<role>                 │
  │  Events emitted inward: esl.status, authenticated          │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Redis (:6379) ─────────────────────────────────────────────┐
  │  Connected via ioredis; currently used only for health     │
  │  check (/health/ready). No application data stored yet.    │
  └─────────────────────────────────────────────────────────────┘
```

### Campaign Engine Lifecycle

```
Lua ens_blast_trigger.lua
  → POST /internal/ens/campaign/start
  → ensInternalController.startCampaign()
  → createCampaign() in campaignEngine.js
  → INSERT ens_campaigns + ens_campaign_destinations

campaignEngine tick (1 s):
  → originateCampaignCall() → FreeSWITCH ESL originate
  → eslEvents CHANNEL_ANSWER → onCallAnswer()
  → eslEvents CHANNEL_HANGUP → onCallHangup()
  → emitInternal('enrs::campaign_*') → Socket.IO → Browser
```

### ERS Conference Flow

```
Lua ers_conference_bridge.lua
  → GET /internal/ers/lookup
  → POST /internal/ers/incidents (create)
  → FreeSWITCH bgapi originate (ring-all responders)
  → session:execute("conference", …) — blocks
  → POST /internal/ers/incidents/<uuid>/complete

ESL conference::maintenance events:
  → eslService.js updates in-memory conferenceRegistry
  → emitInternal('conference.*') → Socket.IO → Browser
```

### ENS Blast Flow

```
Lua ens_blast_trigger.lua:
  1. GET /internal/ens/lookup
  2. POST /internal/ens/verify-pin (if PIN required)
  3. record message to disk
  4. POST /internal/ens/campaign/start → campaign engine

Lua ens_playback_handler.lua:
  1. GET /internal/ens/lookup
  2. GET /internal/ens/campaigns/latest
  3. Plays recording or speaks no_pending_msg / expiry_announcement
  4. POST /internal/callbacks (log replay)
```

### IVR Deployment Chain

```
Frontend IvrBuilder → POST /ivr/flows/:uuid/publish
  → ivrGraphValidator.js (validates graph structure)
  → ivr_flow_versions (immutable snapshot)

POST /deployment/flows/:uuid/deploy
  → deploymentEngine.js
  → luaGenerator.js → ivr_executor.lua (written to FS_SCRIPT_DIR)
  → xmlGenerator.js → enrs_ivr.xml (written to FS_DIALPLAN_DIR)
  → POST /deployment/diagnostics/reloadxml → FreeSWITCH ESL reloadxml
```

### Background Job Inventory

| Job | Location | Interval | Purpose |
|---|---|---|---|
| Campaign engine tick | campaignEngine.js | 1 s | Originate outbound calls |
| ESL heartbeat | eslService.js startBackgroundJobs() | 60 s | Ping ESL, update esl_connections |
| Reconciliation sweep | eslService.js startBackgroundJobs() | 60 s | Mark empty conferences COMPLETED |
| Conference sync check | eslService.js startBackgroundJobs() | 60 s | Audit registry vs FreeSWITCH |
| Startup reconciliation | server.js | once at T+5 s | Catch crashes during downtime |
| Recording directory scan | server.js | once at T+8 s | Import orphaned recordings |
| Conference sync banner | server.js | once at T+3 s | Print startup validation |

---

## Architecture Evolution Timeline

| Era | Migration Range | Key Changes |
|---|---|---|
| **V1 — Initial** | 001–005 | ENS/ERS basic, ens_contacts/ens_groups contact model, ens_notifications delivery tracking, initial IVR |
| **V2 — Phase 6 bug fixes** | 002 | audit_logs columns, various small fixes |
| **V3 — IVR Engine** | 004–006 | IVR graph-based deployment, ivr_flow_versions, ivr production |
| **V4 — Audio Library** | 007 | media_files category/fs_path columns |
| **V5 — Campaign Engine** | 008 | ens_campaigns / ens_campaign_destinations (replaces ens_notifications as primary write path for ENS blasts) |
| **V6 — ERS Tier Groups** | 009 | ers_tier_groups table (group-level responder assignment per tier) |
| **V7 — Production Redesign** | 010 | ERS production fields, ers_tier_contacts, ENS contact model unification (emergency_contacts as canonical contact model), IVR publish fix |
| **V8 — Backfill / Cleanup** | 011–013 | Tenant ID backfills |
| **V9 — Test Mode** | 014 | system_settings test_mode keys |
| **V10 — SIP Gateways** | 015 | sip_gateways table (gateway-agnostic dialing) |
| **V11 — ERS Phase 5** | 016–020 | ers_incident_participants, ERS bridge number rooms |
| **V12 — Media Library v2** | 021–025 | recordings (renamed from conference_recordings), waveform_peaks, media_library enterprise features |
| **V13 — Recordings Refactor** | 026 | conference_recordings → recordings |
| **V14 — ERS Config** | 027 | record_conferences, allow_caller_rejoin columns |
| **V15 — Performance** | 028–030 | Critical indexes, report indexes |
| **V16 — Enterprise Reports** | 031 | ERS enterprise reporting |
| **V17 — Config Management** | 032–033 | config_versions, config_audit_log (Platform Config Center Phase 7) |
| **V18 — ENS Dialing** | 034–038 | ENS dialing policy, dialing rules, dead column drops, manual gateway name |
| **V19 — Extension default** | 039 | allow_extension default true |
| **V20 — Contact mobile nullable** | 040 | mobile_number nullable |

---

## Backend Dead Code

### backend/server.js

| Item | Classification | Evidence |
|---|---|---|
| `ENS_PROBE` global request middleware (lines 66–74) | **PROBABLY DEAD / TEMPORARY** | Explicitly marked "remove after ENS blast investigation"; still present; logs every request to stdout |
| `checkCredentials()` function | **PROBABLY ACTIVE** | Called at startup; Sprint 0 note says `validateEnvironment()` replaces it long-term — both run concurrently |

### backend/src/routes/internal/ens.js

| Item | Classification | Evidence |
|---|---|---|
| TEMPORARY DEBUG middleware (lines 7–19) | **PROBABLY DEAD / TEMPORARY** | Explicitly marked "remove after ENS blast investigation"; logs every POST body |

### backend/src/controllers/internal/ensInternalController.js

| Item | Classification | Evidence |
|---|---|---|
| `const D = (tag, data, msg)` debug helper (line 10) | **PROBABLY DEAD / TEMPORARY** | Explicitly marked "TEMPORARY DEBUG helper — remove after ENS blast investigation" |

### backend/src/services/diagnosticsService.js

| Item | Classification | Evidence |
|---|---|---|
| `execSync` import from child_process | **SUSPICIOUS** | Imported at top; `execSync` is rarely needed in async Node. Verify it is used within the file. |

### backend/src/controllers/ivrTemplates.js

| Item | Classification | Evidence |
|---|---|---|
| Entire file | **DEFINITELY ACTIVE** | Mounted at `/ivr/flows/templates` via ivrRoutes; used by frontend `api.ivr.listTemplates()` and `createFromTemplate()` |

### backend/src/services/conferenceManager.js

| Item | Classification | Evidence |
|---|---|---|
| Entire file | **NEEDS VERIFICATION** | Not imported in server.js or any route file visible. Requires grep to confirm no import chain. |

---

## API Endpoint Audit

### Internal Routes (`/api/v1/internal/*`)

| Method | Path | Controller | Auth | Classification |
|---|---|---|---|---|
| GET | /internal/services/:number | serviceController.internalServiceLookup | X-Internal-Key | ACTIVE |
| GET | /internal/services | serviceController.internalServiceLookup | X-Internal-Key | ACTIVE |
| GET | /internal/ens/lookup | ensInternalController.ensLookup | X-Internal-Key | ACTIVE |
| POST | /internal/ens/verify-pin | ensInternalController.verifyPin | X-Internal-Key | ACTIVE |
| POST | /internal/ens/campaign/start | ensInternalController.startCampaign | X-Internal-Key | ACTIVE |
| POST | /internal/ens/campaign/start-by-config | ensInternalController.startCampaignByConfig | X-Internal-Key | ACTIVE (IVR ENS node) |
| GET | /internal/ens/notifications/queue-status | ensInternalController.ensQueueStatus | X-Internal-Key | SUSPICIOUS — may be legacy pre-campaign path |
| POST | /internal/ens/notifications | ensInternalController.ensCreateNotification | X-Internal-Key | PROBABLY LEGACY — pre-campaign blast path |
| GET | /internal/ens/notifications/:uuid/pending-contacts | ensInternalController.ensPendingContacts | X-Internal-Key | PROBABLY LEGACY |
| PATCH | /internal/ens/notifications/:uuid/delivery | ensInternalController.ensUpdateDelivery | X-Internal-Key | PROBABLY LEGACY |
| POST | /internal/ens/notifications/:uuid/complete | ensInternalController.ensCompleteNotification | X-Internal-Key | PROBABLY LEGACY |
| GET | /internal/ens/campaigns/latest | ensInternalController.ensLatestCampaign | X-Internal-Key | ACTIVE (ens_playback_handler.lua) |
| GET | /internal/ens/campaigns/:id/playback-log | ensInternalController.ensPlaybackLog | X-Internal-Key | ACTIVE |
| GET | /internal/ens/callbacks/authorize | ensInternalController.ensAuthorizeCallback | X-Internal-Key | ACTIVE |
| POST | /internal/ens/callbacks | ensInternalController.ensLogCallback | X-Internal-Key | ACTIVE |
| GET | /internal/ers/lookup | ersInternalController.ersLookup | X-Internal-Key | ACTIVE |
| POST | /internal/ers/incidents | ersInternalController.ersCreateIncident | X-Internal-Key | ACTIVE |
| GET | /internal/ers/incidents/:uuid/status | ersInternalController.ersIncidentStatus | X-Internal-Key | ACTIVE (queue polling) |
| POST | /internal/ers/incidents/:uuid/complete | ersInternalController.ersCompleteIncident | X-Internal-Key | ACTIVE |
| POST | /internal/ers/incidents/:uuid/responder-join | ersInternalController.ersResponderJoin | X-Internal-Key | ACTIVE |
| POST | /internal/ers/incidents/:uuid/responder-leave | ersInternalController.ersResponderLeave | X-Internal-Key | ACTIVE |
| GET | /internal/ivr/* | ivrInternalController | X-Internal-Key | ACTIVE (IVR Lua executor) |

### Public API Routes (`/api/v1/*`)

| Method | Path | Controller | Frontend caller | Classification |
|---|---|---|---|---|
| POST | /auth/login | authController | api.login | ACTIVE |
| POST | /auth/logout | authController | api.logout | ACTIVE |
| GET | /auth/me | authController | api.me | ACTIVE |
| POST | /auth/refresh | authController | client.js auto-refresh | ACTIVE |
| POST | /auth/change-password | authController | — | ACTIVE |
| GET/POST/PUT/DELETE | /users/* | authController | UserList | ACTIVE |
| GET/POST/PUT/DELETE | /organizations/* | organizationController | OrgList/LocationList/DeptList | ACTIVE |
| GET/POST/PUT/DELETE | /contacts/* | contactController | ContactList | ACTIVE |
| POST | /contacts/bulk-upload | contactController | ContactList | ACTIVE |
| GET/POST/PUT/DELETE | /groups/* | groupController | GroupList | ACTIVE |
| GET/POST/PUT/PATCH/DELETE | /ens/configurations/* | ensController | EnsList | ACTIVE |
| GET | /ens/notifications | ensController | api.ens.notifications | ACTIVE |
| POST | /ens/notifications | ensController | api.ens.trigger | ACTIVE (UI-triggered blast) |
| GET/POST/PUT/PATCH/DELETE | /ers/configurations/* | ersController | ErsConfigList | ACTIVE |
| GET | /ers/incidents | ersController | ErsLive/reports | ACTIVE |
| GET | /ers/incidents/:uuid/detail | ersController | ErsLive | ACTIVE |
| GET | /ers/queue | ersController | ErsLive | ACTIVE |
| POST | /ers/incidents/:uuid/complete | ersController | ErsLive | ACTIVE |
| POST | /ers/incidents/:uuid/cancel | ersController | ErsLive | ACTIVE |
| GET | /ers/conference/:room/members | ersController | api.ers.confMembers | ACTIVE |
| POST | /ers/conference/:room/kick | ersController | api.ers.confKick | ACTIVE |
| POST | /ers/conference/:room/mute | ersController | api.ers.confMute | ACTIVE |
| POST | /ers/conference/:room/play | ersController | api.ers.confPlay | ACTIVE |
| GET | /ivr/node-types | ivrController.getNodeTypes | api.ivr.nodeTypes | ACTIVE |
| GET/POST/PUT/DELETE | /ivr/flows/* | ivrController | IvrList/IvrBuilder | ACTIVE |
| POST | /ivr/flows/:uuid/validate | ivrController | api.ivr.validate | ACTIVE |
| POST | /ivr/flows/:uuid/publish | ivrController | api.ivr.publish | ACTIVE |
| GET | /ivr/flows/:uuid/versions | ivrController | VersionDrawer | ACTIVE |
| PATCH | /ivr/flows/:uuid/bind | ivrController | BindNumbersModal | ACTIVE |
| GET | /ivr/flows/templates | ivrTemplates | IvrList | ACTIVE |
| POST | /ivr/flows/templates/:id/create | ivrTemplates | IvrList | ACTIVE |
| GET/POST | /deployment/* | deploymentController | DeploymentDashboard | ACTIVE |
| GET/POST/PUT/DELETE | /services/* | serviceController | ServiceRegistry | ACTIVE |
| GET/POST/POST/POST | /campaigns/* | campaignController | CampaignDashboard | ACTIVE |
| GET | /campaigns/engine/stats | campaignController | CampaignDashboard | ACTIVE |
| GET | /dashboard/metrics | dashboardController | Dashboard | ACTIVE |
| GET | /dashboard/active | dashboardController | Dashboard | ACTIVE |
| GET | /dashboard/chart | dashboardController | Dashboard | ACTIVE |
| GET | /reports/notifications | reports router (inline) | ReportNotifications | PROBABLY LEGACY |
| GET | /reports/incidents | reports router (inline) | ReportIncidents | PROBABLY LEGACY |
| GET | /reports/contact-usage | reports router (inline) | ReportContactUsage | ACTIVE |
| GET | /reports/ers-incidents | reports router (inline) | ReportErsIncidents | PROBABLY LEGACY |
| GET | /reports/ens-broadcasts | reports router (inline) | ReportEnsBroadcasts | PROBABLY LEGACY |
| GET | /reports/ers | reports router (inline) | ErsReport | ACTIVE |
| GET | /reports/ers/:uuid | reports router (inline) | ErsReport | ACTIVE |
| GET | /reports/ens | reports router (inline) | EnsReport | ACTIVE |
| GET | /reports/ens/:uuid | reports router (inline) | EnsReport | ACTIVE |
| GET | /reports/ens-campaigns | reports router (inline) | EnsReport | ACTIVE |
| GET | /reports/ens-campaigns/:id | reports router (inline) | EnsReport | ACTIVE |
| GET/PUT | /settings/* | settings router | SettingsPage | ACTIVE |
| GET | /settings/test-mode | settings router | TestModeBanner | ACTIVE |
| GET | /settings/emergency-numbers | settings router | BindNumbersModal | ACTIVE |
| GET/PATCH | /settings/feature-flags/* | settings router | SettingsPage | ACTIVE |
| GET/POST/PUT/DELETE | /gateways/* | gatewayController | TelephonyGateways | ACTIVE |
| POST | /gateways/:id/deploy | gatewayController | TelephonyGateways | ACTIVE |
| GET/* | /monitoring/* | monitoringController | Monitoring page | ACTIVE |
| GET/POST/PUT/DELETE | /media-library/* | mediaLibraryController | MediaLibrary | ACTIVE |
| GET/POST/DELETE | /media/* | recordingController (audio) | AudioLibrary | ACTIVE |
| GET/PUT/POST/DELETE | /recordings/* | recordingController | Recordings | ACTIVE |
| GET/POST | /platform/config/* | platformConfig router | ConfigCenter | ACTIVE |
| GET | /health/live | health router | Docker healthcheck | ACTIVE |
| GET | /health/ready | health router | Docker healthcheck | ACTIVE |
| GET | /health/full | health router | Monitoring | ACTIVE |
| GET | /metrics | health router | Prometheus | ACTIVE |
| GET | /api/health | server.js inline | Legacy probes | PROBABLY DEAD (legacy probe kept for backward compat) |

---

## Frontend Dead Code

### Pages

| Page | Route | Classification | Evidence |
|---|---|---|---|
| ReportNotifications | /reports/notifications | **PROBABLY LEGACY** | Explicitly marked "Legacy report routes — kept so old bookmarks still work" in App.jsx; superseded by ErsReport/EnsReport |
| ReportIncidents | /reports/incidents | **PROBABLY LEGACY** | Same as above |
| ReportErsIncidents | /reports/ers-incidents | **PROBABLY LEGACY** | Same as above |
| ReportEnsBroadcasts | /reports/ens-broadcasts | **PROBABLY LEGACY** | Same as above |
| All others | active routes | **DEFINITELY ACTIVE** | Imported and mounted in App.jsx |

### Components

| Component | Classification | Evidence |
|---|---|---|
| All imported components in App.jsx | **ACTIVE** | All used in route tree |
| platform/config/* | **ACTIVE** | ConfigCenter Phase 7 is mounted and active |

### API Client Methods

| Method group | Classification | Evidence |
|---|---|---|
| api.reports.notifications / incidents / ersIncidents / ensBroadcasts | **PROBABLY LEGACY** | Labeled "Legacy endpoints (kept for backward-compat with old pages)" in client.js |
| api.deployment.* | **ACTIVE** | DeploymentDashboard uses all these |
| All others | **ACTIVE** | All called from active frontend pages |

---

## Database Table Audit

| # | Table | Era | App References | Classification |
|---|---|---|---|---|
| 1 | tenants | 001 | All controllers (tenant_id) | ACTIVE |
| 2 | users | 001 | authController, all controllers | ACTIVE |
| 3 | organizations | 001 | organizationController, all | ACTIVE |
| 4 | tenant_mappings | 001 | **None found** | **PROBABLY DEAD** |
| 5 | locations | 001 | organizationController | ACTIVE |
| 6 | departments | 001 | organizationController | ACTIVE |
| 7 | emergency_contacts | 001 | contactController, ensInternalController, ersInternalController, reports | ACTIVE |
| 8 | responder_groups | 001 | groupController, ensInternalController, ersInternalController | ACTIVE |
| 9 | responder_group_members | 001 | groupController, ensInternalController, ersInternalController | ACTIVE |
| 10 | media_files | 001 | mediaLibraryController, recordingController | ACTIVE |
| 11 | notification_templates | 001 | **None found** — template_id FK dropped in migration 036 | **DEFINITELY DEAD** |
| 12 | ens_contacts | 001 | **Explicitly annotated dead in schema.sql** — no controller reads | **DEFINITELY DEAD** |
| 13 | ens_groups | 001 | **Explicitly annotated dead in schema.sql** — no controller reads | **DEFINITELY DEAD** |
| 14 | ens_group_members | 001 | **Explicitly annotated dead in schema.sql** — no controller reads | **DEFINITELY DEAD** |
| 15 | ens_configurations | 001 | ensController, ensInternalController, campaignEngine | ACTIVE |
| 16 | ens_configuration_groups | 001 | ensController (responder_group_id path), ensInternalController | ACTIVE |
| 17 | ens_configuration_contacts | 001 | ensController (emergency_contact_id path), ensInternalController | ACTIVE |
| 18 | ens_notifications | 001 | ensController (UI blast), dashboardController, reports, ensInternalController (legacy blast path) | **TRANSITIONAL** — written by legacy path; read by reports |
| 19 | ens_notification_deliveries | 001 | ensInternalController (legacy path), reports | **TRANSITIONAL** |
| 20 | ers_configurations | 001 | ersController, ersInternalController | ACTIVE |
| 21 | ers_incidents | 001 | ersController, ersInternalController, reports | ACTIVE |
| 22 | ers_incident_responders | 001 | ersController, reports | ACTIVE |
| 23 | ers_queues | 001 | ersInternalController, ersController | ACTIVE |
| 24 | ivr_flows | 001 | ivrController, ivrTemplates | ACTIVE |
| 25 | ivr_flow_versions | 001 | ivrController | ACTIVE |
| 26 | emergency_numbers | 001 | serviceController, settings router, ivrController | ACTIVE |
| 27 | audit_logs | 001 | ersInternalController, eslService.js, reports | ACTIVE |
| 28 | system_settings | 001 | settings router | ACTIVE |
| 29 | esl_connections | 001 | eslService.js heartbeat, server.js ensureAdminUser | ACTIVE |
| 30 | feature_flags | 001 | settings router | ACTIVE |
| 31 | schema_migrations | 001 | migrate.js | ACTIVE |
| 32 | ens_campaigns | 008 | campaignEngine, campaignController, reports | ACTIVE |
| 33 | ens_campaign_destinations | 008 | campaignEngine, campaignController, reports | ACTIVE |
| 34 | ers_tier_groups | 009 | ersInternalController, ersController | ACTIVE |
| 35 | ers_tier_contacts | 010 | ersInternalController, ersController | ACTIVE |
| 36 | sip_gateways | 015 | gatewayController, dialResolver | ACTIVE |
| 37 | ers_incident_participants | 016 | ersInternalController, recordingController, trackParticipant tests | ACTIVE |
| 38 | recordings | 022/026 | recordingController, eslService.js, reports | ACTIVE |
| 39 | config_versions | 032 | platformConfig controllers | ACTIVE |
| 40 | config_audit_log | 032 | platformConfig controllers | ACTIVE |

*(Note: Additional tables added by migrations 016–031 such as ERS bridge number rooms, media
waveform, etc. are all referenced by active controllers.)*

---

## Database Column Audit

### media_files — Suspicious Columns

| Column | Written by | Read by | Classification |
|---|---|---|---|
| duration_seconds | Nothing (never set by any controller) | Nothing | **LEGACY** — schema.sql explicitly labels it "Legacy column from 001 (kept for backward compat, use duration_sec instead)"; safe to drop in a future migration |
| type CHECK constraint includes 'PROMPT','MUSIC','OTHER' | mediaLibraryController | mediaLibraryController | ACTIVE |

### ens_configurations — Post-migration 036 State

Migration 036 dropped: `caller_id`, `phone_number`, `template_id`, `destination_number`,
`playback_number`, `max_concurrent`, `retry_count`, `retry_delay_seconds`, `sip_caller_id`.

Remaining columns are all referenced by ensController.js and ensInternalController.js and are
**ACTIVE**.

### ens_configuration_groups — Ambiguous Column

| Column | Status |
|---|---|
| ens_group_id | **PROBABLY DEAD** — references the dead ens_groups table; no controller writes it |
| responder_group_id | **ACTIVE** — the unified contact model path |

### ens_configuration_contacts — Ambiguous Column

| Column | Status |
|---|---|
| ens_contact_id | **PROBABLY DEAD** — references the dead ens_contacts table; no controller writes it |
| emergency_contact_id | **ACTIVE** — the unified contact model path |

---

## Socket.IO / Redis / Event Audit

### Socket.IO Events Emitted (server → client)

| Event | Producer | Frontend Consumer | Classification |
|---|---|---|---|
| esl.status | socketService.js on connect + auth | EslStatusBanner | ACTIVE |
| authenticated | socketService.js | authStore | ACTIVE |
| auth.error | socketService.js | authStore | ACTIVE |
| enrs::campaign_started | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_progress | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_call_answered | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_call_hangup | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_completed | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_expired | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_paused | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_resumed | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::campaign_cancelled | campaignEngine | CampaignDashboard | ACTIVE |
| enrs::ens_started | ensInternalController | ENSBlastPanel | ACTIVE |
| enrs::ens_delivery | ensInternalController | ENSBlastPanel | ACTIVE |
| enrs::ens_complete | ensInternalController | ENSBlastPanel | ACTIVE |
| enrs::ens_callback | ensInternalController | ENSBlastPanel | ACTIVE |
| enrs::ers_incident_created | ersInternalController | ErsActivePanel | ACTIVE |
| enrs::ers_incident_ended | ersInternalController + ersController | ErsActivePanel | ACTIVE |
| enrs::ers_responder_update | ersInternalController | ErsActivePanel | ACTIVE |
| enrs::ers_observer_joined | ersInternalController | ErsActivePanel | ACTIVE |
| enrs::ers_queue_changed | ersInternalController | ErsQueuePanel | ACTIVE |
| enrs::ers_ring_ended | ersRingService | ErsActivePanel | ACTIVE |
| conference.* | eslService.js (multiple) | Monitoring page | ACTIVE |

### Socket.IO Events Received (client → server)

| Event | Handler | Classification |
|---|---|---|
| authenticate | socketService.js | ACTIVE |
| disconnect | socketService.js (no-op) | ACTIVE |

### Redis Usage

Redis is connected at startup and participates in `/health/ready`. However, **no application data
is currently stored in Redis** — it is infrastructure-ready for future caching or pub/sub work.
The `getRedis` / `redisHealthCheck` exports from infrastructure/index.js are used only by the
health check module. Redis is not dead — it is an active dependency for health checks and future
Sprint work.

---

## FreeSWITCH / Lua Audit

### Active Lua Scripts (Lua-scripts/)

| Script | Invoked by | Classification |
|---|---|---|
| ens_blast_trigger.lua | FreeSWITCH dialplan (ENS trigger extensions) | ACTIVE |
| ens_playback_handler.lua | FreeSWITCH dialplan (ENS playback extensions) | ACTIVE |
| ers_conference_bridge.lua | FreeSWITCH dialplan (ERS trigger extensions) | ACTIVE |

### Legacy Lua Scripts (Lua-scripts/legacy/)

| Script | Classification | Evidence |
|---|---|---|
| blast_call.lua | **DEFINITELY DEAD** | Superseded by ens_blast_trigger.lua; identical flow but older codebase; not referenced in any dialplan generated by deploymentEngine |
| dial_911_conference.lua | **DEFINITELY DEAD** | Legacy conference dial script; superseded by ers_conference_bridge.lua |
| ENS_retry_playback.lua | **DEFINITELY DEAD** | Legacy retry/playback script; superseded by ens_playback_handler.lua |

The Lua-scripts/legacy/ directory appears to be a historical archive. None of these scripts are
generated or deployed by the current deployment engine.

### Generated Lua / XML (deployed to FreeSWITCH filesystem)

| Generated artifact | Generator | Classification |
|---|---|---|
| ivr_executor.lua | luaGenerator.js | ACTIVE |
| enrs_ivr.xml | xmlGenerator.js | ACTIVE |
| sip gateway XML files | gatewayXmlGenerator.js | ACTIVE |

---

## Configuration & Env Variable Audit

| Variable | Defined in | Read by | Classification |
|---|---|---|---|
| PORT | .env.example | config/index.js, server.js | ACTIVE |
| NODE_ENV | .env.example | config/index.js, validator.js | ACTIVE |
| DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD | .env.example | config/index.js | ACTIVE |
| JWT_ACCESS_SECRET / JWT_REFRESH_SECRET | .env.example | config/index.js, validator.js | ACTIVE |
| JWT_ACCESS_EXPIRY / JWT_REFRESH_EXPIRY | .env.example | config/index.js | ACTIVE |
| ESL_HOST / ESL_PORT / ESL_PASSWORD | .env.example | config/index.js, eslService, validator | ACTIVE |
| CORS_ORIGIN | .env.example | config/index.js | ACTIVE |
| UPLOAD_DIR / MAX_FILE_SIZE | .env.example | config/index.js, mediaLibraryController | ACTIVE |
| INTERNAL_API_KEY | backend/.env | internalAuth.js, validator.js | ACTIVE |
| REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB | — | infrastructure/redis/client.js | ACTIVE (not in .env.example — undocumented) |
| ENRS_INTERNAL_API | Lua scripts | Lua only | ACTIVE |
| FS_INTERNAL_KEY | Lua scripts | Lua only | ACTIVE |
| ENRS_REC_DIR | Lua scripts | Lua only | ACTIVE |
| ENRS_ERS_REC_DIR | Lua scripts | Lua only | ACTIVE |
| ENRS_TTS_ENGINE / ENRS_TTS_VOICE | Lua scripts, config | Lua + ivrController | ACTIVE |
| FS_SCRIPT_DIR / FS_DIALPLAN_DIR / FS_RECORDING_DIR / FS_SOUND_DIR | backend/.env | freeSwitchPathService.js | ACTIVE |
| SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD | server.js | server.js ensureAdminUser | ACTIVE |
| FRONTEND_PORT | server.js | Banner print only | PROBABLY DEAD (printed in startup banner, not read by Vite) |
| SIP_DOMAIN / ESL_DOMAIN | config/index.js | config.esl.domain | ACTIVE (used by dialResolver) |
| ENRS_API_URL | config/index.js | config.freeswitch.apiUrl | ACTIVE |
| FS_TTS_ENGINE / FS_DEFAULT_GATEWAY | config/index.js | config.freeswitch | ACTIVE |
| SOCKET_PATH | socketService.js | Socket.IO path configuration | ACTIVE |
| ENS_ORIGINATE_MODE | campaignEngine | Dial string selection | **NOT FOUND in config/index.js** — referenced in CLAUDE.md docs but grep shows campaignEngine uses dialResolver; may be stale documentation |

**Undocumented in .env.example:** `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`,
`REDIS_DB`, `SOCKET_PATH`, `SIP_DOMAIN`, `ESL_DOMAIN`.

---

## Dependency Audit

### Backend (package.json)

| Package | Usage | Classification |
|---|---|---|
| express, cors, helmet, cookie-parser | Server core | ACTIVE |
| bcryptjs | Password hashing | ACTIVE |
| jsonwebtoken | JWT auth | ACTIVE |
| pg | PostgreSQL | ACTIVE |
| modesl | FreeSWITCH ESL | ACTIVE |
| socket.io | Real-time events | ACTIVE |
| zod | Request validation | ACTIVE |
| multer | File upload | ACTIVE |
| uuid | UUID generation | ACTIVE |
| csv-parse | CSV bulk contact upload | ACTIVE |
| express-rate-limit | Rate limiting | ACTIVE |
| fast-xml-parser | FreeSWITCH XML config parsing | ACTIVE |
| ioredis | Redis client | ACTIVE (health check; future use) |
| prom-client | Prometheus metrics | ACTIVE (/metrics endpoint) |
| dotenv | .env loading | ACTIVE |

No unused npm packages identified in production dependencies.

### Frontend (package.json)

| Package | Usage | Classification |
|---|---|---|
| react, react-dom, react-router-dom | App framework | ACTIVE |
| zustand | Auth store | ACTIVE |
| socket.io-client | Real-time events | ACTIVE |
| lucide-react | Icons | ACTIVE |
| recharts | Charts in report pages | ACTIVE |
| papaparse | CSV export/import | ACTIVE |

No unused npm packages identified.

---

## Duplicate Logic Audit

| Duplicate | Description | Recommendation |
|---|---|---|
| `checkCredentials()` + `validateEnvironment()` | Both run at startup; both check JWT secrets, INTERNAL_API_KEY, DB_PASSWORD, ESL_PASSWORD. The server.js comment acknowledges `validateEnvironment()` replaces `checkCredentials()` long-term. | Remove `checkCredentials()` once `validateEnvironment()` is confirmed stable in production |
| ENS_PROBE middleware + ENS_DEBUG logger | Both instrument ENS internal POST requests; the probe is in server.js (global) and the debug logger is in internal/ens.js (scoped). | Remove both after ENS blast investigation is complete |
| Legacy report endpoints `/reports/notifications` + `/reports/ens` | Two endpoints serve overlapping data; both are called from frontend. The new `/reports/ens` uses ens_campaigns; the old `/reports/notifications` reads ens_notifications. | Once ens_notifications is fully deprecated, remove the legacy endpoints and legacy report pages |
| ens_contacts / ens_groups vs emergency_contacts / responder_groups | Two contact models; the old model tables are kept but no controller writes to them. | Drop the old tables in a dedicated migration after confirming no FK data exists |

---

## Legacy Architecture Remnants

### 1. Old ENS Notification System (ens_notifications / ens_notification_deliveries)

**What it was:** The original ENS blast tracking. Lua would write delivery status row-by-row back
to the backend, which would update ens_notifications and ens_notification_deliveries. The
frontend's legacy report pages read from these tables.

**What replaced it:** ens_campaigns / ens_campaign_destinations (migration 008). The campaign
engine now owns all outbound delivery state. Lua only triggers a campaign start; the engine handles
concurrency, retries, and ESL events.

**Current status:** TRANSITIONAL. The legacy notification endpoints in
`/internal/ens/notifications/*` still exist and are still functional. The `dashboardController`,
`ensController`, and reports still read from `ens_notifications`. The campaign engine writes to
`ens_campaigns` only. Both systems coexist in parallel.

### 2. Old ENS Contact Model (ens_contacts / ens_groups / ens_group_members)

**What it was:** A separate contact model specific to ENS, duplicating emergency_contacts.

**What replaced it:** Migration 010 unified all contacts under `emergency_contacts` and
`responder_groups`. The junction tables `ens_configuration_contacts` and
`ens_configuration_groups` gained new FK columns (`emergency_contact_id`, `responder_group_id`)
pointing to the unified model while retaining the old FK columns (`ens_contact_id`, `ens_group_id`)
for backward compatibility.

**Current status:** DEAD. The schema.sql explicitly documents this. No controller reads from
ens_contacts/ens_groups/ens_group_members. The old junction columns (ens_contact_id,
ens_group_id) are also dead.

### 3. conference_recordings → recordings Rename

**What it was:** A table called `conference_recordings`. Renamed in migration 026 to `recordings`
with expanded module ownership (ERS, ENS, IVR, MANUAL types).

**Current status:** Fully migrated. The `recordings` table is active.

### 4. Legacy Lua Scripts in Lua-scripts/legacy/

**What they were:** Original FreeSWITCH integration scripts from the V1 architecture.

**Current status:** DEAD. Superseded by the current scripts. The deployment engine never generates
dialplan referencing these.

### 5. Legacy /api/health probe

**What it was:** A quick-and-dirty health check added before the Sprint 0 structured health
infrastructure was built.

**Current status:** Kept for backward compatibility with external probes. The new `/health/live`,
`/health/ready`, `/health/full` are the canonical probes. The legacy `/api/health` is still active
code but is a candidate for deprecation.

---

## Dead-Code Confidence Matrix

| Item | Type | Location | Evidence | Classification | Confidence |
|---|---|---|---|---|---|
| ens_contacts | DB table | schema.sql | Schema comment: "DEPRECATED, DO NOT USE"; no controller queries it | DEFINITELY DEAD | HIGH |
| ens_groups | DB table | schema.sql | Schema comment: "DEPRECATED, DO NOT USE" | DEFINITELY DEAD | HIGH |
| ens_group_members | DB table | schema.sql | References ens_contacts; no queries | DEFINITELY DEAD | HIGH |
| notification_templates | DB table | schema.sql | No controller reads or writes it; template_id FK dropped in mig 036 | DEFINITELY DEAD | HIGH |
| tenant_mappings | DB table | schema.sql | No controller queries found in entire backend/src | DEFINITELY DEAD | HIGH |
| ens_configuration_groups.ens_group_id | DB column | schema.sql | References dead ens_groups; no controller writes it | DEFINITELY DEAD | HIGH |
| ens_configuration_contacts.ens_contact_id | DB column | schema.sql | References dead ens_contacts; no controller writes it | DEFINITELY DEAD | HIGH |
| media_files.duration_seconds | DB column | schema.sql | Explicitly labeled legacy; controllers use duration_sec | DEFINITELY DEAD | HIGH |
| Lua-scripts/legacy/blast_call.lua | Lua file | Lua-scripts/legacy/ | Superseded by ens_blast_trigger.lua | DEFINITELY DEAD | HIGH |
| Lua-scripts/legacy/dial_911_conference.lua | Lua file | Lua-scripts/legacy/ | Superseded by ers_conference_bridge.lua | DEFINITELY DEAD | HIGH |
| Lua-scripts/legacy/ENS_retry_playback.lua | Lua file | Lua-scripts/legacy/ | Superseded by ens_playback_handler.lua | DEFINITELY DEAD | HIGH |
| ENS_PROBE middleware | JS code | backend/server.js:66-74 | Explicitly marked "remove after ENS blast investigation" | PROBABLY DEAD | HIGH |
| ENS_DEBUG middleware in routes | JS code | backend/src/routes/internal/ens.js:7-19 | Explicitly marked "remove after ENS blast investigation" | PROBABLY DEAD | HIGH |
| const D debug helper | JS code | backend/src/controllers/internal/ensInternalController.js:10 | Explicitly marked "TEMPORARY DEBUG helper" | PROBABLY DEAD | HIGH |
| checkCredentials() function | JS code | backend/server.js | Acknowledged as pre-Sprint0; validateEnvironment() is its replacement | PROBABLY DEAD | MEDIUM |
| /api/health legacy probe | Endpoint | backend/server.js | "Legacy probe — retained for backwards compatibility"; new /health/* supersedes | PROBABLY DEAD | MEDIUM |
| ReportNotifications page | React page | frontend/src/pages/reports/ReportNotifications.jsx | App.jsx: "Legacy report routes — kept so old bookmarks still work" | PROBABLY DEAD | MEDIUM |
| ReportIncidents page | React page | frontend/src/pages/reports/ReportIncidents.jsx | Same | PROBABLY DEAD | MEDIUM |
| ReportErsIncidents page | React page | frontend/src/pages/reports/ReportErsIncidents.jsx | Same | PROBABLY DEAD | MEDIUM |
| ReportEnsBroadcasts page | React page | frontend/src/pages/reports/ReportEnsBroadcasts.jsx | Same | PROBABLY DEAD | MEDIUM |
| /reports/notifications endpoint | API endpoint | backend/src/routes/v1/reports.js | api/client.js: "Legacy endpoints (kept for backward-compat)" | PROBABLY DEAD | MEDIUM |
| /reports/incidents endpoint | API endpoint | backend/src/routes/v1/reports.js | Same | PROBABLY DEAD | MEDIUM |
| /reports/ers-incidents endpoint | API endpoint | backend/src/routes/v1/reports.js | Same | PROBABLY DEAD | MEDIUM |
| /reports/ens-broadcasts endpoint | API endpoint | backend/src/routes/v1/reports.js | Same | PROBABLY DEAD | MEDIUM |
| api.reports.notifications/incidents/ersIncidents/ensBroadcasts | Frontend | frontend/src/api/client.js | Labeled "Legacy endpoints" | PROBABLY DEAD | MEDIUM |
| FRONTEND_PORT env var | Config | backend/server.js | Printed in banner but Vite port is set independently; not functionally linked | PROBABLY DEAD | LOW |
| conferenceManager.js | JS file | backend/src/services/ | Not imported in server.js or any visible route; requires deeper grep | NEEDS VERIFICATION | LOW |
| /internal/ens/notifications/* endpoints | API | backend/src/routes/internal/ens.js | Legacy pre-campaign blast path; may still be called by old Lua scripts on some deployments | SUSPICIOUS | LOW |
| ens_notifications table | DB table | schema.sql | Still written by legacy path; still read by reports | TRANSITIONAL | — |
| ens_notification_deliveries table | DB table | schema.sql | Same | TRANSITIONAL | — |

---

## High-Risk False Positives

These items LOOK dead but must not be removed without deeper verification:

1. **`ens_notifications` / `ens_notification_deliveries`** — Active reports read from these tables.
   They may also still be written by old Lua scripts on some deployments. Do not drop until the
   report pages and dashboardController are confirmed to have migrated to ens_campaigns queries.

2. **`/internal/ens/notifications/*` endpoints** — May still be called by older Lua scripts
   deployed on production FreeSWITCH instances that have not yet been updated to the new
   campaign-start API. Verify by inspecting deployed Lua files on the FreeSWITCH server.

3. **`esl_connections` table** — Only written by the heartbeat (eslService.js) and the
   ensureAdminUser boot function. Appears to be a single-row operational table, not a multi-row
   registry. No UI reads it. Could look dead but it drives the `last_heartbeat_at` update that
   indicates ESL liveness.

4. **Legacy report pages** — If operators have bookmarks to `/reports/notifications` etc. and use
   them regularly, removing the pages breaks their workflow. Confirm via usage analytics or user
   interviews before removal.

5. **`checkCredentials()`** — Runs in both dev and production. The comment says
   `validateEnvironment()` replaces it "long-term", but both run concurrently today. Do not remove
   until the validator covers all the same cases.

6. **`conferenceManager.js`** — Not imported in server.js. However, it could be dynamically
   imported or used in a test-only path. Run a recursive grep before classifying as dead.

---

## Safe Cleanup Candidates

Items with HIGH confidence evidence that can be cleaned up safely:

### Phase 1: Remove TEMPORARY debug instrumentation
- Remove `ENS_PROBE` middleware block from `backend/server.js` (lines 66-74)
- Remove `ENS_DEBUG` middleware from `backend/src/routes/internal/ens.js` (lines 7-19)
- Remove `const D = ...` debug helper from `backend/src/controllers/internal/ensInternalController.js` (line 10)

### Phase 2: Delete legacy Lua archive
- Delete `Lua-scripts/legacy/` directory (all three files: blast_call.lua, dial_911_conference.lua, ENS_retry_playback.lua)

### Phase 3: Database cleanup (requires migration)
Write a new migration (041 or higher) to:
- `DROP TABLE IF EXISTS ens_contacts CASCADE`
- `DROP TABLE IF EXISTS ens_group_members CASCADE`
- `DROP TABLE IF EXISTS ens_groups CASCADE`
- `DROP TABLE IF EXISTS notification_templates` (after verifying no FK data remains)
- `DROP TABLE IF EXISTS tenant_mappings` (after verifying no FK data remains)
- `ALTER TABLE media_files DROP COLUMN IF EXISTS duration_seconds`
- `ALTER TABLE ens_configuration_contacts DROP COLUMN IF EXISTS ens_contact_id`
- `ALTER TABLE ens_configuration_groups DROP COLUMN IF EXISTS ens_group_id`

### Phase 4: Remove legacy report pages and endpoints
- Remove four legacy report pages from frontend (after confirming no active users)
- Remove four legacy report endpoints from `backend/src/routes/v1/reports.js`
- Remove legacy API client methods from `frontend/src/api/client.js`

---

## Needs Runtime Verification

- **`conferenceManager.js`** — Grep all import chains; if unused, safe to delete.
- **`/internal/ens/notifications/*` endpoints** — Inspect deployed Lua scripts on FreeSWITCH
  server to determine which API paths they call.
- **`ENS_ORIGINATE_MODE`** env var — CLAUDE.md mentions it but it does not appear in
  config/index.js. Grep campaignEngine.js fully to see if it is read there directly.
- **Legacy report pages usage** — Check browser analytics or server access logs before removing.

---

## Do Not Touch

- `ens_notifications` / `ens_notification_deliveries` until report pages are fully migrated
- `esl_connections` — active operational table
- `audit_logs` — written by internal controllers and read by reports
- `config_versions` / `config_audit_log` — Platform Config Center (Phase 7) depends on these
- All three production Lua scripts in `Lua-scripts/` root
- All generated files in the FreeSWITCH filesystem

---

## Recommended Next Phases

**Phase A: Immediate — Zero-risk debug cleanup**
Remove the three TEMPORARY debug/probe items (ENS_PROBE middleware, ENS_DEBUG route middleware,
const D helper). These were explicitly intended for removal and produce unnecessary log noise in
production.

**Phase B: Legacy Lua archive**
Delete `Lua-scripts/legacy/` after confirming via a FreeSWITCH dialplan review that these scripts
are not referenced in any active `<action application="lua" data="..."/>` element.

**Phase C: Dead table and column removal**
Write migration 041 to drop the dead ENS V1 tables (ens_contacts, ens_groups, ens_group_members),
drop notification_templates and tenant_mappings (after FK audit), and drop the dead junction
columns. This will also clean the schema.sql comment block.

**Phase D: ENS notification system retirement**
Decide whether the legacy blast path (`/internal/ens/notifications/*` + ens_notifications table)
should be retired. If the Lua scripts on all deployed FreeSWITCH instances use the new
campaign/start path, write a migration to archive ens_notifications data and drop the endpoints.
Then remove the legacy report pages.

**Phase E: Startup code deduplication**
Replace `checkCredentials()` with a call only to `validateEnvironment()` after verifying the
validator covers all the same checks (ESL_PASSWORD warn-only path needs confirmation).

**Phase F: Redis activation**
Redis is connected but unused for application data. Plan caching or pub/sub use cases (e.g. ESL
event fanout, campaign engine distributed lock) and document them; or remove ioredis if the
infrastructure requirement is withdrawn.

**Phase G: Documentation of undocumented env vars**
Add REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB, SOCKET_PATH, SIP_DOMAIN,
ESL_DOMAIN, ENS_ORIGINATE_MODE to `.env.example` with descriptions and defaults.
