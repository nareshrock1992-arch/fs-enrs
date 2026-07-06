# ARCHITECTURE — fs-enrs Enterprise Emergency Communication Platform

## System Overview

```
┌─────────────┐     SIP/RTP      ┌──────────────────────────────────┐
│   CALLER    │────────────────►│          FreeSWITCH              │
└─────────────┘                  │  ┌──────────────────────────────┐│
                                 │  │       Lua IVR Engine         ││
                                 │  │  blast_call.lua              ││
                                 │  │  dial_911_conference.lua     ││
                                 │  │  ers_retry_caller.lua        ││
                                 │  │  ENS_retry_playback.lua      ││
                                 │  │  dial_ers_callback.lua       ││
                                 │  │  ivr_engine.lua (Phase B)    ││
                                 │  └────────────┬─────────────────┘│
                                 │               │ HTTP              │
                                 │               │ X-Internal-Key    │
                                 └───────────────┼──────────────────┘
                                                 │ ESL :8021
                          ┌──────────────────────▼───────────────────┐
                          │         Node.js Express Backend :4100     │
                          │  ┌────────────┐  ┌─────────────────────┐ │
                          │  │ Public API │  │   Internal API      │ │
                          │  │ /api/v1/*  │  │   /internal/*       │ │
                          │  │ JWT Auth   │  │   X-Internal-Key    │ │
                          │  └─────┬──────┘  └──────────┬──────────┘ │
                          │        │                     │            │
                          │  ┌─────▼──────────────────────▼────────┐ │
                          │  │            Core Services             │ │
                          │  │  eslService  socketService           │ │
                          │  │  authService auditService            │ │
                          │  │  channelRouter (Phase C)             │ │
                          │  │  aiService (Phase C)                 │ │
                          │  └──────────────┬───────────────────────┘ │
                          └─────────────────┼────────────────────────┘
                                            │
                    ┌───────────────────────┼────────────────────┐
                    │                       │                    │
              ┌─────▼──────┐        ┌───────▼──────┐    ┌───────▼──────┐
              │ PostgreSQL │        │    Redis      │    │  BullMQ      │
              │  fs_enrs   │        │  Cache/Queue  │    │  Workers     │
              └────────────┘        └──────────────┘    └──────────────┘
                                            │
                          ┌─────────────────▼────────────────────────┐
                          │        React Frontend :8100               │
                          │  Vite + Tailwind + Socket.IO client       │
                          └──────────────────────────────────────────┘
```

## Module Dependency Map

```
auth ──────────────────────────────────► all modules (JWT middleware)
organizations ─────────────────────────► contacts, groups, ENS, ERS, IVR
contacts + groups ─────────────────────► ENS configurations, ERS configurations
ENS configurations ─────────────────────► ens_notifications, blast queue
ERS configurations ─────────────────────► ers_incidents, conference engine
Internal API (B1) ─────────────────────► all Lua scripts
IVR Backend (B3) ──────────────────────► IVR Frontend (B4), AI Intent (C7)
Media Library (B5) ────────────────────► IVR nodes (play_prompt)
Audit Middleware (B6) ─────────────────► all mutating routes
DID Management (B7) ───────────────────► ENS/ERS/IVR routing
Templates (B8) ────────────────────────► multi-channel dispatch (C2)
BullMQ (C1) ───────────────────────────► all channel workers (C2/C4)
AI Service (C3) ───────────────────────► IVR AI node (C7), reporting (C5)
```

## Directory Structure

```
fs-enrs/
├── backend/
│   ├── src/
│   │   ├── controllers/          # Business logic per entity
│   │   ├── routes/
│   │   │   ├── v1/               # Public API routes (JWT-protected)
│   │   │   └── internal/         # Lua-contract routes (X-Internal-Key)
│   │   ├── middleware/
│   │   │   ├── auth.js           # JWT verification
│   │   │   ├── rbac.js           # Role checks (adminOnly, adminOrOp)
│   │   │   ├── internalAuth.js   # X-Internal-Key verification (B1)
│   │   │   └── auditLog.js       # Audit trail writer (B6)
│   │   ├── services/
│   │   │   ├── eslService.js     # FreeSWITCH ESL persistent connection
│   │   │   ├── socketService.js  # Socket.IO event emitters
│   │   │   ├── aiService.js      # OpenAI/Whisper client (C3)
│   │   │   └── channels/         # SMS/Email/Push/WhatsApp workers (C2/C4)
│   │   ├── queues/               # BullMQ queue definitions + workers (C1)
│   │   ├── db/
│   │   │   ├── pool.js           # PostgreSQL connection pool
│   │   │   └── migrations/       # SQL migration files
│   │   └── app.js
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/client.js         # Axios API client with all endpoints
│   │   ├── components/ui/        # Shared: Modal, Table, Badge, etc.
│   │   ├── context/              # AuthContext, SocketContext
│   │   └── pages/
│   │       ├── auth/             # Login
│   │       ├── dashboard/        # Dashboard (metrics, charts, live feed)
│   │       ├── users/            # UserList
│   │       ├── organizations/    # OrgList, LocationList, DeptList
│   │       ├── contacts/         # ContactList
│   │       ├── groups/           # GroupList
│   │       ├── ens/              # EnsList
│   │       ├── ers/              # ErsConfigList
│   │       ├── ivr/              # IvrFlowList, IvrFlowEditor (B4)
│   │       ├── media/            # MediaLibrary (B5)
│   │       ├── dids/             # DIDManagement (B7)
│   │       ├── pbx/              # PBXConnections, ExtensionMapping (B7)
│   │       ├── reports/          # ReportNotifications, ReportIncidents, etc.
│   │       ├── monitoring/       # ESL status, active calls
│   │       └── settings/         # AuditLog (B6), NotificationTemplates (B8)
│   └── package.json
├── Lua-scripts/                  # FreeSWITCH Lua scripts
├── docs/                         # Governance documents (this directory)
└── ecosystem.config.cjs          # PM2 configuration
```

## Data Flow: ENS Blast (Current — Phase A)

```
Operator clicks "Trigger" in UI
  → POST /api/v1/ens/:id/trigger
  → ensController.triggerBlast()
  → INSERT ens_notifications row
  → eslService.bgapi("originate {vars}sofia/... &lua(blast_call.lua)")
  → FreeSWITCH originates call
  → blast_call.lua: GET /internal/ens/lookup?destination_number=
  → On answer: play TTS, collect DTMF
  → POST /internal/ens/notifications/:uuid/delivery {status}
  → Socket.IO emit → Dashboard updates
```

## Data Flow: ENS Blast (Phase C — BullMQ)

```
POST /api/v1/ens/:id/trigger
  → INSERT ens_notifications
  → Resolve all target contacts (groups + direct)
  → Enqueue one BullMQ job per contact
  → Worker picks job → ESL originate
  → On completion → update ens_deliveries
  → Socket.IO broadcast progress
```

## Security Architecture

- Public API: JWT RS256 (access 15m, refresh 7d)
- Internal API: `X-Internal-Key` shared secret — never exposed in public routes
- RBAC enforced at route middleware layer, not controller layer
- Tenant scoping enforced at SQL `WHERE tenant_id = $n` on all list queries
- Passwords: bcrypt cost 12, password history enforced (last 5)
- Audit log: append-only, written after response, never blocks request
- FreeSWITCH internal API must be behind firewall — not publicly routable
