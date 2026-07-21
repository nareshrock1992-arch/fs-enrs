# Observability

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Purpose

Observability answers three questions in production:
1. **What happened?** — structured logs with enough context to reconstruct a call's lifecycle
2. **Is it happening now?** — real-time ESL event stream + Socket.IO dashboard push
3. **Did it fail?** — error handler captures context + stack; ESL events flow even during API errors

---

## Correlation IDs

Every call session has a `session_uuid` (platform UUID) set before the call is placed. This UUID is:

1. Stored in `communication_sessions.session_uuid` (Wave 3)
2. Set as FreeSWITCH channel variable `enrs_session_uuid`
3. Included in every log line related to the call
4. Included in Socket.IO events pushed to the monitoring UI
5. Returned to the business module as the call reference

Because `enrs_session_uuid` travels with the FreeSWITCH channel, ESL event handlers can always correlate an incoming `CHANNEL_HANGUP` to its platform session without a UUID lookup.

**Current state (pre-Wave 3):** Each module tracks its own call reference:
- ENS: `ens_campaign_deliveries.id`
- ERS: `ers_incident_responders.id`
- IVR: no session tracking

After Wave 3, all modules use `session_uuid` as the cross-module correlation key.

---

## Logging

### Current state

`console.log` and `console.error` throughout. No structured logging library.

### Target state (Wave 2)

Structured JSON logging via `pino` or equivalent:

```javascript
// Every log entry has:
{
  "time":         "2026-07-21T10:23:45.123Z",
  "level":        "info",
  "module":       "ENS",
  "sessionUuid":  "d4e5f6a7-...",
  "tenantId":     42,
  "event":        "campaign.call.originated",
  "dialString":   "sofia/gateway/uk-pstn/07123456789",
  "msg":          "Campaign call originated"
}
```

Sensitive fields excluded from logs:
- `password`, `pin`, `password_hash`
- Full phone numbers in non-debug log levels (masked: `+447123***789`)
- Recording file contents

### Log Levels

| Level | When to use |
|---|---|
| `error` | Unhandled exception, ESL disconnect, DB query failure |
| `warn` | Retried operation, unexpected-but-handled state, deprecated code path |
| `info` | Call originated, campaign started, incident opened, deployment completed |
| `debug` | Per-node IVR execution, per-digit DTMF events, ESL raw event dumps |

Production runs at `info`. Debug is toggle-able per tenant via feature flags.

---

## ESL Event Visibility

ESL events from FreeSWITCH flow to the Node.js backend in real time via the persistent TCP connection. The monitoring UI receives these via Socket.IO.

Current Socket.IO events emitted by internal controllers:

| Event name | Trigger | Data |
|---|---|---|
| `enrs::ens_campaign_started` | Campaign origination begins | `{ notificationId, total }` |
| `enrs::ens_delivery_update` | Each call status change | `{ deliveryId, status, contactName }` |
| `enrs::ers_incident_opened` | New ERS incident | `{ incidentId, configId, conferenceRoom }` |
| `enrs::ers_responder_update` | Responder connects or disconnects | `{ incidentId, responderId, status }` |
| `enrs::ers_participant_joined` | Participant joins conference | `{ incidentId, callerName, uuid }` |

After Wave 3, these events also include `sessionUuid` for cross-module correlation.

---

## Error Handling

### `asyncHandler` wrapper

All route handlers use `asyncHandler` to catch unhandled promise rejections:

```javascript
router.get('/path', asyncHandler(async (req, res) => {
  // Thrown errors go to errorHandler automatically
}));
```

### Error Handler (`src/middleware/errorHandler.js`)

Catches all errors and:
1. Logs `err._sql` and `err._params` if the error came from `query()` (DB error context)
2. Maps PG error codes to HTTP status codes (23505 → 409, 23503 → 409)
3. Maps Zod validation errors to HTTP 400 with field-level messages
4. Returns `{ error: message }` with appropriate status (never leaks stack traces in production)

### ESL Disconnection

When ESL disconnects, `eslService.js` emits `eslEventBus.emit('esl:disconnected')`. Campaign engine and ring service pause origination. ESL reconnect triggers `eslEventBus.emit('esl:connected')` and operations resume. No calls are placed during the disconnection window.

---

## Health Check _(Wave 2)_

A `/api/v1/health` endpoint is needed for deployment tooling and monitoring:

```json
{
  "status": "ok",            // "ok" | "degraded" | "down"
  "db": {
    "status": "ok",
    "latency_ms": 2
  },
  "esl": {
    "status": "ok",          // "ok" | "disconnected"
    "connected_since": "2026-07-21T08:00:00Z"
  },
  "campaign_engine": {
    "status": "running",     // "running" | "paused" | "stopped"
    "active_campaigns": 0
  }
}
```

Without this endpoint, an operations team cannot distinguish "application is running but ESL is down" from "application is healthy."

---

## Audit Trail

### `audit_logs` table

Records UI-triggered admin actions with before/after state:

```javascript
await query(`
  INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, before_state, after_state, ip_address)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`, [tenantId, userId, 'ers_config.update', 'ers_configurations', configId, beforeState, afterState, req.ip]);
```

**What goes in audit_logs:** Configuration changes, user management actions, permission changes, deployment actions.

**What does NOT go in audit_logs:** Call events (those go in `ers_incident_events`, `ens_campaign_deliveries`, `communication_sessions`). Using `audit_logs` as a call event store was identified as an anti-pattern in the architecture review.

### `ers_incident_events` table

Records call-level events within an ERS incident (mute, unmute, floor change, recording start/stop). This is the correct place for real-time conference event audit.

---

## Tracing _(Future)_

When multi-site or multi-provider deployments are live (Wave 6+), distributed tracing with OpenTelemetry will be needed. The `session_uuid` established in Wave 1 becomes the trace ID. The span model:

```
Trace: session_uuid
  Span: communicationEngine.request()
    Span: outboundRouter.placeCall()
      Span: dialResolver.resolveDialString()
      Span: freeswitchProvider.placeCall()
    Span: communicationEngine.onSessionAnswer()
    Span: communicationEngine.onSessionHangup()
```

This is not in scope for any current wave. It is noted here so the `session_uuid` design decision is understood as forward-compatible.

---

## Monitoring Dashboard

The current monitoring UI (`/monitoring`) uses Socket.IO to display real-time:
- Active ERS incidents and participant count
- Active ENS campaigns and delivery progress
- ESL connection status

This is correct architecture. The monitoring UI reads live events — it does not poll the API. Future additions (IVR call volume, gateway registration status, campaign engine queue depth) should follow the same pattern: emit a Socket.IO event when state changes, UI subscribes and updates.
