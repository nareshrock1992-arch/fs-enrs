# Deployment Guide

## Overview

This guide covers installation, configuration, and production hardening of fs-enrs. The system consists of a Node.js backend, a React frontend, a PostgreSQL database, and a FreeSWITCH media server. All five components must be installed and configured before the system is operational.

---

## Prerequisites

| Component | Minimum Version | Notes |
|---|---|---|
| Node.js | 18+ | Required for backend and frontend build |
| PostgreSQL | 14+ | Database name: `fs_enrs` (configurable) |
| FreeSWITCH | 1.10+ | Requires `mod_conference`, `mod_lua`, `mod_event_socket` |
| Vite | Current | Frontend development server |
| nginx | Any current | Production frontend serving and reverse proxy |

---

## Installation

### Step 1 — Clone and Install Dependencies

```bash
git clone <repo>
cd fs-enrs

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### Step 2 — Environment Configuration

Copy `.env.example` to `backend/.env` and set the following variables:

```env
NODE_ENV=production
PORT=4100

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=fs_enrs
DB_USER=fs_enrs
DB_PASSWORD=<secure-password>
DB_SSL=false                          # Set to true for remote PostgreSQL

# JWT — use 32+ character random strings
JWT_ACCESS_SECRET=<32+ char random string>
JWT_REFRESH_SECRET=<32+ char random string>

# FreeSWITCH ESL
ESL_HOST=127.0.0.1
ESL_PORT=8021
ESL_PASSWORD=ClueCon                  # Change from default in production

# Internal Lua API key
INTERNAL_API_KEY=<secure-random-key-for-lua>

# Application
ENRS_API_URL=http://127.0.0.1:4100
FS_TTS_ENGINE=flite                   # or kal
CORS_ORIGIN=https://your-frontend-domain.com
```

> **Security note:** `ESL_PASSWORD` defaults to the well-known value `ClueCon`. Change this in both the backend `.env` and the FreeSWITCH `event_socket.conf.xml` before exposing the system to any network.

### Step 3 — Database Migration

```bash
cd backend
node src/db/migrate.js
```

The migration script auto-detects whether this is a fresh install or an upgrade:

- **Fresh DB** (no `tenants` table present): applies `schema.sql` (equivalent to migrations 001–005), marks those as applied, then runs migrations 006–030 in order.
- **Existing DB**: skips `schema.sql`; runs only unapplied numbered migrations.

All migration files are fully idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and manage their own `BEGIN/COMMIT` blocks.

### Step 4 — Seed Initial Data

```bash
cd backend
npm run seed
```

Creates the default admin user (`admin@enrs.local` / `Admin@12345`) and initializes feature flags.

> **Action required:** Change the admin password immediately after first login.

### Step 5 — Start Backend

**Development (hot-reload):**
```bash
cd backend
npm run dev        # node --watch server.js
```

**Production (PM2):**
```bash
pm2 start server.js --name enrs-backend --cwd /path/to/backend
```

See [PM2 Cluster Mode](#pm2-cluster-mode) for multi-process configuration.

### Step 6 — Build and Serve Frontend

```bash
cd frontend
npm run build      # Output to dist/
```

**nginx configuration:**

```nginx
server {
    listen 80;
    server_name your-frontend-domain.com;
    root /path/to/frontend/dist;

    location /api {
        proxy_pass http://localhost:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io {
        proxy_pass http://localhost:4100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /uploads {
        proxy_pass http://localhost:4100;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

> In production, add SSL/TLS termination with a valid certificate. WebSocket (`/socket.io`) requires the `Upgrade` and `Connection` headers shown above.

### Step 7 — FreeSWITCH Configuration

**Enable Event Socket** in `/etc/freeswitch/autoload_configs/event_socket.conf.xml`:

```xml
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="nat-map" value="false"/>
    <param name="listen-ip" value="127.0.0.1"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="ClueCon"/>
  </settings>
</configuration>
```

Replace `ClueCon` with the same value set in `ESL_PASSWORD`.

**Create sound directory:**

```bash
mkdir -p /usr/share/freeswitch/sounds/enrs
chown freeswitch:freeswitch /usr/share/freeswitch/sounds/enrs
```

**Create recording directories:**

```bash
mkdir -p /var/lib/freeswitch/recordings/{ers,ens,ivr,manual}
chown -R freeswitch:freeswitch /var/lib/freeswitch/recordings
```

### Step 8 — IVR Deployment

After creating and publishing IVR flows in the UI:

1. Navigate to `/deployment/flows`
2. Select the published flow and click **Deploy**
3. The system generates `ivr_executor.lua` and `enrs_ivr.xml`, sends `reloadxml` to FreeSWITCH, and verifies the extension is active

Alternatively, deploy via API:

```
POST /api/v1/deployment/flows/:uuid/deploy
```

### Step 9 — Verify Installation

```
GET /api/v1/deployment/diagnostics
```

Expected response fields:

| Field | Expected Value |
|---|---|
| `esl.connected` | `true` |
| `paths` | All resolved FreeSWITCH filesystem paths |
| `freeswitch.version` | FreeSWITCH version string |
| `audio_count` | Number of audio files deployed to `FS_SOUND_DIR/enrs/` |

---

## FreeSWITCH Path Environment Variables

Override these variables when FreeSWITCH is installed to non-standard paths.

| Variable | Default | Override When |
|---|---|---|
| `FS_CONF_DIR` | `/etc/freeswitch` | Non-standard FreeSWITCH install location |
| `FS_DIALPLAN_DIR` | `/etc/freeswitch/dialplan` | Non-standard dialplan directory |
| `FS_SCRIPT_DIR` | `/usr/share/freeswitch/scripts` | Non-standard Lua script directory |
| `FS_SOUND_DIR` | `/usr/share/freeswitch/sounds` | Non-standard or separate sound volume |
| `FS_RECORDINGS_DIR` | `/var/lib/freeswitch/recordings` | Separate recording storage volume |
| `ENRS_REC_DIR` | Same as `FS_RECORDINGS_DIR` | Alternative recording path |

---

## PM2 Cluster Mode

The campaign engine is PM2 cluster-safe. It uses PostgreSQL advisory locks to ensure only one worker processes campaign ticks at a time, even when multiple Node.js processes are running.

**`pm2.config.js` example:**

```js
module.exports = {
  apps: [{
    name: 'enrs-backend',
    script: 'server.js',
    instances: 2,           // or 'max' for all CPU cores
    exec_mode: 'cluster',
    cwd: '/path/to/backend',
    env: {
      NODE_ENV: 'production',
      PORT: 4100
    }
  }]
}
```

Start with: `pm2 start pm2.config.js`

---

## Production Checklist

- [ ] Change the default admin password (`admin@enrs.local` / `Admin@12345`)
- [ ] Set strong JWT secrets — minimum 32 random characters each
- [ ] Set a strong `INTERNAL_API_KEY` for Lua-to-backend authentication
- [ ] Change the FreeSWITCH ESL password from the default `ClueCon`
- [ ] Enable SSL/TLS on nginx with a valid certificate
- [ ] Set `CORS_ORIGIN` to the production frontend domain only
- [ ] Configure PostgreSQL with a non-default password and a dedicated database user
- [ ] Set `DB_SSL=true` when PostgreSQL is on a separate host
- [ ] Configure PM2 or systemd for automatic process restart on failure
- [ ] Set up log rotation for backend logs
- [ ] Firewall rules: expose only ports 80/443 (nginx) externally; port 8021 (FreeSWITCH ESL) must be accessible only from localhost or internal network
- [ ] Configure a recording retention policy for `/var/lib/freeswitch/recordings/`
- [ ] Verify `GET /api/v1/deployment/diagnostics` reports `esl.connected: true` after initial startup
