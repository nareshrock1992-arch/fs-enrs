# 10 — Configuration Guide

## Environment Variables

All configuration lives in `backend/.env` (copy from `backend/.env.example`).  
Controllers never read `process.env` directly — all values are centralised in `backend/src/config/index.js` and `backend/src/config/fsConfig.js`.

---

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `fs_enrs` | Database name |
| `DB_USER` | `enrs` | Database user |
| `DB_PASSWORD` | *(required)* | Database password |
| `DB_SSL` | `false` | Enable SSL (`true` for RDS/production) |

---

### JWT / Auth

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *(required)* | Sign/verify access tokens |
| `JWT_EXPIRY` | `15m` | Access token TTL |
| `REFRESH_SECRET` | *(required)* | Sign/verify refresh tokens |
| `REFRESH_EXPIRY` | `7d` | Refresh token TTL |

---

### ESL (FreeSWITCH Event Socket)

| Variable | Default | Description |
|---|---|---|
| `ESL_HOST` | `127.0.0.1` | FreeSWITCH ESL host |
| `ESL_PORT` | `8021` | ESL TCP port |
| `ESL_PASSWORD` | `ClueCon` | ESL auth password |

---

### Internal API Key

| Variable | Default | Description |
|---|---|---|
| `INTERNAL_API_KEY` | *(required)* | Shared secret for Lua → backend auth (`X-Internal-Key`) |

This value must also be set as `FS_INTERNAL_KEY` in the FreeSWITCH Lua environment (see FreeSWITCH section below).

---

### FreeSWITCH Filesystem Paths

All FS paths are read by `backend/src/config/fsConfig.js`. Defaults match a Debian/Ubuntu FreeSWITCH package install.

| Variable | Default | Description |
|---|---|---|
| `FS_CONF_DIR` | `/etc/freeswitch` | FS config root |
| `FS_DIALPLAN_DIR` | `/etc/freeswitch/dialplan` | Dialplan XML directory |
| `FS_SCRIPT_DIR` | `/usr/share/freeswitch/scripts` | Lua scripts directory |
| `FS_RECORDING_DIR` | `/var/lib/freeswitch/recordings` | Recording root |
| `FS_SOUND_DIR` | `/usr/share/freeswitch/sounds` | Audio prompts root |
| `FS_SIP_PROFILE_DIR` | `/etc/freeswitch/sip_profiles` | SIP gateway XML directory |

---

### ENS Originate Mode

| Variable | Default | Description |
|---|---|---|
| `ENS_ORIGINATE_MODE` | `gateway` | `user` (lab/extension dialing) or `gateway` (SIP trunk) |
| `ENS_DEFAULT_GATEWAY` | — | Default gateway name when per-contact override not set |

---

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4100` | Express server port |
| `NODE_ENV` | `development` | `production` enables helmet hardening |
| `CORS_ORIGIN` | `http://localhost:8100` | Allowed CORS origin |
| `UPLOAD_DIR` | `uploads/` | Relative upload staging directory |

---

### TTS (Text-to-Speech)

| Variable | Default | Description |
|---|---|---|
| `ENRS_TTS_ENGINE` | `flite` | TTS engine for Lua scripts |
| `ENRS_TTS_VOICE` | `kal` | Voice ID |

These are also passed to FreeSWITCH Lua via environment (see below).

---

## FreeSWITCH Lua Environment

Lua scripts read these variables at runtime. Set them in FreeSWITCH's `freeswitch.xml` or the init script that sources the environment before launching `freeswitch`.

```xml
<!-- /etc/freeswitch/freeswitch.xml -->
<X-PRE-PROCESS cmd="set" data="ENRS_INTERNAL_API=http://127.0.0.1:4100"/>
<X-PRE-PROCESS cmd="set" data="FS_INTERNAL_KEY=your-internal-api-key"/>
<X-PRE-PROCESS cmd="set" data="ENRS_TTS_ENGINE=flite"/>
<X-PRE-PROCESS cmd="set" data="ENRS_TTS_VOICE=kal"/>
<X-PRE-PROCESS cmd="set" data="ENRS_ERS_REC_DIR=/var/lib/freeswitch/recordings/ers"/>
<X-PRE-PROCESS cmd="set" data="ENRS_REC_DIR=/var/lib/freeswitch/recordings/ens"/>
```

Or if sourced via shell (systemd `EnvironmentFile=`):
```bash
ENRS_INTERNAL_API=http://127.0.0.1:4100
FS_INTERNAL_KEY=your-internal-api-key
ENRS_TTS_ENGINE=flite
ENRS_TTS_VOICE=kal
ENRS_ERS_REC_DIR=/var/lib/freeswitch/recordings/ers
ENRS_REC_DIR=/var/lib/freeswitch/recordings/ens
```

---

## FreeSWITCH Dialplan Setup

### Include ENRS dialplan directory

In your active dialplan context (e.g. `default.xml`), add:

```xml
<X-PRE-PROCESS cmd="include" data="enrs/*.xml"/>
```

This enables hot-reload: when the backend deploys a new IVR flow and issues `reloadxml`, FreeSWITCH picks up the new `enrs/<flow>.xml` file without restarting.

### ERS Direct Dial (bypass IVR)

For direct-dial ERS numbers that skip the IVR builder:

```xml
<extension name="ers_main_gate">
  <condition field="destination_number" expression="^1222$">
    <action application="lua" data="ers_conference_bridge.lua"/>
  </condition>
</extension>
```

### ENS Blast Number

```xml
<extension name="ens_blast">
  <condition field="destination_number" expression="^1333$">
    <action application="lua" data="ens_blast_trigger.lua"/>
  </condition>
</extension>
```

### ENS Retry Playback

```xml
<extension name="ens_retry">
  <condition field="destination_number" expression="^1334$">
    <action application="lua" data="ens_playback_handler.lua"/>
  </condition>
</extension>
```

---

## PM2 (Production Process Manager)

`backend/ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: 'fs-enrs',
    script: 'server.js',
    instances: 2,           // cluster mode
    exec_mode: 'cluster',
    env_production: {
      NODE_ENV: 'production',
      PORT: 4100
    }
  }]
}
```

Start:
```bash
cd backend && pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

The campaign engine uses a PostgreSQL advisory lock so only one cluster worker processes deliveries at a time — safe for multi-instance PM2.

---

## Docker

`backend/Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4100
CMD ["node", "server.js"]
```

Run with all required env vars:
```bash
docker run -d \
  -p 4100:4100 \
  -e DB_HOST=postgres \
  -e DB_PASSWORD=secret \
  -e JWT_SECRET=jwt-secret \
  -e REFRESH_SECRET=refresh-secret \
  -e INTERNAL_API_KEY=internal-key \
  -e ESL_HOST=freeswitch \
  -e FS_RECORDING_DIR=/recordings \
  -v /var/lib/freeswitch/recordings:/recordings \
  fs-enrs:latest
```

---

## Nginx (Production Reverse Proxy)

```nginx
server {
  listen 443 ssl;
  server_name enrs.example.com;

  # Block internal API from WAN
  location /api/v1/internal/ {
    deny all;
    return 403;
  }

  location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;
  }
}
```

**Critical:** The `/api/v1/internal/` location must be denied from external traffic. Lua scripts call the internal API on loopback (`127.0.0.1`) and should never be reachable from WAN.

---

## Database Setup

### Fresh Install
```bash
# Create DB and user
psql -U postgres -c "CREATE USER enrs WITH PASSWORD 'yourpassword';"
psql -U postgres -c "CREATE DATABASE fs_enrs OWNER enrs;"

# Run migrations (auto-detects fresh)
cd backend && node src/db/migrate.js

# Seed admin user + feature flags
node src/db/seed.js
```

Default admin credentials after seed: `admin@enrs.local` / `Admin@12345`

### Upgrade Existing DB
```bash
cd backend && node src/db/migrate.js
# Only unapplied migrations run
```

### Load Test Data
```bash
psql -U enrs -d fs_enrs -f docs/sample_data_yasref.sql
```

---

## Frontend Configuration

`frontend/vite.config.js` proxies all API and Socket.IO traffic to the backend in development:

```js
server: {
  port: 8100,
  proxy: {
    '/api': 'http://localhost:4100',
    '/socket.io': { target: 'http://localhost:4100', ws: true },
    '/uploads': 'http://localhost:4100'
  }
}
```

No `.env` file needed in the frontend for development — the backend URL is proxy-transparent.

For production builds (`npm run build`), the `dist/` output is served by Nginx from the same origin as the API, so no CORS or proxy configuration is needed.

---

## System Settings (Runtime, via UI)

The `system_settings` table stores runtime-mutable configuration managed via `PUT /api/v1/settings/:key`:

| Key | Description |
|---|---|
| `test_mode` | `true` / `false` — disables live calls (logs instead) |
| `test_mode_caller_id` | CLI number used when `test_mode=true` |
| `tts_engine` | Override TTS engine at runtime |
| `tts_voice` | Override TTS voice at runtime |

These apply to the campaign engine and IVR outbound calls without a server restart.
