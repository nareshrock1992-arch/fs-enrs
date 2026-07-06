# SECURITY STANDARDS — fs-enrs

## Authentication

- JWT RS256 (or HS256 with ≥ 32-char secret from env)
- Access token TTL: 15 minutes
- Refresh token TTL: 7 days, stored in `refresh_tokens` table (revocable)
- Passwords: `bcrypt` cost 12 — never plaintext, never MD5/SHA1
- Password history: last 5 hashes stored in `password_history`, reject reuse
- Failed login: rate-limit to 5 attempts per 15 min per IP (express-rate-limit)

## Internal API Security

- `X-Internal-Key` read ONLY from `process.env.INTERNAL_API_KEY`
- Never log this header value
- Middleware rejects immediately with 403 if header absent or wrong
- Route must be mounted separately from public routes, never under `/api/v1/`
- Firewall rule: `/internal/*` must not be publicly routable (Nginx deny block)

```nginx
location /internal {
  deny all;
}
```

## RBAC Threat Model

| Attack | Mitigation |
|---|---|
| VIEWER accesses admin endpoint | `adminOnly` middleware on all mutating routes |
| User accesses other tenant's data | `tenant_id` filter on all SQL queries |
| Operator triggers another org's ENS | `organization_id` validated against `req.user.tenant_id` |
| Token stolen after logout | `refresh_tokens` table deletion on logout; Redis blocklist (Phase C) |

## Input Validation

- All request bodies validated via Zod before any DB operation
- Query parameters for IDs: `parseInt(req.params.id, 10)` — reject NaN with 400
- File uploads (media library): validate MIME type + file extension, max 50MB, store outside webroot
- Never pass user input directly to `eslService.bgapi()` — always whitelist-validate phone numbers with regex `^[0-9+\-\s()]{7,20}$`

## SQL Injection Prevention

- ALL queries use parameterized `$n` placeholders — zero string interpolation into SQL
- No raw query string building from user input under any circumstances

## XSS Prevention

- All API responses are JSON, never HTML
- Frontend renders data via React JSX (auto-escapes) — never `dangerouslySetInnerHTML`
- Content-Security-Policy header via Helmet.js (Phase C)

## Sensitive Data Handling

- PBX connection passwords: encrypted at rest using AES-256-GCM before INSERT
  - Key from `process.env.ENCRYPTION_KEY` (32 bytes, hex-encoded)
  - Never return decrypted password in API responses
- Recording files: stored with UUID filename, not original caller ID
- Audit log `request_payload`: strip password fields before logging
  ```js
  const sanitized = { ...req.body };
  delete sanitized.password;
  delete sanitized.new_password;
  ```

## Security Headers (Phase C — Helmet.js)

```js
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "wss:"],
    }
  }
}));
```

## Rate Limiting

```js
// Auth endpoints
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 5 });
app.use('/api/v1/auth/login', authLimiter);

// General API
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 1000 });
app.use('/api/', apiLimiter);
```

## Environment Variables (Required)

```
JWT_ACCESS_SECRET      >= 32 chars
JWT_REFRESH_SECRET     >= 32 chars, different from ACCESS_SECRET
INTERNAL_API_KEY       >= 32 chars, matches FS_INTERNAL_KEY on FreeSWITCH server
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
ENCRYPTION_KEY         32-byte hex for AES-256-GCM (PBX passwords)
MEDIA_STORAGE_PATH     absolute path, outside webroot
```

Server must refuse to start if any required env var is missing:
```js
const required = ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','INTERNAL_API_KEY','DB_HOST'];
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1); }
}
```

## Audit Log Must-Audit Events

Every call to these controllers must be wrapped with `auditLog(action)` middleware:

```
user.create / user.update / user.delete / user.password_change
organization.create / organization.update / organization.delete
ens_configuration.create / ens_configuration.update / ens_configuration.delete
ens_notification.trigger
ers_configuration.create / ers_configuration.update / ers_configuration.delete
ers_incident.create / ers_incident.end
did.assign / did.unassign
pbx_connection.create / pbx_connection.delete
```
