# API Reference — External Integration Endpoints

Endpoints intended for **external systems** to call (HR sync jobs,
customer provisioning scripts). Everything here requires a normal
authenticated session (JWT Bearer token from `POST /api/v1/auth/login`)
with ADMIN role — these are NOT the `/api/v1/internal/*` Lua-contract
endpoints, which are reserved for FreeSWITCH and protected by
`X-Internal-Key`.

## POST /api/v1/ers/broadcast-users

Bulk-upsert the emergency broadcast user list — the spec's "user list
updated by invoking API" requirement. Creates or updates contacts and
links them into a named responder group (which both ENS configurations
and ERS tiers reference).

**Identity/matching rule:** a user is matched to an existing contact by
mobile number (last-9-digit normalized, same rule used everywhere else in
the system). Matched contacts get their name updated and extension filled
in if provided; unmatched ones are created. Users are never deleted by
this endpoint — removal is a deliberate UI action.

### Request

```http
POST /api/v1/ers/broadcast-users
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "organization_id": 1,
  "group_name": "Emergency Broadcast List",
  "users": [
    { "name": "Alice Nasser",  "extension": "1001", "mobile": "0501110001" },
    { "name": "Bob Rahman",    "extension": "1002", "mobile": "0501110002" },
    { "name": "Carol Odeh",                          "mobile": "0501110003" }
  ]
}
```

- `organization_id` — required, the owning organization.
- `group_name` — required; the responder group is found-or-created by
  this name within the organization.
- `users[]` — 1 to 500 entries per call. `name` and `mobile` required;
  `extension` optional.

### Response

```json
{
  "success": true,
  "group_id": 12,
  "created": 2,
  "updated": 1,
  "total": 3
}
```

### Errors

- `400` — validation failure (missing fields, >500 users, malformed
  numbers); body contains the specific Zod issues.
- `401` — missing/expired token.
- `403` — authenticated but not ADMIN.

### After syncing

The group appears under **Organization → Responder Groups** and can be
attached to any ENS configuration (blast list) or ERS tier. Blasts reach
each contact's extension **and** mobile as independent delivery legs.

## Reporting endpoints (read-only, ADMIN/OPERATOR)

- `GET /api/v1/reports/ers-incidents?from=YYYY-MM-DD&to=YYYY-MM-DD` —
  every incident with full participant detail (join/leave/rejoin
  timestamps, directory identity, recording path).
- `GET /api/v1/reports/ens-broadcasts?from=&to=` — every broadcast with
  per-contact delivery status (per number, so a contact's desk and
  mobile legs report separately) and the authorized-playback access log.
