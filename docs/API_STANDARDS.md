# API STANDARDS — fs-enrs

## Base URL

```
Public API:   /api/v1/
Internal API: /internal/          (X-Internal-Key only, never public)
```

## Authentication

### Public API
```
Authorization: Bearer <jwt_access_token>
Content-Type: application/json
```

Access token TTL: 15 minutes. Refresh via `POST /api/v1/auth/refresh`.

### Internal API (Lua Contract)
```
X-Internal-Key: <INTERNAL_API_KEY env var>
Content-Type: application/json
```

Never accepts JWT. Must be behind firewall. Must never appear in public route mounts.

## HTTP Method Semantics

| Method | Usage |
|---|---|
| GET | Read. No side effects. Query params for filters. |
| POST | Create resource or trigger action. Body = JSON. Returns 201 + created row. |
| PUT | Full or partial update. Body = JSON. Returns 200 + updated row. |
| DELETE | Soft delete. Returns 204 No Content. |
| PATCH | Reserved for toggle/status operations (e.g., `PATCH /:id/toggle`). |

## URL Conventions

```
GET    /api/v1/organizations              list (paginated)
POST   /api/v1/organizations              create
GET    /api/v1/organizations/:id          get single
PUT    /api/v1/organizations/:id          update
DELETE /api/v1/organizations/:id          soft delete

GET    /api/v1/organizations/locations    sub-resource list
POST   /api/v1/organizations/locations    create sub-resource
```

CRITICAL: Sub-resource routes MUST be registered before `/:id` wildcard.

## Pagination

All list endpoints support:
```
?page=1&limit=25&search=&org_id=
```

Response:
```json
{
  "organizations": [...],
  "total": 142,
  "page": 1,
  "limit": 25
}
```

Default limit: 25. Max limit: 500.

## Error Response Format

```json
{
  "error": "Human-readable message",
  "details": [...]   // optional: Zod validation errors
}
```

| Status | Meaning |
|---|---|
| 400 | Bad request / missing required field |
| 401 | Missing or invalid JWT |
| 403 | Authenticated but insufficient RBAC role |
| 404 | Resource not found |
| 409 | Conflict (unique constraint violation) |
| 422 | Validation error (Zod parse failure) |
| 500 | Internal server error |

## Internal API Routes (B1 Contract)

### ENS

```
GET  /internal/ens/lookup
     ?destination_number=1200
     → { config_id, name, blast_clid, reply_clid, retry_count, retry_delay_seconds }

POST /internal/ens/notifications
     { ens_configuration_id, total_targets, triggered_by_lua: true }
     → { notification_uuid }

POST /internal/ens/notifications/:uuid/delivery
     { emergency_contact_id, status, attempt_number, answered_at, hangup_at }
     → { ok: true }
```

### ERS

```
GET  /internal/ers/lookup
     ?destination_number=1100
     → { config_id, name, pin, primary_group_id, secondary_group_id, max_concurrent }

POST /internal/ers/incidents
     { ers_configuration_id, emergency_call_number, caller_id_number }
     → { incident_uuid, conference_name }

PUT  /internal/ers/incidents/:uuid/responder
     { emergency_contact_id, status, joined_at }
     → { ok: true }

PUT  /internal/ers/incidents/:uuid/status
     { status }   -- 'ACTIVE','ENDED','TRANSFERRED'
     → { ok: true }

POST /internal/ers/incidents/rejoin
     { incident_uuid, emergency_contact_id }
     → { conference_name }

GET  /internal/ers/queue/next
     ?ers_config_id=5
     → { queue_id, caller_number, position } | null

POST /internal/ers/queue/:id/status
     { status }   -- 'PROCESSING','COMPLETED','ABANDONED'
     → { ok: true }
```

### IVR (Phase B3)

```
GET  /internal/ivr/flow
     ?did=1300
     → { flow_id, version_id, nodes: [...] }

POST /internal/ivr/simulate
     { flow_version_id, inputs: ['1','2'] }
     → { trace: [{ node_id, type, output, next }] }

POST /internal/ivr/ai-intent
     { flow_id, transcript }
     → { intent, confidence }
```

## RBAC Route Guards

```js
adminOnly  = requireAuth + role IN ('ADMIN','SUPERADMIN')
adminOrOp  = requireAuth + role IN ('ADMIN','SUPERVISOR','OPERATOR','SUPERADMIN')
anyAuth    = requireAuth  (VIEWER and above)
```

Applied at route registration, not inside controller functions.
