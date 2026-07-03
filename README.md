# fs-enrs — Emergency Notification & Response System

Integrated with FreeSWITCH for conference-based emergency dispatch. Provides a complete ENS (Emergency Notification System) and ERS (Emergency Response System) with real-time monitoring, multi-tenant support, RBAC, and Lua-accessible APIs.

## Architecture

```
FreeSWITCH (ESL :8021)
        │  ESL TCP
        ▼
  Backend API (:4100)   ←──── PostgreSQL (fs_enrs)
        │  Socket.IO
        ▼
  Frontend UI (:8100)
```

## Directory Structure

```
fs-enrs/
├── backend/
│   ├── src/
│   │   ├── config/        # Env-based config
│   │   ├── db/            # Pool, migrate, seed, schema.sql
│   │   ├── middleware/    # auth, rbac, asyncHandler, validate
│   │   ├── services/      # eslService, socketService
│   │   ├── controllers/   # auth, org, contact, group, ens, ers, dashboard, …
│   │   └── routes/v1/     # Versioned API routes
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/           # client.js (fetch + auto-refresh), socket.js
│   │   ├── store/         # authStore (Zustand)
│   │   ├── hooks/         # useTheme
│   │   ├── components/    # layout (AppShell, Sidebar, Header), ui (Modal, Table, Badge, StatCard)
│   │   └── pages/         # Dashboard, Login, users/, organizations/, contacts/, …
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── nginx.conf
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## Quick Start (Development)

### 1. PostgreSQL

```bash
createdb fs_enrs
```

### 2. Backend

```bash
cd backend
cp .env.example .env          # edit DB_*, JWT_*, ESL_* values
npm install
node src/db/migrate.js        # apply schema
node src/db/seed.js           # create default admin + tenant
npm run dev                   # nodemon on :4100
```

Default admin credentials after seed: `admin@example.com` / `Admin@1234`

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                   # Vite on :8100
```

## Docker (Production)

```bash
cp .env.example .env          # fill all secrets
docker compose up -d --build
```

The database migration and seed run automatically on first boot if `fs_enrs` is empty.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4100` | Backend HTTP port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_NAME` | `fs_enrs` | Database name |
| `DB_USER` | — | PostgreSQL user |
| `DB_PASSWORD` | — | PostgreSQL password |
| `JWT_ACCESS_SECRET` | — | 64-char hex secret for access tokens (15 min) |
| `JWT_REFRESH_SECRET` | — | 64-char hex secret for refresh tokens (7 days) |
| `ESL_HOST` | `127.0.0.1` | FreeSWITCH ESL host |
| `ESL_PORT` | `8021` | FreeSWITCH ESL port |
| `ESL_PASSWORD` | `ClueCon` | FreeSWITCH ESL password |
| `CORS_ORIGIN` | — | Comma-separated allowed origins |

## API Overview

All authenticated endpoints require `Authorization: Bearer <access_token>`.

### Auth
| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/auth/login` | Public |
| POST | `/api/v1/auth/logout` | Any |
| POST | `/api/v1/auth/refresh` | Cookie |
| GET | `/api/v1/auth/me` | Any |

### Lua-Accessible (no auth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/ens/lookup?pin=` | ENS PIN lookup |
| GET | `/api/v1/ers/lookup?pin=` | ERS PIN lookup |
| GET | `/api/v1/contacts/by-pin?pin=` | Contact list by PIN |
| POST | `/api/v1/ers/incidents` | Create incident |
| POST | `/api/v1/ers/incidents/:id/complete` | Complete incident |
| PATCH | `/api/v1/ens/notifications/:uuid/status` | Update delivery status |

### Protected Resources
`/api/v1/users`, `/api/v1/organizations`, `/api/v1/locations`, `/api/v1/departments`, `/api/v1/contacts`, `/api/v1/groups`, `/api/v1/ens/configurations`, `/api/v1/ers/configurations`, `/api/v1/dashboard`, `/api/v1/reports`, `/api/v1/settings`, `/api/v1/media`

## RBAC

| Role | Access |
|---|---|
| `ADMIN` | Full access including user management and settings |
| `OPERATOR` | Create/edit all resources except users |
| `VIEWER` | Read-only |

## Socket.IO Events

Authenticate after connect:
```js
socket.emit('authenticate', { token: '<access_token>' });
```

Events emitted by server:
- `conference.created` / `conference.ended`
- `conference.member.joined` / `conference.member.left`
- `channel.hangup` / `channel.answer`
- `enrs.*` — custom application events from Lua

## Database Tables

24 normalized tables with soft-delete (`deleted_at TIMESTAMPTZ`):

`tenants`, `users`, `organizations`, `tenant_mappings`, `locations`, `departments`, `emergency_contacts`, `responder_groups`, `responder_group_members`, `media_files`, `notification_templates`, `ens_configurations`, `ens_configuration_groups`, `ens_configuration_contacts`, `ens_notifications`, `ens_notification_deliveries`, `ers_configurations`, `ers_incidents`, `ers_incident_responders`, `ers_queues`, `audit_logs`, `system_settings`, `esl_connections`, `feature_flags`

Reserved for future IVR Designer module: `ivr_flows`, `ivr_flow_versions`, `ivr_nodes`

## Health Check

```
GET /api/health
```

Returns `{ status: "ok", timestamp: "…" }`.

## PM2 (non-Docker)

```bash
cd backend
pm2 start server.js --name fs-enrs-api
pm2 save
```

## Troubleshooting

**ESL not connecting** — Verify FreeSWITCH is running and `event_socket.conf.xml` allows connections from the backend host on port 8021.

**JWT errors** — Ensure `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are set and at least 32 chars.

**CORS errors** — Set `CORS_ORIGIN` to the exact frontend origin (including port), no trailing slash.

**DB connection refused** — Check `DB_HOST`, `DB_PORT`, and that the `fs_enrs` database exists.
