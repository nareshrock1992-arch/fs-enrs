# End-to-End Testing Guide

**Document:** 26-end-to-end-testing-guide.md  
**Product:** fs-enrs  
**Audience:** QA engineers, developers writing integration tests  
**Scope:** Test infrastructure, automated integration tests, manual end-to-end scenarios, coverage checklist

---

## Test Infrastructure

| Component | Technology |
|---|---|
| Test runner | Vitest (configured in `backend/package.json`) |
| HTTP assertions | supertest |
| Database | Real PostgreSQL — not mocked |
| ESL / FreeSWITCH | Mocked in integration tests; required only for full end-to-end scenarios |

**Design principle:** Integration tests run against real PostgreSQL to prevent mock/DB divergence. A prior incident masked broken migrations because mock DB behavior diverged from the actual schema. All schema-touching tests use live queries.

---

## Running Tests

```bash
cd backend

# Run all tests (single pass, CI mode)
npm test

# Run a single test file
npx vitest run src/__tests__/integration/ivr.test.js

# Interactive watch mode (development)
npm run test:watch
```

---

## Test File Structure

Each integration test file follows this lifecycle:

```
beforeAll:
  1. INSERT tenant row
  2. INSERT organization row
  3. INSERT test users (admin, supervisor, operator)
  4. POST /auth/login → capture access token

tests:
  - Use supertest to call API endpoints
  - Assert HTTP status, response body
  - Assert DB state via direct query() calls where needed

afterAll:
  DELETE created rows in reverse dependency order
  (children before parents, respecting FK constraints)
```

---

## Key Test Files

### `trackParticipant.test.js`

Regression test for the caller ID identity bug. Documents both the pre-fix behavior and the corrected behavior.

| Test | Purpose |
|---|---|
| BUG: callerNum-only lookup | Proves that resolving contact by `Caller-Caller-ID-Number` alone silently skips responder identification — documents the pre-fix failure mode |
| FIX: destNum-first lookup | Proves that `Caller-Destination-Number` (`destNum`) lookup correctly identifies the responder, writes participant and responder rows |
| Initiator handling | Proves that callerNum fallback correctly handles the initiator's inbound join without creating a duplicate responder row |
| Reports query | Proves end-state: `participant_count = 2`, `responder_count = 1`, `answered_count = 1` after correct processing |

### `ersRingAllPhase5.test.js`

Tests ERS ring-all production behavior:

| Test | Coverage |
|---|---|
| Zero-responder pre-check | `POST /ers/ring-all` with no assigned contacts returns `422 Unprocessable Entity` before ESL is touched |
| Deterministic room name | Response body includes the correct room name, matching the format `ers_<config_id>_p` |
| Overflow poll — room name | Poll endpoint uses the deterministic room name to check slot availability |
| Reconciliation sweep | Background sweep marks empty active incidents as `COMPLETED` when conference no longer exists |

### `phase1-regression.test.js`

Core platform regression suite covering the full CRUD surface:

| Area | Coverage |
|---|---|
| Authentication | Login, token refresh via httpOnly cookie, logout, expired token rejection |
| Organizations | Create, read, update, soft delete |
| Contacts | Create, read, update, soft delete, `extension_number` assignment |
| Responder groups | Create, assign members, remove members |
| ERS configurations | CRUD + tier group assignment |
| ENS configurations | CRUD + contact targeting |
| IVR flows | CRUD + validate + publish lifecycle |

### `internal-api.test.js`

Tests the Lua contract API (`/api/v1/internal/*`). Verifies `X-Internal-Key` auth and correct response shapes for each Lua-consumed endpoint:

| Endpoint | Test Coverage |
|---|---|
| `GET /internal/ivr/lookup?number=` | Returns flow graph for bound number; returns 404 for unbound |
| `GET /internal/ers/lookup?number=` | Returns full ERS config including bridge numbers, responder tiers, queue settings |
| `POST /internal/ers/ring-all` | Initiates ring-all; returns room name and slot info |
| `GET /internal/ens/lookup?number=` | Returns ENS config with `pin_required` flag (never raw PIN) |
| `POST /internal/ens/verify-pin` | Returns `verified: true/false`; does not expose correct PIN |

### `ivr.test.js`

Tests `ivrGraphValidator.js` validation logic:

| Scenario | Expected Result |
|---|---|
| Valid graph with all reachable nodes | `validate` passes |
| Node references non-existent next node | `422` — dangling node reference |
| Unreachable node (no path from entry) | `422` — unreachable node detected |
| Missing required config field on node | `422` — Zod validation failure |
| ERS node references config from different tenant | `422` — cross-tenant reference rejected |

---

## End-to-End Scenario Testing

The following scenarios require a running FreeSWITCH instance with registered SIP extensions. They are currently executed manually and documented here for future test automation.

---

### Scenario 1: Complete ERS Incident

**Prerequisites:** ERS configuration with 2 primary contacts (extensions `2001`, `2002`), emergency number `5911`. IVR flow with `ers_ring_all` node deployed and bound to `5911`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call `5911` from extension `5001` | Incident created; `GET /ers/incidents` shows `status: ACTIVE` |
| 2 | Wait for ring-all | `ers_incident_responders` has `INVITED` rows for `2001` and `2002` |
| 3 | Answer call on extension `2001` | `add-member` ESL event received; `trackParticipant` resolves contact by `destNum` |
| 4 | Assert participant recorded | `ers_incident_participants` has row for `2001`; `ers_incident_responders` for `2001` shows `status: JOINED` |
| 5 | Assert monitoring | `GET /ers/conference/ers_1_p/members` shows 2 members (`5001` + `2001`) |
| 6 | Hang up all parties | `conference-destroy` ESL event received |
| 7 | Assert incident complete | `GET /ers/incidents/:uuid` shows `status: COMPLETED` |
| 8 | Assert report | `GET /reports/ers/:uuid` shows `participant_count: 2`, `responder_count: 1`, `answered_count: 1` |

---

### Scenario 2: Complete ENS Campaign

**Prerequisites:** ENS configuration with 5 contacts, `destination_number: 5500`, `pin: 1234`. IVR flow chain: `gather → condition:ens_pin_valid → ens_blast_record → ens`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call `5500` | IVR answers; prompts for PIN |
| 2 | Enter `1234` | PIN verified; recording prompt plays |
| 3 | Record a 5-second message; press `#` | Recording saved; campaign created |
| 4 | Observe campaign status | `GET /campaigns/:id` transitions `queued → running` within 1 second |
| 5 | Observe destinations | `ens_campaign_destinations` shows 5 rows with `status: queued` |
| 6 | Answer outbound call on test extension | Destination status updates to `answered` |
| 7 | All calls complete | `GET /reports/ens/:uuid` shows `total_answered: 5` |
| 8 | Call `reply_clid` number | Callback authorized; recording plays back; `callback_count` incremented |

---

### Scenario 3: IVR DTMF Routing

**Prerequisites:** IVR flow: `play("welcome") → gather(variable=choice) → condition: choice=1 → ers_node; choice=2 → hangup`. Deployed and bound to number `5555`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call `5555` | Welcome audio plays |
| 2 | Press `1` | ERS node executes; conference bridge attempted |
| 3 | Call `5555` again | Welcome audio plays |
| 4 | Press `2` | Call hangs up cleanly |

---

### Scenario 4: ENS Callback Replay

**Prerequisites:** Completed ENS campaign (see Scenario 2). `reply_clid` configured on ENS configuration.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call `reply_clid` from a contact's registered number | `GET /ens/callbacks/authorize?reply_clid=&caller=` returns `authorized: true` |
| 2 | Listen to playback | Recording from completed campaign plays |
| 3 | Assert delivery record | `ens_notification_deliveries` entry for this contact updated to `status: REPLAYED` |

---

### Scenario 5: ERS Overflow Queue

**Prerequisites:** ERS configuration with `max_concurrent_conferences: 1` and `queue_enabled: true`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call emergency number | Incident created; slot `_p` occupied |
| 2 | Call emergency number again | Call queued; `GET /ers/queue` shows 1 queued entry |
| 3 | Complete first incident | Conference destroyed; slot freed |
| 4 | Poll queue | Queue poll returns `ready: true`; queued incident dequeued |

---

## Test Coverage Checklist

Use this checklist to verify test coverage before a release.

### Authentication and Authorization
- [ ] Login with valid credentials returns access token + sets httpOnly refresh cookie
- [ ] Token refresh via `POST /auth/refresh` issues new access token
- [ ] Logout invalidates refresh token
- [ ] Expired access token returns `401`
- [ ] Insufficient role returns `403`
- [ ] Missing `X-Internal-Key` on internal endpoints returns `401`
- [ ] Wrong `X-Internal-Key` returns `401`

### Contacts and Groups
- [ ] CRUD for individual contacts
- [ ] `extension_number` field persists correctly
- [ ] Bulk CSV contact import
- [ ] Group create, member assignment, member removal
- [ ] Soft delete does not hard-delete; re-query excludes deleted rows

### ERS Configuration
- [ ] CRUD for ERS configurations
- [ ] Tier group assignment (primary + secondary, groups + individual contacts)
- [ ] Configuration deactivation removes from lookup results

### ENS Configuration
- [ ] CRUD for ENS configurations
- [ ] PIN stored; lookup returns `pin_required` flag, not raw PIN
- [ ] Contact targeting persists and resolves at campaign time

### IVR Flows
- [ ] CRUD for IVR flows
- [ ] Validation rejects dangling references, unreachable nodes, missing fields
- [ ] Publish creates immutable version
- [ ] Deploy writes Lua and XML to correct paths
- [ ] Number binding updates `emergency_numbers` record
- [ ] Cross-tenant references rejected during validation

### ERS Ring-All
- [ ] Incident created on ring-all trigger
- [ ] Responder rows created with `INVITED` status
- [ ] `trackParticipant` resolves contact by `destNum` (not `callerNum`) for responder joins
- [ ] Responder row updated to `JOINED` on answer
- [ ] Initiator join does not create spurious responder row
- [ ] Incident status transitions to `COMPLETED` on conference destroy

### ERS Overflow
- [ ] Queuing when slots exhausted (queue_enabled=true)
- [ ] `GET /ers/queue` reflects queued incidents
- [ ] Canceling queued incident removes from queue
- [ ] Slot-free event triggers dequeue

### ERS Rejoin
- [ ] Rejoin lookup returns correct conference room name
- [ ] Responder can join active conference via rejoin number

### ENS Campaign
- [ ] Campaign created with correct destination count
- [ ] Engine tick originates calls within 1 second of campaign start
- [ ] Call answer updates destination status
- [ ] Call hangup with retryable cause schedules retry
- [ ] `max_attempts` reached → destination marked `failed`
- [ ] All destinations terminal → campaign marked `completed`

### ENS Callback
- [ ] Callback authorization by `reply_clid` + caller number
- [ ] Unauthorized caller returns `authorized: false`
- [ ] Replay updates delivery record status

### Recording
- [ ] Conference recording starts on `record_conferences: true`
- [ ] Recording file written to correct path
- [ ] `scanRecordingDirectory` heals missed stop-recording events (120-second scanner)
- [ ] Recording stream and download endpoints return correct file

### Monitoring
- [ ] Conference registry populated on `conference-create` ESL event
- [ ] Member added to registry on `add-member` ESL event
- [ ] Member removed from registry on `del-member` ESL event
- [ ] 30-second heartbeat reseeds registry from FreeSWITCH `xml_list`
- [ ] Socket.IO emits correct events to authenticated clients
- [ ] Force resync via `POST /monitoring/debug/conf-sync`

### Reports
- [ ] ERS incident detail: correct `participant_count`, `responder_count`, `answered_count`
- [ ] ENS broadcast detail: correct `total_sent`, `total_answered`, `total_failed`
- [ ] Report data consistent with `ers_incident_participants` and `ens_notification_deliveries` tables

### Deployment
- [ ] Audio file upload succeeds
- [ ] Audio deploy writes files to FreeSWITCH audio path
- [ ] IVR flow deploy writes Lua script and XML dialplan
- [ ] `reloadxml` issued over ESL after deploy
- [ ] Diagnostics endpoint reports correct path accessibility
