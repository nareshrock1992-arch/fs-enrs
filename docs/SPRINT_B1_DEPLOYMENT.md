# Sprint B1 — Deployment Instructions (Dabin Server)

## Files Changed / Created

```
NEW  backend/src/middleware/internalAuth.js
NEW  backend/src/controllers/internal/ensInternalController.js
NEW  backend/src/controllers/internal/ersInternalController.js
NEW  backend/src/routes/internal/ens.js
NEW  backend/src/routes/internal/ers.js
NEW  backend/src/routes/internal/index.js
NEW  backend/src/db/migrations/003_sprint_b1_internal_api.sql
NEW  backend/vitest.config.js
NEW  backend/src/__tests__/integration/internal-api.test.js
MOD  backend/server.js               (internal router mount + test export)
MOD  backend/src/routes/v1/ens.js    (removed 2 unsafe unauthenticated routes)
MOD  backend/src/services/socketService.js  (added _io + emitInternal export)
MOD  backend/package.json            (added test scripts + vitest devDeps)
```

---

## Step 1 — Install New Dev Dependencies

```bash
cd /path/to/fs-enrs/backend
npm install
```

This installs `vitest`, `supertest`, and `@vitest/coverage-v8`.
No new production dependencies were added.

---

## Step 2 — Add Environment Variable

Add to `/path/to/fs-enrs/backend/.env` on the Dabin server:

```env
INTERNAL_API_KEY=<generate a strong random secret — min 32 chars>
```

Generate one:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This value MUST match `FS_INTERNAL_KEY` on your FreeSWITCH server's environment.

---

## Step 3 — Apply Database Migration

```bash
psql -U fs_user -d fs_enrs -f backend/src/db/migrations/003_sprint_b1_internal_api.sql
```

Expected output:
```
BEGIN
ALTER TABLE
ALTER TABLE
CREATE INDEX
CREATE INDEX
...
COMMIT
```

Verify with:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('ens_configuration_contacts','ens_configuration_groups')
AND table_schema = 'public';
```

---

## Step 4 — Nginx Configuration Update

Add this block to your Nginx server config to block the internal API from public internet:

```nginx
# Block internal Lua API from WAN access
location /api/v1/internal {
    allow 127.0.0.1;
    allow ::1;
    # Allow FreeSWITCH server IP if on different host:
    # allow <FS_SERVER_IP>;
    deny all;
}
```

If FreeSWITCH is on the same machine as the backend, `127.0.0.1` alone is sufficient.

Test Nginx config: `nginx -t`
Reload: `nginx -s reload`

---

## Step 5 — Restart Backend

```bash
# PM2
pm2 restart fs-enrs-backend
pm2 logs fs-enrs-backend --lines 50

# Or node --watch for dev
cd backend && npm run dev
```

---

## Step 6 — Verify Internal API is Reachable From FreeSWITCH

On the FreeSWITCH server:

```bash
# Must return 403 (correct key rejected at Nginx for WAN, but FS is local)
curl -s http://<backend-host>:4100/api/v1/internal/ens/lookup?number=test \
  -H "X-Internal-Key: wrong-key" | jq .
# Expected: {"error":"Forbidden"}

# Must return 404 (correct key, unknown number)
curl -s http://<backend-host>:4100/api/v1/internal/ens/lookup?number=9999 \
  -H "X-Internal-Key: <your INTERNAL_API_KEY>" | jq .
# Expected: {"success":false,"error":"ENS number not found"}
```

---

## Step 7 — Update FreeSWITCH Lua Environment

On the FreeSWITCH server, ensure these variables are set in the environment
that FreeSWITCH starts with (e.g., `/etc/default/freeswitch` or systemd unit):

```bash
FS_INTERNAL_KEY=<same value as INTERNAL_API_KEY on backend>
FS_BACKEND_URL=http://<backend-host>:4100
```

Your existing Lua `.enc` scripts must use:
```lua
local BASE = os.getenv("FS_BACKEND_URL") or "http://127.0.0.1:4100"
local KEY  = os.getenv("FS_INTERNAL_KEY") or ""
-- All internal API calls:
-- url: BASE .. "/api/v1/internal/ens/lookup?number=" .. dest
-- headers: { ["X-Internal-Key"] = KEY }
```

---

## Step 8 — Run Tests

```bash
cd backend

# Set test env vars
export NODE_ENV=test
export INTERNAL_API_KEY=test-internal-key-32charmin
export DB_HOST=localhost
export DB_NAME=fs_enrs        # or fs_enrs_test if you have a test DB
export DB_USER=fs_user
export DB_PASSWORD=<password>

npm test
```

Expected output:
```
✓ Internal API — Authentication (3 tests)
✓ GET /api/v1/internal/ens/lookup (3 tests)
✓ GET /api/v1/internal/ens/notifications/queue-status (2 tests)
✓ POST /api/v1/internal/ens/notifications (4 tests)
✓ GET /api/v1/internal/ens/notifications/:uuid/pending-contacts (2 tests)
✓ PATCH /api/v1/internal/ens/notifications/:uuid/delivery (4 tests)
✓ GET /api/v1/internal/ens/callbacks/authorize (3 tests)
✓ POST /api/v1/internal/ens/callbacks (1 test)
✓ POST /api/v1/internal/ens/notifications/:uuid/complete (2 tests)
✓ GET /api/v1/internal/ers/lookup (2 tests)
✓ POST /api/v1/internal/ers/incidents (3 tests)
✓ PATCH /api/v1/internal/ers/incidents/:uuid/responder (3 tests)
✓ GET /api/v1/internal/ers/incidents/rejoin (3 tests)
✓ GET /api/v1/internal/ers/incidents/open-join (2 tests)
✓ POST /api/v1/internal/ers/incidents/:uuid/observer (1 test)
✓ POST /api/v1/internal/ers/incidents/:uuid/complete (3 tests)
✓ Public ENS router — no Lua leakage (1 test)

Tests: 42 passed
```

---

## Step 9 — End-to-End Smoke Test

From a phone or SIP softphone:

1. **ENS test**: Dial your ENS destination_number (e.g. 1200)
   - Expected: Lua `blast_call.lua` runs → hits `/api/v1/internal/ens/lookup` → gets contacts → blast proceeds
   - Check dashboard: notification should appear as IN_PROGRESS

2. **ERS test**: Dial your ERS emergency_number (e.g. 1222)
   - Expected: Lua `dial_911_conference.lua` runs → conference created → responders dialed
   - Check dashboard: incident should appear as ACTIVE with responder count

3. **ERS rejoin test**: Dial rejoin_number (e.g. 1223) from a responder phone
   - Expected: `dial_ers_callback.lua` → `/internal/ers/incidents/rejoin` → rejoins conference

---

## Rollback Procedure

If something goes wrong:

```bash
# 1. Revert server.js internal mount (remove 3 lines)
# 2. Re-add the 2 removed routes to ens.js (from git)
git stash  # or git checkout -- backend/server.js backend/src/routes/v1/ens.js

# 3. Rollback migration (only if B1 tables cause issues)
psql -U fs_user -d fs_enrs -c "
  DROP TABLE IF EXISTS ens_configuration_contacts CASCADE;
  DROP TABLE IF EXISTS ens_configuration_groups CASCADE;
  ALTER TABLE ers_incident_responders DROP COLUMN IF EXISTS mobile_number;
"

# 4. Restart backend
pm2 restart fs-enrs-backend
```
