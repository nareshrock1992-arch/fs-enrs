# Runtime Architecture

## Backend Entry Point — `server.js`

`server.js` is the single process entry point. On startup it performs the following sequence:

1. Load `.env` via `load-env.js` (before any other module so env vars are available at import time).
2. Create the Express application and attach global middleware.
3. Mount both route trees (`/api/v1` and `/api/v1/internal`).
4. Create the HTTP server and attach Socket.IO via `initSocket(httpServer)`.
5. Connect to FreeSWITCH via `eslService.connect()`.
6. Start background jobs via `eslService.startBackgroundJobs()`.
7. Run a one-shot reconcile after 5 seconds (`reconcileAllActiveIncidents`) to resolve any incidents that were active when the backend last stopped.
8. Listen on `config.port` (default: 4100).

---

## Express Middleware Stack

Applied in order to every request:

| Middleware | Purpose |
|---|---|
| `cors` | Allows origins from `CORS_ORIGIN` env var (comma-separated, default `http://localhost:8100`) |
| `helmet` | Sets security-related HTTP headers |
| `morgan` | HTTP access log (format: `combined` in production, `dev` in development) |
| `express.json()` | Parses `application/json` bodies; 10 MB limit |
| `express.urlencoded()` | Parses URL-encoded form bodies |
| `rateLimiter` | General rate limiter for `/api/v1/*`; internal routes use a separate higher-limit instance |
| `requireAuth` or `requireInternalKey` | Route-level auth applied per router, not globally |

---

## `asyncHandler` — Error Propagation

All route handlers are wrapped with `asyncHandler` (`backend/src/middleware/asyncHandler.js`):

```js
export const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
```

This ensures that any thrown error or rejected promise in a route handler is passed to Express's error-handling chain without needing try/catch in every handler. The centralised `errorHandler` middleware at the bottom of the middleware stack handles all errors.

---

## Zod Validation

Request bodies and query parameters are validated using Zod schemas. The `validate` middleware (`backend/src/middleware/validate.js`) takes a Zod schema and applies it to `req.body`, `req.query`, or `req.params`. Validation failures produce a 400 response with structured error details. The Zod schema is the authoritative definition of what the backend accepts; the node type registry's `configSchema` is presentation metadata only.

---

## JWT Lifecycle

### Login

`POST /api/v1/auth/login` returns:

- **Access token**: short-lived JWT signed with `JWT_ACCESS_SECRET`, default expiry 15 minutes. Returned in the response body as `accessToken`. The frontend stores this in memory (Zustand `authStore`) — never in `localStorage`.
- **Refresh token**: long-lived JWT signed with `JWT_REFRESH_SECRET`, default expiry 7 days. Set as an httpOnly, SameSite=Strict cookie. Not accessible to JavaScript.

### Token Refresh

`POST /api/v1/auth/refresh` reads the refresh cookie, verifies it, and issues a new access token. Called automatically by the frontend API client when a 401 is received.

### `req.user` Shape

After `requireAuth` runs successfully:

```js
req.user = {
  id:       number,   // users.id
  email:    string,
  role:     'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER',
  tenantId: number,   // always from JWT — never trust req.body
}
```

The `tenantId` is embedded in the JWT at login time from `users.tenant_id`. Every row INSERT that needs tenant scoping must use `req.user.tenantId`.

---

## Socket.IO Authentication Flow

Socket.IO is mounted at path `/socket.io` and uses the same CORS origins as the REST API. Authentication is event-driven, not connection-level:

1. Client connects (unauthenticated).
2. Server immediately emits `esl.status` with current ESL connection state so the UI header shows the correct indicator before auth.
3. Client sends `authenticate { token: <accessToken> }`.
4. Server calls `jwt.verify(token, config.jwt.accessSecret)`.
5. On success:
   - `socket.user` is set to the decoded payload.
   - Socket joins rooms: `user:<userId>`, `role:<role>`, `tenant:<tenantId>`.
   - Server emits `authenticated { userId, role }`.
   - Server re-emits `esl.status` so the authenticated client gets the full ESL state.
6. On failure: server emits `auth.error: 'Invalid token'`.

`emitInternal(event, data, tenantId)` in `socketService.js` is used by all internal controllers to push live updates. When `tenantId` is provided it emits to `tenant:<tenantId>` only. System-wide events (ESL status) omit `tenantId` and broadcast to all sockets.

---

## ESL Connection

The ESL connection is managed by `eslService.js` using the `modesl` npm package.

### Connection Parameters

| Env Var | Default | Purpose |
|---|---|---|
| `ESL_HOST` | `127.0.0.1` | FreeSWITCH ESL host |
| `ESL_PORT` | `8021` | ESL TCP port |
| `ESL_PASSWORD` | `ClueCon` | ESL password |
| `ESL_RECONNECT_MS` | `3000` | Base reconnect delay |

### Reconnect Strategy

On disconnect or error, `scheduleReconnect()` uses exponential backoff:

```
delay = min(ESL_RECONNECT_MS × 2^(attempts−1), 30000)
```

Attempt count is tracked in `reconnectCount`. Once connected, `reconnectCount` resets to 0.

### Event Subscriptions

On connect, the ESL service subscribes to exactly these event types:

```js
conn.subscribe([
  'CUSTOM conference::maintenance',
  'CHANNEL_HANGUP',
  'CHANNEL_ANSWER',
  'CHANNEL_CREATE',
  'CHANNEL_BRIDGE',
  'DTMF',
  'RECORD_STOP',
]);
```

All events are dispatched to `handleEvent(evt)`. Internal subscribers (e.g., the campaign engine) receive events via `eslEvents` (a Node.js `EventEmitter`), which avoids circular imports between `eslService.js` and `campaignEngine.js`.

### Post-Connect Seed

800 ms after connecting, `seedConferenceRegistry()` is called to populate the in-memory conference registry from FreeSWITCH's live state. This recovers the registry after a backend restart mid-call when conference-create and add-member events have already fired.

---

## Background Jobs

All three intervals are started by `startBackgroundJobs()`, called once from `server.js`. They do not start at module load time (which would cause them to fire in test files and CLI scripts that import from `eslService.js`).

| Interval | Job | Behaviour |
|---|---|---|
| 30 seconds | Heartbeat + registry seed | Sends `bgapi status` to FreeSWITCH, updates `esl_connections.last_heartbeat_at`. Then calls `seedConferenceRegistry()` to correct any registry drift from missed events. Skipped entirely if ESL is not connected. |
| 60 seconds | Active incident reconciliation | Calls `reconcileAllActiveIncidents()`. For every ACTIVE `ers_incidents` row within 48 hours, checks live conference member count via `conference <room> count`. If count is 0, the incident is an orphan (conference already ended while ESL was disconnected) and is marked COMPLETED. Also expires QUEUED rows older than 2 hours. **Skipped if ESL is not connected** — otherwise every incident would be falsely completed the moment ESL disconnects. |
| 120 seconds | Recording directory scan | Imports `scanRecordingDirectory()` from `recordingController.js`. Heals recording rows whose `stop-recording` ESL event was missed (e.g., ESL disconnect during a call) and registers any file the `start-recording` event failed to insert. Idempotent. |

---

## Campaign Engine — Tick Loop

`campaignEngine.js` is a singleton service. `start()` runs a `setInterval` every 1 second. Each tick:

1. Attempts to acquire a PostgreSQL advisory lock (`pg_try_advisory_lock`) per active campaign.
2. Queries `campaign_deliveries` for pending contacts in the campaign.
3. Calls `originateCampaignCall()` in `eslService.js` for each contact within the configured concurrency limit.
4. Listens for `CHANNEL_ANSWER` and `CHANNEL_HANGUP` events via `eslEvents` to update delivery status.
5. Handles retryable hangup causes: `BUSY`, `USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED`, `NORMAL_CIRCUIT_CONGESTION`, `SWITCH_CONGESTION`.
6. Marks non-retryable causes as FAILED.
7. Releases the advisory lock at the end of the tick.

The `ENS_ORIGINATE_MODE` environment variable controls dial string construction:

- `user` (default, lab/extension): dials `user/<extension>` — FreeSWITCH resolves the registered SIP contact.
- `gateway` (production): dials `sofia/gateway/<gatewayName>/<number>` — routes through a configured SIP gateway.

---

## Conference Registry — In-Memory Map

`conferenceRegistry` in `eslService.js` is a module-level `Map<confName, ConferenceEntry>`. It is the authoritative real-time source for the monitoring API endpoint — no database query is needed for live conference state.

### `ConferenceEntry` Structure

```js
{
  name:           string,       // e.g. "ers_42_1720000000"
  createdAt:      ISO8601,
  locked:         boolean,
  recording:      boolean,      // true = recording currently active
  recordingPath:  string|null,  // absolute FS path of current/last recording
  recordingState: 'OFF'|'STARTING'|'ACTIVE'|'STOPPING'|'FAILED',
  recordingError: string|null,  // error message when state='FAILED'
  floorHolder:    string|null,  // member ID currently holding floor
  rate:           number|null,  // Hz — from xml_list header
  rawFlags:       string|null,  // raw pipe-delimited FS flags
  members:        Map<memberId, MemberRecord>,
}
```

### `MemberRecord` Structure

```js
{
  id:          string,    // FreeSWITCH member ID (numeric string)
  callerNum:   string,    // Caller-Caller-ID-Number from ESL
  callerName:  string,    // Caller-Caller-ID-Name from ESL
  displayName: string,    // callerName if human-readable, else callerNum
  extension:   string,
  role:        'moderator'|'participant',
  muted:       boolean,   // from xml_list <can_speak>false</can_speak>
  deaf:        boolean,   // from xml_list <can_hear>false</can_hear>
  moderator:   boolean,
  talking:     boolean,   // event-driven only (start-talking/stop-talking)
  floor:       boolean,
  canHear:     boolean,
  canSpeak:    boolean,
  volIn:       number,
  volOut:      number,
  energy:      number,
  joinedAt:    ISO8601|null,
  _uuid:       string,    // internal FreeSWITCH channel UUID — never sent to frontend
}
```

The `_uuid` field is kept internally for directed commands (kick by UUID) but is excluded from every serialised snapshot sent to the frontend via Socket.IO or REST.

### Authoritative State Source

Member muted/deaf/talking/floor state is split between two sources:

- **`xml_list`** (canonical for muted, deaf, floor, moderator, canSpeak, canHear): FreeSWITCH returns explicit boolean XML tags. Used by `seedConferenceRegistry()` and `syncConferenceFromXml()`. Called 600 ms after every add-member event and 300 ms after every conference control command.
- **ESL maintenance events** (canonical for talking): `start-talking` and `stop-talking` events are the only source for the `talking` field. `syncConferenceFromXml()` deliberately does NOT update `talking` to avoid overwriting event-driven state with a point-in-time snapshot that almost always shows `talking=false`.

---

## Error Handling

The centralised `errorHandler` middleware maps known conditions automatically:

| Condition | HTTP Status |
|---|---|
| PostgreSQL error `23505` (unique violation) | 409 Conflict |
| PostgreSQL error `23503` (foreign key violation) | 409 Conflict |
| Zod `ZodError` | 400 Bad Request (with structured field errors) |
| Any Error with `.statusCode` property | Uses that status code |
| Any other thrown Error | 500 Internal Server Error |

The `query()` function from `src/db/pool.js` annotates all PostgreSQL errors with `._sql` (the query string) and `._params` (the bound parameters) before re-throwing. The error handler logs these fields in development for immediate diagnosis.

---

## Database Patterns

### `query(sql, params)`

Imported from `backend/src/db/pool.js`. Wraps `pg.Pool.query()`. On error, annotates the thrown Error with:

```js
error._sql    = sql;
error._params = params;
```

These are logged by the error handler in non-production environments and are always present in the raw Error object for debugging.

### `withTransaction(async tq => { ... })`

Also from `pool.js`. Acquires a client from the pool, issues `BEGIN`, invokes the callback with a `tq` function that is a bound `client.query`, and commits or rolls back:

```js
await withTransaction(async (tq) => {
  const { rows: [incident] } = await tq(
    'INSERT INTO ers_incidents (...) VALUES ($1, ...) RETURNING *',
    [configId, ...]
  );
  await tq(
    'INSERT INTO ers_incident_responders (...) VALUES ($1, $2, ...)',
    [incident.id, ...]
  );
});
```

All multi-step writes that must be atomic use `withTransaction`. Never use `query()` for sequences that must either both succeed or both fail.

---

## Migration System

`backend/src/db/migrate.js` supports two modes detected automatically at startup:

### Fresh Database (no `tenants` table)

1. Applies `schema.sql` (equivalent of migrations 001–005).
2. Marks migrations `001` through `005` as applied in `schema_migrations`.
3. Runs migrations `006` through `011` in order.

### Existing Database

Skips `schema.sql`. Reads `schema_migrations` to find the highest applied migration number and runs only numbered migration files above that.

### Migration File Requirements

All migration files in `src/db/migrations/` must:

- Manage their own `BEGIN` and `COMMIT` (the runner does not wrap them).
- Be fully idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, etc.).
- Use a numeric prefix (e.g., `006_ivr_production.sql`, `011_recording_management.sql`).

After applying any migration, the runner records it with:

```sql
INSERT INTO schema_migrations (version) VALUES ('006') ON CONFLICT DO NOTHING;
```
