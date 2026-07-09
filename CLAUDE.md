# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (run from `backend/`)
```bash
npm run dev          # node --watch server.js (hot reload)
npm start            # production start
npm run migrate      # run DB migrations (node src/db/migrate.js)
npm run seed         # seed admin user + feature flags
npm test             # vitest run (single pass)
npm run test:watch   # vitest interactive
```

### Frontend (run from `frontend/`)
```bash
npm run dev          # vite dev server on :8100
npm run build        # production build to dist/
```

### Run a single test file
```bash
cd backend && npx vitest run src/__tests__/integration/ivr.test.js
```

### Database migration (fresh vs. upgrade)
```bash
# Automated — detects fresh vs existing DB automatically
cd backend && node src/db/migrate.js

# Manual psql (fresh install)
psql -U enrs -d enrs_db -f src/db/migrations/001_initial_schema.sql
psql -U enrs -d enrs_db -f src/db/migrations/006_ivr_production.sql
# ... 007 through 011 in order (002–005 are baked into 001)

# Load YASREF test data
psql -U enrs -d enrs_db -f docs/sample_data_yasref.sql
```

Default dev seed credentials: `admin@enrs.local` / `Admin@12345`

---

## Architecture

### System boundaries

```
FreeSWITCH (:8021 ESL)
    │  ESL TCP (modesl)              Lua scripts call:
    │                                  curl → /api/v1/internal/*
    ▼
Backend (:4100)  ←──── PostgreSQL (fs_enrs, 33 tables, soft-delete)
    │  Socket.IO
    ▼
Frontend (:8100)  — Vite dev / nginx prod
```

The Vite dev server (`vite.config.js`) proxies `/api`, `/socket.io`, and `/uploads` to `localhost:4100` so the frontend talks to the same origin in both dev and prod.

### Two separate API surfaces

The backend exposes two completely separate route trees with different auth:

1. **`/api/v1/*`** — REST API for the React UI. Protected by `requireAuth` (JWT Bearer or httpOnly refresh cookie). All handlers use `asyncHandler` + Zod validation.

2. **`/api/v1/internal/*`** — Lua contract API. Protected by `requireInternalKey` (timing-safe comparison of `X-Internal-Key` vs `INTERNAL_API_KEY` env var). Used exclusively by FreeSWITCH Lua scripts. Rate-limited separately (500 req/min). Lives in `backend/src/controllers/internal/`.

Never mix auth middleware between these two surfaces.

### Authentication flow

- Login issues a short-lived JWT access token (15m, Bearer) + long-lived refresh token (7d, httpOnly cookie).
- `req.user` shape set by `requireAuth`: `{ id, email, role, tenantId }`. The `tenantId` is read from the JWT payload — **always use `req.user.tenantId` when inserting rows that need tenant scoping, never trust the request body for it.**
- Roles: `ADMIN > SUPERVISOR > OPERATOR > VIEWER`. Named middleware exports in `rbac.js` (e.g. `adminOrSuper`, `canTriggerEns`) should be used instead of inline role checks.

### Database patterns

- All tables have soft-delete (`deleted_at TIMESTAMPTZ`). Queries must include `AND deleted_at IS NULL`.
- `query(sql, params)` from `src/db/pool.js` annotates errors with `._sql` and `._params` for the error handler to log.
- `withTransaction(async tq => { ... })` — the `tq` argument is a bound query function that runs inside the transaction.
- PG error `23505` (unique violation) and `23503` (FK violation) are automatically mapped to 409 by `errorHandler`.

### Multi-tenancy scope

Every configuration row (`ers_configurations`, `ens_configurations`, IVR flows, emergency numbers) must have `tenant_id` set at INSERT time from `req.user.tenantId`. The `ivrGraphValidator.js` validates that ERS/ENS node references belong to the same tenant — inserts that omit `tenant_id` will cause validation failures downstream.

### ENS campaign engine (`src/services/campaignEngine.js`)

- Singleton, tick-based (1 s interval), safe for PM2 cluster via PostgreSQL advisory locks.
- Outbound calls: `originateCampaignCall()` in `eslService.js` → FreeSWITCH → ESL `CHANNEL_ANSWER`/`CHANNEL_HANGUP` events → `onCallAnswer(uuid)` / `onCallHangup(uuid, cause)` wired in `server.js`.
- Retryable hangup causes: `BUSY`, `USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED`, `NORMAL_CIRCUIT_CONGESTION`, `SWITCH_CONGESTION`.
- `ENS_ORIGINATE_MODE=user` (lab/extension) or `gateway` (production SIP gateway).

### ERS conference flow

- Lua: `dial_911_conference.lua` calls `GET /internal/ers/lookup?number=<dest>` → gets full config (bridge numbers, responder tiers, queue settings, slot assignment).
- Bridge slots: `ers_<config_id>_p` (primary, up to `max_concurrent_conferences`) or `ers_<config_id>_s` (secondary). Slot 3+ go to queue.
- Responder resolution in `ersInternalController.js` reads from **both** `ers_tier_contacts` (individual contacts) and `ers_tier_groups` + `responder_group_members` (group-based), merges and deduplicates.

### ENS blast + playback flow

- Lua: `blast_call.lua` → `GET /internal/ens/lookup` → optional PIN via `POST /internal/ens/verify-pin` → record → `POST /internal/ens/campaign/start`.
- Lua: `ENS_retry_playback.lua` → `GET /internal/ens/lookup` + `GET /internal/ens/campaigns/latest?configuration_id=<id>` → plays recording or speaks configured `no_pending_msg` / `expiry_announcement`.
- PIN is stored in `ens_configurations.pin`. The lookup endpoint returns only `pin_required: true/false` — the raw PIN is never sent to Lua. Verification goes through `verify-pin` only.

### IVR builder + deployment chain

- IVR flows stored as JSONB graph (`{ entry_node_id, nodes: { [id]: { type, label, config, next } } }`).
- `ivrGraphValidator.js` validates the graph before publish: checks reachability from `entry_node_id`, validates that ERS/ENS node config IDs exist and match the flow's `tenant_id`.
- Published versions in `ivr_flow_versions` (versioned, immutable once created).
- Deployment (`/deployment`) generates Lua scripts + FreeSWITCH XML dialplan from published graphs and writes them to FreeSWITCH filesystem paths (configured via `FS_*` env vars, defaulting to Debian paths in `freeSwitchPathService.js`).
- The IVR route is mounted at `/api/v1/ivr/flows` (not `/api/v1/ivr`). The router uses `router.param('uuid', ...)` to return 400 on malformed UUIDs before they hit the DB.

### Service Registry (`emergency_numbers`)

The `emergency_numbers` table is the unified service registry — it's the source of truth that connects a dialled number to a service type (`ENS`, `ERS`, `IVR`, `REJOIN`, `OPEN_ACCESS`) and its configuration. The Bind Numbers modal in the IVR builder (`GET /settings/emergency-numbers`) reads from this table filtered by `tenant_id + is_active = true`.

### Real-time events

`socketService.js` authenticates Socket.IO connections via JWT. `emitInternal(event, data)` broadcasts to all authenticated sockets — used by internal controllers to push live updates (campaign delivery status, ERS incidents) to the monitoring UI.

### Frontend state

- Zustand (`authStore`) for auth token + user — no React context for auth.
- Theme: `useTheme` hook toggles `class="dark"` on `<html>`.
- API client: `frontend/src/api/client.js` — single `request(method, path, body)` function; all domain methods (`.ers`, `.ens`, `.ivr`, `.services`, etc.) wrap it. List calls that populate dropdowns must pass `limit: 1000` to avoid truncation at the default 20-row limit.

### Migration system

`src/db/migrate.js` has two paths:
- **Fresh DB** (no `tenants` table): applies `schema.sql` (covers 001–005 equivalent), marks those as applied, then runs 006–011 normally.
- **Existing DB**: skips `schema.sql`, runs only unapplied numbered migrations.

All migration files must manage their own `BEGIN/COMMIT` and be fully idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

### FreeSWITCH Lua ↔ backend contract

Lua scripts use `io.popen(curl ...)` for HTTP — no native HTTP library. All decisions (bridge numbers, retry counts, responder lists, PIN, queue settings) come from a single API lookup per call session. Lua never contains hardcoded business logic. Environment variables consumed by Lua: `ENRS_INTERNAL_API`, `FS_INTERNAL_KEY`, `ENRS_TTS_ENGINE`, `ENRS_TTS_VOICE`, `ENRS_ERS_REC_DIR`, `ENRS_REC_DIR`.
