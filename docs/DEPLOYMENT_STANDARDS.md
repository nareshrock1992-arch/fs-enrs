# DEPLOYMENT STANDARDS — fs-enrs

## Environment Tiers

| Tier | Purpose | Branch |
|---|---|---|
| development | Local dev, hot reload | any feature branch |
| staging | Pre-production validation | `develop` |
| production | Live system | `main` |

## Environment Variables

Every tier requires a `.env` file (never committed to git):

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=fs_enrs
DB_USER=fs_user
DB_PASSWORD=<strong>
DB_MAX_CONNECTIONS=20

# Auth
JWT_ACCESS_SECRET=<min 32 chars>
JWT_REFRESH_SECRET=<min 32 chars, different from above>
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d

# Internal API
INTERNAL_API_KEY=<min 32 chars>

# App
PORT=4100
FRONTEND_URL=http://localhost:8100
NODE_ENV=production

# Media
MEDIA_STORAGE_PATH=/var/enrs/media

# Encryption (PBX passwords)
ENCRYPTION_KEY=<64-char hex, 32 bytes>

# Redis (Phase C)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=<strong>

# AI (Phase C)
OPENAI_API_KEY=<key>
```

## PM2 Configuration (ecosystem.config.cjs)

```js
module.exports = {
  apps: [
    {
      name: 'fs-enrs-backend',
      script: './backend/src/app.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4100,
      }
    },
    {
      name: 'fs-enrs-frontend',
      script: 'serve',
      args: '-s dist -l 8100',
      cwd: './frontend',
    }
  ]
};
```

Start: `pm2 start ecosystem.config.cjs --env production`

## Nginx Configuration

```nginx
server {
  listen 80;
  server_name enrs.yourdomain.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name enrs.yourdomain.com;

  ssl_certificate     /etc/letsencrypt/live/enrs.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/enrs.yourdomain.com/privkey.pem;

  # Block internal API from public internet
  location /internal {
    deny all;
    return 403;
  }

  # API proxy
  location /api/ {
    proxy_pass         http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection 'upgrade';
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;
  }

  # Socket.IO proxy
  location /socket.io/ {
    proxy_pass         http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection 'upgrade';
  }

  # Frontend SPA
  location / {
    root   /var/enrs/frontend/dist;
    try_files $uri $uri/ /index.html;
  }
}
```

## Database Migration Workflow

```bash
# Always run migrations before deploying new backend version
psql -U fs_user -d fs_enrs -f backend/src/db/migrations/001_initial.sql
psql -U fs_user -d fs_enrs -f backend/src/db/migrations/002_phase6_bugfixes.sql
psql -U fs_user -d fs_enrs -f backend/src/db/migrations/003_phase_b.sql
```

Verify: `SELECT id, created_at FROM schema_migrations ORDER BY id DESC LIMIT 5;`

## Frontend Build

```bash
cd frontend
npm install
npm run build
# Output: frontend/dist/
# Copy to: /var/enrs/frontend/dist/
```

## Health Check Endpoints

```
GET /health
→ { db: 'ok', esl: 'connected'|'disconnected', redis: 'ok'|'unavailable', uptime: 12345 }
```

Nginx upstream health check polls `/health` every 10s.

## Deployment Checklist

- [ ] `.env` file exists with all required vars
- [ ] Migrations applied to target database
- [ ] Frontend built (`npm run build`)
- [ ] PM2 restarted (`pm2 reload fs-enrs-backend`)
- [ ] Nginx reloaded (`nginx -s reload`)
- [ ] `GET /health` returns all services `ok`
- [ ] Socket.IO test: dashboard shows real-time updates
- [ ] ESL connection shown as `connected` in monitoring page
- [ ] Test ENS trigger with one contact
- [ ] Test ERS incident creation from Lua
- [ ] Audit log shows operations

## Rollback Procedure

1. `pm2 stop fs-enrs-backend`
2. `git checkout <previous-tag>`
3. `npm install` in backend
4. If migration was applied: run rollback SQL (documented in each migration file)
5. `pm2 start ecosystem.config.cjs --env production`
6. Verify `/health`
