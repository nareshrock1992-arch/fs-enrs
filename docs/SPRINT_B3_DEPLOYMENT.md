# Sprint B3 — IVR Flow Engine: Deployment Guide

## What changed

| Layer    | File                                                         | Change                                               |
|----------|--------------------------------------------------------------|------------------------------------------------------|
| DB       | `migrations/004_sprint_b3_ivr_engine.sql`                   | New tables: `ivr_flows`, `ivr_flow_versions`; FK on `emergency_numbers.ivr_flow_id` |
| Backend  | `validators/ivrValidator.js`                                 | Zod schemas for all 7 node types + graph structure   |
| Backend  | `utils/ivrGraphValidator.js`                                 | Two-pass validator: schema + cycle/reachability + DB FK checks |
| Backend  | `controllers/ivrController.js`                               | 10 route handlers (CRUD, validate, publish, bind, unbind, versions) |
| Backend  | `controllers/internal/ivrInternalController.js`              | Lua lookup endpoint                                  |
| Backend  | `routes/v1/ivr.js`                                           | Public router (JWT + RBAC)                           |
| Backend  | `routes/internal/ivr.js`                                     | Internal router (X-Internal-Key)                     |
| Backend  | `routes/v1/index.js`                                         | Mounted `/ivr`                                       |
| Backend  | `routes/internal/index.js`                                   | Mounted `/ivr`                                       |
| Tests    | `__tests__/integration/ivr.test.js`                          | 24 test cases covering all routes                    |

## No new npm packages

Sprint B3 uses only existing dependencies (Zod, pg, express). No `npm install` required.

## Deployment steps (Dabin server)

```bash
# 1. Pull latest
cd /opt/fs-enrs
git pull

# 2. Run migration
psql -d fs_enrs -U postgres -f backend/src/db/migrations/004_sprint_b3_ivr_engine.sql

# 3. Verify migration
psql -d fs_enrs -U postgres -c "\d ivr_flows"
psql -d fs_enrs -U postgres -c "\d ivr_flow_versions"
psql -d fs_enrs -U postgres -c "\d emergency_numbers" | grep ivr_flow_id

# 4. Reload backend
pm2 reload enrs-backend

# 5. Verify routes mounted
curl -s http://localhost:3000/api/v1/ivr/flows \
  -H "Authorization: Bearer <admin_token>" | jq .
# → {"flows":[],"total":0,"page":1,"limit":20}

# 6. Verify internal route
curl -s "http://localhost:3000/api/v1/internal/ivr/lookup?number=%2B61299990001" \
  -H "x-internal-key: $INTERNAL_API_KEY"
# → 404 {"error":"No published IVR flow bound to this number"}  (correct — no flows yet)
```

## Rollback

The migration only adds new tables and a nullable column on `emergency_numbers`. Rolling back:

```sql
-- Safe to run — no existing data affected
ALTER TABLE emergency_numbers DROP COLUMN IF EXISTS ivr_flow_id;
DROP TABLE IF EXISTS ivr_flow_versions;
DROP TABLE IF EXISTS ivr_flows;
```

Remove the `/ivr` mounts from `routes/v1/index.js` and `routes/internal/index.js` and reload.

## Smoke tests (manual)

1. **Create flow** — `POST /api/v1/ivr/flows` with `name` → 201, `flow_uuid` in response.
2. **Edit graph** — `PUT /api/v1/ivr/flows/:uuid` with `VALID_GRAPH` → 200.
3. **Validate** — `POST /api/v1/ivr/flows/:uuid/validate` → `{"valid":true,"stats":{"node_count":4}}`.
4. **Publish** — `POST /api/v1/ivr/flows/:uuid/publish` → 201, `version_number: 1`.
5. **Bind number** — `PATCH /api/v1/ivr/flows/:uuid/bind` with `emergency_number_id` → 200.
6. **Lua lookup** — `GET /api/v1/internal/ivr/lookup?number=<bound_number>` with `x-internal-key` → 200, graph JSON with `entry_node_id` + `nodes`.
7. **Cycle rejection** — PUT graph with A→B→A cycle → 400, error contains "Cycle detected".
8. **VIEWER read** — GET flows with VIEWER token → 200 (can read).
9. **VIEWER write** — POST flow with VIEWER token → 403 (cannot create).
10. **Soft-delete** — DELETE flow → 200; `emergency_numbers.ivr_flow_id` set to NULL in DB.

## Lua integration (how FreeSWITCH uses this)

At call-start, the Lua dialplan script calls:

```lua
local res = http_get(
  INTERNAL_BASE_URL .. "/ivr/lookup?number=" .. url_encode(caller_number),
  { ["x-internal-key"] = INTERNAL_API_KEY }
)
if res.status == 200 then
  local flow = json.decode(res.body)
  ivr_execute(flow.entry_node_id, flow.nodes)  -- Lua IVR engine (B4/C7)
elseif res.status == 404 then
  -- No IVR flow — fall through to direct ENS/ERS routing
end
```

The Lua IVR engine itself (node execution loop) is implemented in Sprint B4.

## Run tests

```bash
cd backend
INTERNAL_API_KEY=test-internal-key-32chars-padding! npm test -- --reporter=verbose ivr
```

Expected: **24 passed**.
