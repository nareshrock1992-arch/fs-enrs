# 05 — API Testing Guide

## Prerequisites

- Backend running: `cd backend && npm run dev`
- Database migrated: `node src/db/migrate.js`
- Seeded: `node src/db/seed.js`
- Default admin: `admin@enrs.local` / `Admin@12345`

---

## 1. Authentication

### Login and capture token

```bash
TOKEN=$(curl -s -X POST http://localhost:4100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@enrs.local","password":"Admin@12345"}' \
  | jq -r '.token')

echo "Token: $TOKEN"
```

All subsequent commands use:
```bash
-H "Authorization: Bearer $TOKEN"
```

### Verify token works
```bash
curl http://localhost:4100/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "id": 1, "email": "admin@enrs.local", "role": "ADMIN" }`

---

## 2. Health Check

```bash
curl http://localhost:4100/api/health
```

Expected: `{ "status": "ok", "service": "fs-enrs" }`

---

## 3. ERS Configuration

### Create a configuration
```bash
curl -s -X POST http://localhost:4100/api/v1/ers/configurations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test ERS",
    "primary_bridge_number": "3010",
    "secondary_bridge_number": "3011",
    "conference_profile": "default",
    "conference_type": "STATIC",
    "max_concurrent_conferences": 2,
    "queue_enabled": true,
    "recording_enabled": false,
    "recording_mode": "MANUAL"
  }' | jq .
```

Expected: `{ "id": 1, "name": "Test ERS", ... }`

### List configurations
```bash
curl http://localhost:4100/api/v1/ers/configurations \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Get tier groups
```bash
curl http://localhost:4100/api/v1/ers/configurations/1/tier-groups \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Assign contacts to primary tier
```bash
curl -s -X PUT http://localhost:4100/api/v1/ers/configurations/1/tier-groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"primary_contact_ids":[1,2],"secondary_contact_ids":[],"primary_group_ids":[],"secondary_group_ids":[]}' \
  | jq .
```

---

## 4. Service Registry (Emergency Number → Config Binding)

### Create binding
```bash
curl -s -X POST http://localhost:4100/api/v1/services \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "1222",
    "type": "ERS",
    "description": "Main Gate",
    "ers_configuration_id": 1,
    "is_active": true
  }' | jq .
```

### List all bindings
```bash
curl http://localhost:4100/api/v1/services \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 5. Internal API (Lua Contract)

Set the internal key:
```bash
INTERNAL_KEY="your-internal-api-key"  # matches INTERNAL_API_KEY in .env
```

### ERS Lookup
```bash
curl -s "http://localhost:4100/api/v1/internal/ers/lookup?number=1222" \
  -H "X-Internal-Key: $INTERNAL_KEY" | jq .
```

Expected response includes:
```json
{
  "success": true,
  "primary_bridge_number": "3010",
  "conference_profile": "default",
  "conference_type": "STATIC",
  "can_accept": true,
  "primary_responders": [...]
}
```

**Security check:** Verify `pin` is NOT in the response body (ERS doesn't use PIN, but ENS lookup must not return raw PIN either).

### ENS Lookup
```bash
curl -s "http://localhost:4100/api/v1/internal/ens/lookup?number=1333" \
  -H "X-Internal-Key: $INTERNAL_KEY" | jq .
```

Verify: response contains `pin_required: true/false` but **not** `pin: "1234"`.

### ENS Verify PIN
```bash
curl -s -X POST http://localhost:4100/api/v1/internal/ens/verify-pin \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"configuration_id":1,"pin":"1234"}' | jq .
```

Expected: `{"valid":true}` or `{"valid":false}`

### Test internal auth rejection
```bash
curl -s "http://localhost:4100/api/v1/internal/ers/lookup?number=1222" \
  -H "X-Internal-Key: wrong-key" | jq .
```

Expected: `401 Unauthorized`

### Test JWT can't access internal routes
```bash
curl -s "http://localhost:4100/api/v1/internal/ers/lookup?number=1222" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: `401 Unauthorized` (JWT is not accepted on internal routes)

---

## 6. Monitoring (Live Conference State)

### Get all conferences
```bash
curl http://localhost:4100/api/v1/monitoring/conferences \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### ESL connection status
```bash
curl http://localhost:4100/api/v1/monitoring/status \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: `{"connected": true, "conferenceCount": 0}`

---

## 7. Deployment

### Check FreeSWITCH paths
```bash
curl http://localhost:4100/api/v1/deployment/diagnostics/paths \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Run diagnostics
```bash
curl http://localhost:4100/api/v1/deployment/diagnostics \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Reload XML (requires FreeSWITCH running)
```bash
curl -X POST http://localhost:4100/api/v1/deployment/diagnostics/reloadxml \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 8. IVR Flow Publish Pipeline

```bash
# 1. Create flow
FLOW_ID=$(curl -s -X POST http://localhost:4100/api/v1/ivr/flows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Flow","description":"API test"}' \
  | jq -r '.id')

echo "Flow ID: $FLOW_ID"

# 2. Save graph
curl -s -X PUT "http://localhost:4100/api/v1/ivr/flows/$FLOW_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "graph": {
      "entry_node_id": "node1",
      "nodes": {
        "node1": {
          "type": "PLAYBACK",
          "label": "Welcome",
          "config": {"audio_file": "welcome.wav"},
          "next": null
        }
      }
    }
  }' | jq .

# 3. Validate
curl -s -X POST "http://localhost:4100/api/v1/ivr/flows/$FLOW_ID/validate" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 4. Publish
curl -s -X POST "http://localhost:4100/api/v1/ivr/flows/$FLOW_ID/publish" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"change_notes":"Initial publish"}' | jq .
```

---

## 9. Role-Based Access Control

Test that VIEWER cannot create configurations:

```bash
# Login as a VIEWER user
VIEWER_TOKEN=$(curl -s -X POST http://localhost:4100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@enrs.local","password":"Viewer@12345"}' \
  | jq -r '.token')

# Try to create ERS config (should fail with 403)
curl -s -X POST http://localhost:4100/api/v1/ers/configurations \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Should Fail"}' | jq .
```

Expected: `{ "error": "Insufficient permissions" }` with HTTP 403.

---

## 10. Rate Limit Testing

### Auth rate limit (10 requests per 15 min)
```bash
for i in {1..12}; do
  curl -s -X POST http://localhost:4100/api/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"bad@test.com","password":"wrong"}' \
    -o /dev/null -w "$i: %{http_code}\n"
done
```

Expected: First 10 return 401, then 429 Too Many Requests.

---

## 11. Soft-Delete Verification

```bash
# Create
ID=$(curl -s -X POST http://localhost:4100/api/v1/contacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","last_name":"Contact","extension_number":"9999"}' \
  | jq -r '.id')

# Delete (soft)
curl -s -X DELETE "http://localhost:4100/api/v1/contacts/$ID" \
  -H "Authorization: Bearer $TOKEN"

# Verify it no longer appears in list
curl -s "http://localhost:4100/api/v1/contacts?search=9999" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

Expected: `0` (not in list, but row exists in DB with `deleted_at` set).

---

## 12. Conference Profile Sanitization (Security)

This test verifies the `3010-192.168.1.133` bug is fixed.

```bash
# Create ERS config with a SIP IP as the conference_profile
curl -s -X POST http://localhost:4100/api/v1/ers/configurations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sanitization Test",
    "primary_bridge_number": "3010",
    "conference_profile": "192.168.1.133"
  }' | jq .

# Get the config back via internal lookup (bind it to a number first)
# The response must show conference_profile: "default" not "192.168.1.133"
curl -s "http://localhost:4100/api/v1/internal/ers/lookup?number=<test_number>" \
  -H "X-Internal-Key: $INTERNAL_KEY" | jq '.conference_profile'
```

Expected: `"default"` (the IP is sanitized away).

---

## Common Failure Modes

| Symptom | Likely Cause |
|---|---|
| `401 Unauthorized` on UI route | Token expired — re-run login |
| `401 Unauthorized` on internal route | Wrong `INTERNAL_API_KEY` in env |
| `404 Not Found` | Wrong URL or deleted resource |
| `409 Conflict` | Unique constraint (duplicate number/email) |
| `500 Internal Server Error` | DB not migrated or ESL not connected |
| `429 Too Many Requests` | Rate limit hit — wait or use a different IP |
| Conference list returns `[]` | FreeSWITCH ESL not connected (expected in dev without FS) |
