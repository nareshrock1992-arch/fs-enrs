# Communication Engine Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21 · Implementation: Wave 3

---

## Purpose

The Communication Engine is the single authoritative entry point for all outbound communication on the platform. Business modules (ENS, ERS, IVR, Contact Center) submit a `CommunicationRequest` describing *what* they need. The Engine decides *how* to execute it, tracks the lifecycle in a `CommunicationSession`, and returns standard status updates.

**Before Wave 3:** ENS calls Outbound Router directly. ERS calls Outbound Router directly. Sessions are tracked per-module.

**After Wave 3:** All modules call the Engine. Sessions are tracked centrally.

---

## CommunicationRequest

The contract between a business module and the Engine. Contains zero provider-specific concepts.

```javascript
const CommunicationRequest = {
  // Tenant context
  tenantId:          number,      // required — from JWT

  // Module context (for Communication Session linkage)
  module:            'ENS' | 'ERS' | 'IVR' | 'CC' | 'SYSTEM',
  moduleRefTable:    string,      // 'ens_campaigns', 'ers_incident_responders', etc.
  moduleRefId:       number,      // PK in that table

  // Destination (exactly one)
  contactId:         number,      // look up from emergency_contacts
  extension:         string,      // explicit internal extension
  mobileNumber:      string,      // explicit external number
  sipUri:            string,      // explicit SIP URI

  // Routing hints (optional — override automatic gateway selection)
  gatewayId:         number,      // explicit gateway FK
  gatewayName:       string,      // legacy string name (backward compat)

  // Caller identity
  callerIdNumber:    string,
  callerIdName:      string,

  // Call action
  action:            'playback' | 'conference' | 'park' | 'transfer',
  playbackFile:      string,      // absolute path (action='playback')
  conferenceRoom:    string,      // room name (action='conference')
  conferenceProfile: string,      // FS profile (action='conference')
  transferTarget:    string,      // destination (action='transfer')

  // Communication channel
  channel:           'voice' | 'sms' | 'email' | 'push',  // default: 'voice'

  // Timing
  timeoutSeconds:    number,      // default 30

  // Flags
  async:             boolean,     // non-blocking (default: true)
  priority:          'normal' | 'high' | 'emergency',  // default: 'normal'

  // Extra channel vars (escape hatch — rare)
  extraVars:         Record<string, string>,
};
```

---

## Communication Session

Every `CommunicationRequest` creates one row in `communication_sessions`.

```sql
communication_sessions:
  id                    BIGSERIAL PRIMARY KEY
  session_uuid          UUID UNIQUE                 -- platform correlation key
  tenant_id             INT NOT NULL
  module                VARCHAR(32) NOT NULL        -- ENS | ERS | IVR | CC | SYSTEM
  module_ref_table      VARCHAR(64)                 -- 'ens_campaigns', etc.
  module_ref_id         BIGINT
  parent_session_id     BIGINT REFERENCES ...       -- retry chain tracing
  channel               VARCHAR(16) DEFAULT 'voice' -- voice | sms | email | push
  destination_type      VARCHAR(32)                 -- DestinationType from classifier
  destination_raw       VARCHAR(128)                -- as submitted
  destination_normalized VARCHAR(128)              -- after normalization
  provider              VARCHAR(32)                 -- freeswitch | twilio | etc.
  gateway_id            INT REFERENCES sip_gateways(id)
  gateway_name          VARCHAR(128)
  dial_string           TEXT                        -- audit: actual string sent
  caller_id_number      VARCHAR(32)
  caller_id_name        VARCHAR(128)
  action                VARCHAR(32)                 -- playback | conference | etc.
  action_target         TEXT
  provider_session_id   VARCHAR(128)               -- FS UUID, Twilio CallSid, etc.
  status                VARCHAR(32) DEFAULT 'PENDING'
  created_at            TIMESTAMPTZ DEFAULT now()
  originated_at         TIMESTAMPTZ
  answered_at           TIMESTAMPTZ
  ended_at              TIMESTAMPTZ
  duration_seconds      INT GENERATED ALWAYS AS (...)
  disconnect_cause      VARCHAR(64)                 -- standard code (not FS-specific)
  failure_reason        TEXT
  deleted_at            TIMESTAMPTZ
```

---

## Session Lifecycle

```
PENDING       — Request accepted, not yet sent to provider
ORIGINATING   — Provider accepted the instruction
RINGING       — Remote party is ringing
ANSWERED      — Call answered
COMPLETED     — Call ended normally
NO_ANSWER     — Timed out, not answered
BUSY          — Remote party busy
FAILED        — Provider error
CANCELLED     — Cancelled by business module before answered
```

---

## Standard Disconnect Codes

The Engine translates provider-specific codes to a standard vocabulary. Business modules only ever see standard codes.

| Standard code | FreeSWITCH causes | Twilio status |
|---|---|---|
| `NO_ANSWER` | `NO_ANSWER`, `USER_BUSY` (sometimes) | `no-answer` |
| `BUSY` | `USER_BUSY`, `NORMAL_BUSY` | `busy` |
| `REJECTED` | `CALL_REJECTED`, `CALL_REFUSED` | `failed` |
| `CONGESTION` | `NORMAL_CIRCUIT_CONGESTION`, `SWITCH_CONGESTION` | — |
| `FAILED` | `NO_ROUTE_DESTINATION`, `NETWORK_OUT_OF_ORDER` | `failed` |
| `NORMAL` | `NORMAL_CLEARING` | `completed` |
| `CANCELLED` | `ORIGINATOR_CANCEL` | `canceled` |

---

## Engine Public API

```javascript
// Place an outbound communication
communicationEngine.request(CommunicationRequest): Promise<string>   // returns sessionUuid

// Check session status
communicationEngine.getSession(sessionUuid): Promise<SessionStatus>

// Cancel an in-progress session
communicationEngine.cancel(sessionUuid): Promise<void>

// Subscribe to status updates (all sessions)
communicationEngine.on('session:status', ({
  sessionUuid, status, module, moduleRefTable, moduleRefId, disconnectCause
}) => void)
```

---

## Retry Model

Retry policy is owned by each business module, not by the Engine.

- **ENS** — campaign engine retries based on standard disconnect codes: `NO_ANSWER`, `BUSY`, `REJECTED`, `CONGESTION` trigger retry. `NORMAL`, `FAILED` do not.
- **ERS** — ring-all re-rings the same tier after `LEG_TIMEOUT_S + 3s` if no responder has answered. Each re-ring wave creates new Communication Sessions with `parent_session_id` pointing to wave 1.
- **IVR** — no retry (single call execution).

The Engine records retry chains via `parent_session_id`. A report can query `WHERE parent_session_id = X` to find all retry attempts for a given original call.

---

## Scheduling _(Wave 5+)_

A Scheduler service creates `CommunicationRequest` objects at a configured time and submits them to the Engine. The Engine is unaware of the source (real-time trigger vs. scheduled). The Scheduler owns the schedule; the Engine owns the execution.

---

## Priority Queuing _(Future)_

`CommunicationRequest.priority` values:
- `'emergency'` — Set automatically by Destination Classifier when `DestinationType = EMERGENCY_NUMBER`. Bypasses any rate limiting. Logs a high-priority audit entry.
- `'high'` — Used for ERS ring-all calls. Higher position in any internal queue.
- `'normal'` — Default. ENS campaign calls.

Priority queuing enforcement is a Wave 5+ feature. The field is provisioned now.

---

## Rate Limiting

Gateway-level rate limiting is enforced at the Outbound Router using `sip_gateways.calls_per_second`. The Engine submits to the Router which throttles as needed. Business modules are never aware of rate limiting — they submit requests and the Engine handles back-pressure.

---

## Cancellation Flow

```
Business module calls: communicationEngine.cancel(sessionUuid)
                          ↓
Engine reads session.provider + session.provider_session_id
                          ↓
Engine calls: provider.hangup(providerSessionId)
                          ↓
Provider issues: FS uuid_kill or API hangup
                          ↓
ESL CHANNEL_HANGUP / webhook fires
                          ↓
Engine updates session.status = 'CANCELLED'
                          ↓
Engine emits: 'session:status' event with status='CANCELLED'
                          ↓
Business module updates own records
```
