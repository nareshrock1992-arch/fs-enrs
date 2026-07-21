# Routing Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Principle

> Business modules never construct dial strings. Business modules never select gateways. Business modules never perform routing decisions. Only the routing layer performs routing.

---

## Routing Layers

```
CommunicationRequest (business intent)
           ↓
  Destination Classifier          — What type of destination is this?
           ↓
  Number Normalizer               — What format does the carrier expect?
           ↓
  Routing Policy Engine (Wave 5)  — Which routing rule applies?
           ↓
  dialResolver.js                 — Which gateway serves this destination?
           ↓
  Outbound Router                 — Build the provider-agnostic CallInstruction
           ↓
  Provider Layer                  — Translate to protocol-specific execution
```

---

## Destination Classification

`destinationClassifier.js` is a pure function (one optional DB lookup for contact resolution).

### DestinationType Enum

```javascript
const DestinationType = {
  INTERNAL_EXTENSION:   'internal_extension',   // FreeSWITCH registered user
  INTERNAL_SIP_USER:    'internal_sip_user',    // sip:user@local-domain
  EXTERNAL_MOBILE:      'external_mobile',      // PSTN mobile (national/E.164)
  EXTERNAL_LANDLINE:    'external_landline',    // PSTN landline
  EXTERNAL_SIP_URI:     'external_sip_uri',     // sip:user@external-domain
  GATEWAY_ROUTE:        'gateway_route',        // explicit gateway override
  EMERGENCY_NUMBER:     'emergency_number',     // 999/112/911 — high priority, logged
  CONFERENCE:           'conference',           // &conference() action only
  WEBRTC_PEER:          'webrtc_peer',          // future WebRTC client
};
```

### Classification → Routing Strategy

| DestinationType | Routing Strategy |
|---|---|
| `INTERNAL_EXTENSION` | `user/<extension>` — FreeSWITCH user directory |
| `INTERNAL_SIP_USER` | `sofia/internal/<uri>` — local SIP domain |
| `EXTERNAL_MOBILE` | Default outbound gateway or explicit override |
| `EXTERNAL_LANDLINE` | Default outbound gateway or explicit override |
| `EXTERNAL_SIP_URI` | `sofia/external/<uri>` |
| `GATEWAY_ROUTE` | Explicit gateway + formatted number |
| `EMERGENCY_NUMBER` | High-priority gateway + audit log + alert |
| `CONFERENCE` | No dial string — `&conference()` action only |
| `WEBRTC_PEER` | Future: WebRTC signaling |

---

## Gateway Resolution — `dialResolver.js`

The single function that translates routing intent into a FreeSWITCH dial string. **This file's contract is frozen.**

### Resolution Priority Order

```
1. explicit gatewayId (FK lookup in sip_gateways)          — highest priority
2. explicit gatewayName (name lookup, raw fallback if not found)
3. contact's own gateway_id (emergency_contacts.gateway_id) — per-contact override
4. tenant's is_default_outbound gateway                    — tenant default
5. no gateway → user/<extension or mobile>                 — internal FS user (lowest)
```

Returns: `{ dialString, mode: 'internal' | 'gateway', gateway: object | null }`

### Why this order matters

The priority order allows fine-grained control without complexity:
- A responder with an Avaya extension gets routed through the Avaya gateway (contact override)
- A tenant with one PSTN trunk has it set as default outbound (tenant default)
- A specific ENS config can override the default by providing `gatewayId` explicitly
- Internal lab testing uses no gateway at all (falls through to `user/`)

---

## Number Normalization — `numberNormalizer.js`

Normalizes a raw number to the format the selected carrier expects.

```javascript
normalizeNumber(rawNumber, context) → normalizedNumber
// context: { tenantId, gateway: { e164_normalize, prefix_add, prefix_strip } }
```

**Current behavior (Wave 1):** Passthrough — returns the number unchanged. The function exists as an activation hook.

**Wave 3 behavior:** Reads gateway normalization config:
- `e164_normalize: true` → convert national format to E.164 (`07123` → `+447123`)
- `prefix_strip: '0'` → strip leading zero
- `prefix_add: '0044'` → prepend international prefix

---

## Outbound Router — `outboundRouter.js`

The central assembler. Calls the classifier, normalizer, and resolver, then assembles the CallInstruction.

```javascript
async function placeCall(request) {
  // 1. Classify destination
  const { type, normalizedNumber } = await classify(request.destination, context);

  // 2. Resolve gateway
  const { dialString, gateway } = await resolveDialString({
    tenantId:     request.tenantId,
    contactId:    request.destination.contactId,
    mobileNumber: normalizedNumber,
    gatewayId:    request.destination.gatewayId,
    gatewayName:  request.destination.gatewayName,
  });

  // 3. Select caller ID (gateway override > request > default)
  const callerIdNumber = gateway?.outbound_clid_override  // carrier requirement
    || request.callerIdNumber                              // business module choice
    || normalizedNumber;                                   // fallback

  // 4. Assemble channel variables (ONLY place where channel vars are constructed)
  const vars = {
    origination_caller_id_number: callerIdNumber,
    origination_caller_id_name:   sanitizeVarValue(request.callerIdName),
    effective_caller_id_number:   callerIdNumber,
    effective_caller_id_name:     sanitizeVarValue(request.callerIdName),
    ignore_early_media:           'true',
    originate_timeout:            String(request.timeoutSeconds ?? 30),
    enrs_session_uuid:            request.sessionUuid,    // platform correlation key
    ...request.extraVars,
  };

  // 5. Build app string
  const app = buildApp(request.action, request.actionTarget, request.conferenceProfile);

  // 6. Select provider and execute
  const provider = getProvider(gateway?.provider ?? 'freeswitch');
  return provider.placeCall({ sessionUuid, dialString, vars, app, async: request.async });
}
```

### `sanitizeVarValue()`

Escapes characters that break the FreeSWITCH `{k=v,k=v}` variable block:

```javascript
function sanitizeVarValue(val) {
  return String(val ?? '').replace(/[{}=,]/g, '_');
}
```

This function must exist in one place only — in `outboundRouter.js`. Any previous caller that stripped only single-quotes from caller ID names was incomplete.

---

## Routing Policies — `gateway_routes` (Wave 5)

Allows per-tenant routing rules without code changes.

```sql
gateway_routes:
  id              SERIAL PRIMARY KEY
  tenant_id       INT NOT NULL REFERENCES tenants(id)
  gateway_id      INT NOT NULL REFERENCES sip_gateways(id)
  dest_type       VARCHAR(32)              -- DestinationType filter (NULL = any)
  number_pattern  VARCHAR(64)              -- regex on normalized number (NULL = any)
  priority        INT DEFAULT 10           -- lower = preferred
  cost_per_min    NUMERIC(10,6)            -- for least-cost routing (future)
  time_start      TIME                     -- time-of-day restriction
  time_end        TIME
  is_active       BOOLEAN DEFAULT true
```

**When no `gateway_routes` rows exist for a tenant:** behavior is identical to Wave 1 — `dialResolver.js` uses the `is_default_outbound` fallback. Wave 5 is opt-in per tenant.

---

## Gateway Failover (Wave 5)

The `sip_gateways.priority` column (added Wave 1) enables failover:

```javascript
// Future: routingPolicyEngine selects gateways ordered by priority
const candidates = await query(`
  SELECT * FROM sip_gateways
  WHERE tenant_id = $1 AND is_active = true
  ORDER BY priority ASC
`, [tenantId]);

// Outbound Router tries each candidate in order
for (const gateway of candidates) {
  try {
    return await provider.placeCall({ ...instruction, gateway });
  } catch (err) {
    if (err.cause === 'NO_ROUTE_DESTINATION') continue;  // try next
    throw err;  // other errors are terminal
  }
}
```

---

## What Never Changes in Routing

- `dialResolver.js` public contract — priority order is frozen
- `INTERNAL_EXTENSION` always routes to `user/<extension>` in FreeSWITCH
- Per-contact `gateway_id` override in `emergency_contacts` — this is the finest granularity available
- Tenant `is_default_outbound` as the final fallback before `user/`
