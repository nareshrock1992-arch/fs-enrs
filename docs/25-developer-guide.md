# Developer Guide

**Document:** 25-developer-guide.md  
**Product:** fs-enrs  
**Audience:** Backend and frontend engineers contributing to this codebase  
**Scope:** Local environment setup, architecture reference, extension patterns, testing

---

## Development Environment Setup

### Prerequisites

- Node.js 20 LTS or later
- PostgreSQL 14 or later
- FreeSWITCH 1.10+ (optional for unit/integration tests; required for full end-to-end testing)

### Installation

```bash
# 1. Install backend dependencies
cd backend && npm install

# 2. Install frontend dependencies
cd ../frontend && npm install

# 3. Create backend environment file
cp backend/.env.example backend/.env
# Edit backend/.env — set all required variables (see Environment Variables section)

# 4. Initialize the database
cd backend && node src/db/migrate.js

# 5. Seed the admin user and feature flags
npm run seed

# 6. Start the backend with hot reload
npm run dev        # node --watch server.js, listens on port 4100

# 7. Start the frontend dev server (separate terminal)
cd ../frontend && npm run dev   # Vite on port 8100, proxies /api /socket.io /uploads to 4100
```

The Vite dev proxy is configured in `frontend/vite.config.js`. The frontend talks to a single origin in both dev and production — no CORS configuration is required during development.

---

## Code Architecture

### System Boundaries

```
FreeSWITCH (:8021 ESL)
    │  ESL TCP (modesl library)
    │
    │  Lua scripts call:
    │    curl → /api/v1/internal/*
    ▼
Backend (:4100)  ←──── PostgreSQL (fs_enrs, 33 tables, soft-delete)
    │  Socket.IO (JWT-authenticated)
    ▼
Frontend (:8100)  — Vite dev / nginx prod
```

### Backend Module Map

```
backend/
├── server.js                       # Express app entry — ESL init, campaign engine start, route mounting
└── src/
    ├── config/
    │   └── index.js                # All env vars with validated defaults
    ├── db/
    │   ├── pool.js                 # query(sql, params) + withTransaction(fn)
    │   └── migrate.js              # Fresh vs existing DB detection + migration runner
    ├── middleware/
    │   ├── requireAuth.js          # JWT Bearer verification → req.user
    │   ├── internalAuth.js         # X-Internal-Key timing-safe comparison
    │   ├── rbac.js                 # Role middleware exports: adminOrSuper, canTriggerEns, etc.
    │   ├── asyncHandler.js         # Wraps async route handlers, catches thrown errors
    │   └── errorHandler.js         # Maps PG 23505 → 409, 23503 → 409, Zod errors → 422
    ├── controllers/
    │   ├── internal/               # ersInternalController, ensInternalController, ivrInternalController
    │   └── *.js                    # One controller file per resource domain
    ├── routes/v1/                  # Express routers with Zod validation per route
    ├── services/
    │   ├── eslService.js           # ESL connection lifecycle, event dispatch, conference registry
    │   ├── campaignEngine.js       # ENS tick engine (1s interval, PG advisory lock)
    │   ├── ersRingService.js       # ERS ring-all loop management
    │   ├── socketService.js        # Socket.IO auth + emit helpers
    │   ├── conferenceManager.js    # Conference lifecycle (recording start, member tracking)
    │   ├── dialResolver.js         # Builds user/ext vs sofia/gateway originate strings
    │   └── freeSwitchPathService.js # Resolves FS filesystem paths from env vars
    ├── nodeTypes/
    │   └── registry.js             # IVR node type definitions (17 types)
    └── utils/
        ├── luaGenerator.js         # Generates ivr_executor.lua from published graph
        ├── xmlGenerator.js         # Generates enrs_ivr.xml dialplan fragment
        ├── gatewayXmlGenerator.js  # Generates SIP profile XML for gateways
        └── ivrGraphValidator.js    # 3-pass graph validation (reachability, refs, tenant)
```

### Two API Surfaces

The backend exposes two completely separate route trees. **Never mix auth middleware between them.**

| Surface | Path Prefix | Auth Mechanism | Clients |
|---|---|---|---|
| UI REST API | `/api/v1/*` | `requireAuth` (JWT Bearer or httpOnly refresh cookie) | React frontend |
| Lua contract API | `/api/v1/internal/*` | `requireInternalKey` (X-Internal-Key header, timing-safe comparison) | FreeSWITCH Lua scripts |

The internal API is rate-limited to 500 req/min. Controllers live in `src/controllers/internal/`.

---

## Adding a New API Route

Follow this pattern for any new resource endpoint:

**Step 1 — Create the controller** (`src/controllers/myResource.js`):

```js
import { query } from '../db/pool.js';

export async function listMyResources(req, res) {
  const { rows } = await query(
    `SELECT * FROM my_resources
     WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [req.user.tenantId]
  );
  res.json(rows);
}

export async function createMyResource(req, res) {
  const { name } = req.body; // already validated by Zod in router
  const { rows } = await query(
    `INSERT INTO my_resources (name, tenant_id) VALUES ($1, $2) RETURNING *`,
    [name, req.user.tenantId]   // always use req.user.tenantId — never trust request body
  );
  res.status(201).json(rows[0]);
}
```

**Step 2 — Create the router** (`src/routes/v1/myResource.js`):

```js
import { Router } from 'express';
import { z } from 'zod';
import asyncHandler from '../../middleware/asyncHandler.js';
import { adminOrSuper } from '../../middleware/rbac.js';
import { listMyResources, createMyResource } from '../../controllers/myResource.js';

const router = Router();

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
});

router.get('/', asyncHandler(listMyResources));

router.post('/', adminOrSuper, asyncHandler(async (req, res) => {
  req.body = CreateSchema.parse(req.body);   // throws ZodError → errorHandler maps to 422
  await createMyResource(req, res);
}));

export default router;
```

**Step 3 — Register in `server.js`:**

```js
import myResourceRouter from './src/routes/v1/myResource.js';
// ...
app.use('/api/v1/my-resources', requireAuth, myResourceRouter);
```

---

## Adding a New IVR Node Type

IVR node types are defined in `src/nodeTypes/registry.js`, validated in `ivrGraphValidator.js`, and rendered as Lua in `luaGenerator.js`.

**Step 1 — Register the node type** (`src/nodeTypes/registry.js`):

```js
{
  type: 'my_node',
  label: 'My Node',
  category: 'Flow',
  portStrategy: 'next',    // 'next' | 'branch' | 'terminal'
  config: {
    my_field: {
      type: 'string',
      required: true,
      label: 'My Field'
    }
  }
}
```

**Step 2 — Add Zod schema** in `ivrGraphValidator.js`, inside `AnyNodeSchema`:

```js
z.object({
  type: z.literal('my_node'),
  label: z.string(),
  config: z.object({
    my_field: z.string().min(1),
    next: z.string().optional(),
  }),
})
```

**Step 3 — Add Lua handler** in `luaGenerator.js` inside `generateIvrExecutorLua()`:

```lua
EXEC["my_node"] = function(session, node)
  -- implementation using node.config values
  local my_field = node.config.my_field
  -- ... do work ...
  current_node = node.config.next
end
```

**Step 4 — Add DB reference validation** (if config references a DB entity):

In `ivrGraphValidator.js`, inside the `validateGraph()` function, add a query to verify the referenced entity exists and belongs to the same `tenant_id` as the flow.

---

## Database Patterns

### Required Query Filters

Every query against application tables must include both filters:

```js
// Correct
await query(
  `SELECT * FROM contacts WHERE tenant_id = $1 AND deleted_at IS NULL`,
  [req.user.tenantId]
);

// Wrong — missing soft-delete filter
await query(`SELECT * FROM contacts WHERE tenant_id = $1`, [tenantId]);

// Wrong — trusting request body for tenant
await query(`SELECT * FROM contacts WHERE tenant_id = $1`, [req.body.tenantId]);
```

### Soft Delete

```js
await query(
  `UPDATE contacts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
  [id]
);
```

Hard deletes are not used for application data. Use soft deletes exclusively.

### Transactions

```js
import { withTransaction } from '../db/pool.js';

await withTransaction(async (tq) => {
  const { rows: [parent] } = await tq(
    `INSERT INTO parents (name, tenant_id) VALUES ($1, $2) RETURNING id`,
    [name, tenantId]
  );
  await tq(
    `INSERT INTO children (parent_id, tenant_id) VALUES ($1, $2)`,
    [parent.id, tenantId]
  );
});
```

The `tq` argument is a bound `query` function scoped to the transaction. Throwing inside the callback rolls back automatically.

### Error Handling

The `asyncHandler` + `errorHandler` middleware chain handles common cases automatically:

| PG Error Code | HTTP Response |
|---|---|
| `23505` — unique violation | `409 Conflict` |
| `23503` — FK violation | `409 Conflict` |
| `ZodError` | `422 Unprocessable Entity` with field-level details |

For business logic errors, return directly:

```js
if (rows.length === 0) {
  return res.status(404).json({ error: 'Resource not found' });
}
```

---

## ESL Integration

### Listening for ESL Events

Add event handlers in `src/services/eslService.js`, inside `handleEvent()`:

```js
// eslService.js — inside handleEvent()
case 'CHANNEL_HANGUP': {
  const uuid = headers['Unique-ID'];
  const cause = headers['Hangup-Cause'];
  eslEvents.emit('CHANNEL_HANGUP', { uuid, cause });
  break;
}
```

Subscribe elsewhere in the codebase:

```js
import { eslEvents } from './eslService.js';

eslEvents.on('CHANNEL_HANGUP', ({ uuid, cause }) => {
  // handle hangup
});
```

### Sending ESL Commands

```js
import { eslCommand } from './eslService.js';

const result = await eslCommand('conference myroom list');
```

`eslCommand` rejects if ESL is not connected. Callers must handle the rejection appropriately.

---

## Socket.IO Events

### Broadcast to All Authenticated Clients

```js
import { emitInternal } from './socketService.js';

emitInternal('conference.member.joined', {
  room: 'ers_1_p',
  member: { uuid, displayName, role },
});
```

### Broadcast to a Specific Tenant

```js
import { emitToTenant } from './socketService.js';

emitToTenant(tenantId, 'campaign.status.updated', {
  campaignId,
  status: 'running',
});
```

Socket.IO connections are authenticated via JWT on the `auth.token` handshake field. Unauthenticated connections are rejected.

---

## Running Tests

```bash
cd backend

# Run all tests (single pass)
npm test

# Interactive watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/__tests__/integration/ivr.test.js
```

### Test File Conventions

- Integration tests live in `src/__tests__/integration/`
- Each test file creates its own tenant and organization in `beforeAll` using direct DB inserts
- Tests use `supertest` for HTTP assertions against the running Express application
- All created rows are deleted in `afterAll` in reverse dependency order
- ESL is mocked in integration tests — FreeSWITCH is not required

Example structure:

```js
import { query } from '../../db/pool.js';
import request from 'supertest';
import app from '../../../server.js';

let tenantId, orgId, authToken;

beforeAll(async () => {
  const { rows: [tenant] } = await query(
    `INSERT INTO tenants (name) VALUES ('Test Tenant') RETURNING id`
  );
  tenantId = tenant.id;
  // ... create org, user, get auth token
});

afterAll(async () => {
  await query(`DELETE FROM organizations WHERE tenant_id = $1`, [tenantId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

test('GET /api/v1/organizations returns org list', async () => {
  const res = await request(app)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${authToken}`)
    .expect(200);

  expect(res.body).toHaveLength(1);
});
```

---

## Environment Variables (Development)

Create `backend/.env` with the following values for local development:

```bash
NODE_ENV=development
PORT=4100

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=fs_enrs
DB_USER=fs_enrs
DB_PASSWORD=changeme

# JWT (minimum 32 characters each)
JWT_ACCESS_SECRET=dev-access-secret-at-least-32-chars-long
JWT_REFRESH_SECRET=dev-refresh-secret-at-least-32-chars-long

# ESL
ESL_HOST=127.0.0.1
ESL_PORT=8021
ESL_PASSWORD=ClueCon
ESL_RECONNECT_MS=3000

# Internal API (Lua contract)
ENRS_API_URL=http://127.0.0.1:4100
INTERNAL_API_KEY=dev-internal-key

# FreeSWITCH paths (Debian defaults)
FS_SCRIPT_DIR=/usr/share/freeswitch/scripts
FS_DIALPLAN_DIR=/etc/freeswitch/dialplan

# ENS
ENS_ORIGINATE_MODE=user     # 'user' for lab/extensions, 'gateway' for PSTN

# TTS
FS_TTS_ENGINE=flite|kal

# CORS
CORS_ORIGIN=http://localhost:8100
```

**Note:** The backend does not block startup for missing or default credentials in `development` mode. Production hardening requires setting all secrets to non-default values. See the Deployment Guide for production security requirements.

---

## Frontend Architecture

### API Client

All HTTP calls go through `frontend/src/api/client.js`:

```js
// Single transport function
const response = await client.request('GET', '/api/v1/ers/configurations');

// Domain method wrappers
const configs = await client.ers.listConfigurations();
const contacts = await client.services.listContacts({ limit: 1000 });
```

**Important:** All list calls that populate dropdowns must include `limit: 1000`. The default server-side limit is 20 rows. Omitting `limit` silently truncates dropdowns.

### State Management

- **Auth:** Zustand `authStore` — stores access token and user object. No React context is used for auth.
- **Theme:** `useTheme` hook — toggles `class="dark"` on `<html>`. All components must support both light and dark themes.
- **IVR Builder canvas:** React Flow library. Node types are registered against the `registry.js` definitions.

### Proxy Configuration

`frontend/vite.config.js` proxies the following paths to `localhost:4100`:

| Path prefix | Backend target |
|---|---|
| `/api` | REST API |
| `/socket.io` | Socket.IO |
| `/uploads` | Uploaded file serving |

This proxy is active only in the Vite dev server. Production traffic routes through nginx reverse proxy (see Deployment Guide).
