# Sprint B6 — Stabilization Deployment Guide

## What changed in this sprint

| Area | Change |
|------|--------|
| Database | Migration `005_stabilization.sql` — adds all missing columns, indexes, backfills |
| DB migration runner | `migrate.js` rewritten — sequential runner with `migration_log` tracking |
| `schema.sql` | Updated to canonical final state (30 tables, correct FK order) |
| IVR validator | Pre-flight guards for null nodes; fixed `media_files` tenant query |
| IVR controller | Fixed all `req.user.tenant_id` → `req.user.tenantId` (11 occurrences) |
| ENS internal API | Fixed `resolveEnsContacts` column names; dropped `NOT NULL` on `emergency_contact_id` |
| FreeSWITCH config | Centralized `src/config/fsConfig.js` — all paths from env vars |
| `.env.example` | Added `FS_*` path docs, `INTERNAL_API_KEY`, `ENS_ORIGINATE_MODE` |
| `ecosystem.config.cjs` | Removed hardcoded `/opt/freeswitch-ui/fs-enrs/backend` path |

---

## Pre-deployment checklist

- [ ] Take a full PostgreSQL backup (see below)
- [ ] Verify `.env` has all required variables (compare against `.env.example`)
- [ ] Verify `INTERNAL_API_KEY` matches `FS_INTERNAL_KEY` on FreeSWITCH
- [ ] Review FreeSWITCH `FS_*` path variables — set any that differ from Debian defaults
- [ ] Confirm PM2 is installed: `pm2 --version`
- [ ] Confirm `node --version` ≥ 18

---

## Step 1 — Database backup

```bash
# Replace with your actual DB name / user
pg_dump -U fs_enrs -Fc fs_enrs > /var/backups/fs_enrs_$(date +%Y%m%d_%H%M%S).dump

# Verify backup is readable
pg_restore --list /var/backups/fs_enrs_*.dump | head -20
```

---

## Step 2 — Pull latest code

```bash
cd /opt/freeswitch-ui/fs-enrs
git pull origin main
```

---

## Step 3 — Install dependencies

```bash
cd backend
npm install --omit=dev
```

---

## Step 4 — Update environment

```bash
# Compare .env against .env.example for any new required variables
diff .env .env.example

# Add any missing variables to .env:
# INTERNAL_API_KEY=<your_32_char_hex>
# ENS_ORIGINATE_MODE=gateway   # or 'user' for lab
#
# Optional FreeSWITCH path overrides (only if not using Debian package defaults):
# FS_BASE_DIR=/usr/share/freeswitch
# FS_SCRIPT_DIR=/usr/share/freeswitch/scripts
# FS_RECORDING_DIR=/var/lib/freeswitch/recordings
```

---

## Step 5 — Run database migrations

```bash
cd /opt/freeswitch-ui/fs-enrs/backend
node src/db/migrate.js
```

Expected output:
```
[migrate] Applying: schema.sql        ← first run only; skipped on subsequent runs
[migrate]  ✓ schema.sql
[migrate] Skip (already applied): 001_...
[migrate] Skip (already applied): 002_...
[migrate] Skip (already applied): 003_...
[migrate] Skip (already applied): 004_...
[migrate] Applying: 005_stabilization.sql
[migrate]  ✓ 005_stabilization.sql
[migrate] All migrations applied successfully.
```

If you see `Skip (already applied)` for all files — the database is already up to date, no action needed.

### Verify migration applied

```sql
-- Run in psql
SELECT filename, applied_at FROM migration_log ORDER BY applied_at;

-- Spot-check a key column added by 005
SELECT column_name FROM information_schema.columns
WHERE table_name = 'ens_configurations' AND column_name = 'tenant_id';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'ivr_flows' AND column_name = 'flow_uuid';
```

---

## Step 6 — Restart the backend

```bash
cd /opt/freeswitch-ui/fs-enrs/backend

# If PM2 is already running:
pm2 restart fs-enrs-backend

# First-time PM2 setup:
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

---

## Step 7 — Smoke tests

### Backend health
```bash
curl -s http://localhost:4100/health | jq .
# Expected: { "status": "ok", "db": "connected" }
```

### Authentication
```bash
curl -s -X POST http://localhost:4100/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@enrs.local","password":"Admin@12345"}' | jq .access_token
```

### IVR list (requires JWT)
```bash
TOKEN=<paste_access_token>
curl -s http://localhost:4100/api/v1/ivr/flows \
  -H "Authorization: Bearer $TOKEN" | jq .total
```

### Internal API (from localhost only)
```bash
curl -s http://localhost:4100/api/v1/internal/ens/lookup?number=5551000 \
  -H "X-Internal-Key: $INTERNAL_API_KEY"
# Expected: 200 with data, or 404 "ENS number not found"
```

### ENS notification queue status
```bash
curl -s "http://localhost:4100/api/v1/internal/ens/notifications/queue-status?configuration_id=1" \
  -H "X-Internal-Key: $INTERNAL_API_KEY" | jq .
```

---

## Rollback procedure

If migration `005_stabilization.sql` causes issues:

```sql
-- The migration only ADDs columns — it never drops or renames.
-- To revert, remove the migration_log entry so it re-runs after a fix:
DELETE FROM migration_log WHERE filename = '005_stabilization.sql';

-- Then restore from backup if data is corrupt:
-- pg_restore -U fs_enrs -d fs_enrs /var/backups/fs_enrs_<timestamp>.dump
```

To roll back the application to the previous commit:
```bash
git log --oneline -5          # find the previous commit hash
git checkout <previous_hash>
pm2 restart fs-enrs-backend
```

---

## PM2 commands reference

```bash
pm2 list                          # show all processes
pm2 logs fs-enrs-backend          # tail logs
pm2 logs fs-enrs-backend --lines 200  # last 200 lines
pm2 restart fs-enrs-backend       # restart
pm2 stop    fs-enrs-backend       # stop
pm2 delete  fs-enrs-backend       # remove from PM2
pm2 monit                         # live dashboard
```

---

## FreeSWITCH path configuration

All FreeSWITCH paths are now read from environment variables. The defaults match
a standard Debian/Ubuntu package install:

| Variable | Default |
|----------|---------|
| `FS_BASE_DIR` | `/usr/share/freeswitch` |
| `FS_CONF_DIR` | `/etc/freeswitch` |
| `FS_DIALPLAN_DIR` | `/etc/freeswitch/dialplan` |
| `FS_DIRECTORY_DIR` | `/etc/freeswitch/directory` |
| `FS_SIP_PROFILE_DIR` | `/etc/freeswitch/sip_profiles` |
| `FS_SCRIPT_DIR` | `/usr/share/freeswitch/scripts` |
| `FS_SOUND_DIR` | `/usr/share/freeswitch/sounds` |
| `FS_RECORDING_DIR` | `/var/lib/freeswitch/recordings` |
| `FS_STORAGE_DIR` | `/var/lib/freeswitch/storage` |
| `FS_DB_DIR` | `/var/lib/freeswitch/db` |
| `FS_LOG_DIR` | `/var/log/freeswitch` |

Only set these in `.env` if your installation differs from the defaults.

---

## Nginx security reminder

Ensure `/api/v1/internal` is blocked from WAN:

```nginx
location /api/v1/internal {
    deny all;
    return 403;
}
```

The internal API is authenticated by `X-Internal-Key` and must only be reachable
from `127.0.0.1` (FreeSWITCH Lua scripts on the same host).
