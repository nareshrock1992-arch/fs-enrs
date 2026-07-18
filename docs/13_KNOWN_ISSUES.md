# 13 — Known Issues, Bugs, and Technical Debt

This document lists confirmed bugs, architectural gaps, and deliberate deferments. Items marked **FIXED** have been resolved in recent sessions and documented here for reference.

---

## Resolved Issues

### FIXED — Conference Named `3010-192.168.1.133` Instead of `3010`

**Root cause:** The `conference_profile` DB column on `ers_configurations` stored a raw SIP domain IP address (e.g. `192.168.1.133`). Lua used this value verbatim in `conference(3010@192.168.1.133)`. FreeSWITCH rendered the conference as `3010-192.168.1.133` instead of `3010`.

**Fix:** `getConferenceProfile()` in `conferenceManager.js` sanitizes the profile value — rejects anything containing `.` or `:` (SIP IPs / FQDNs), falls back to `'default'`. Applied to both the `/internal/ers/lookup` API response (Lua path) and `ersRingService.originateLeg()` (backend ring path).

**Files changed:** `conferenceManager.js`, `ersInternalController.js`, `ersRingService.js`

---

### FIXED — Hardcoded `@default` in Backend Ring-All

**Root cause:** `ersRingService.originateLeg()` used `&conference(${room}@default)` regardless of ERS configuration.

**Fix:** `conferenceProfile` threaded from ERS config → `startRingAll()` → `originateLeg()`.

---

## Active Known Issues

### ISSUE-001 — `getConferenceString()` Dead Export

- **File:** `backend/src/services/conferenceManager.js:76`
- **Description:** `getConferenceString()` is exported but never called. Dead code.
- **Severity:** Low (no runtime impact)
- **Action:** Remove the export.

---

### ISSUE-002 — Deprecated `GET /contacts/by-pin` Still Live

- **File:** `backend/src/controllers/contactController.js:154`
- **Description:** The route is marked sunset `2026-08-31` but is still live. It has no auth guard. It queries tables (`ens_contacts`) that are not populated by any current workflow.
- **Severity:** Low-Medium (returns empty result, but unauthenticated route)
- **Action:** Remove after 2026-08-31.

---

### ISSUE-003 — Two Media Upload Routes Coexist

- **Files:** `backend/src/routes/v1/media.js`, `backend/src/controllers/deploymentController.js`
- **Description:** `POST /api/v1/media/upload` stages a file but does NOT copy it to the FreeSWITCH sounds directory. `POST /api/v1/deployment/audio/upload` does the full staging + deploy. The IVR builder's legacy file picker uses the partial route. Files uploaded via `/media/upload` cannot be played by FreeSWITCH without a separate deploy step.
- **Severity:** Medium (silent footgun — files appear uploaded but won't play)
- **Action:** Redirect IVR file picker to `/deployment/audio/upload`; remove `/media/upload`.

---

### ISSUE-004 — Legacy ERS Responder Fallback in Production Path

- **File:** `backend/src/controllers/internal/ersInternalController.js:89–115`
- **Description:** If `ers_tier_contacts` + `ers_tier_groups` return no responders for a configuration, the controller falls back to querying old `ers_responders` and `ers_responder_group_members` tables (Phase 6 schema, superseded by migration 009) and even older FK columns. These tables should be empty on any post-migration-009 install.
- **Severity:** Low (defensive fallback, but dead code path adds query overhead and confusion)
- **Action:** Confirm production has no pre-009 data; remove fallback.

---

### ISSUE-005 — Orphaned DB Tables

Tables in the schema with zero application code references:

| Table | Status |
|---|---|
| `audio_library` | Replaced by `media_files` |
| `notification_templates` | Never implemented |
| `ens_campaign_deliveries` | Replaced by `ens_notification_deliveries` |
| `ens_contacts` / `ens_groups` / `ens_group_members` | Replaced by `ens_configuration_contacts/groups` |
| `ers_responders` / `ers_responder_group_members` | Replaced by `ers_tier_contacts/groups` |

- **Severity:** Low (no runtime impact, but wastes schema space and confuses new developers)
- **Action:** Plan migration 028 to drop these tables after confirming empty in production.

---

### ISSUE-006 — Conference Auto-Recording: `MODERATOR_JOIN` Trigger Not Implemented

- **File:** `backend/src/services/conferenceManager.js`
- **Description:** `recording_trigger = 'MODERATOR_JOIN'` is accepted by the Zod schema and stored in the DB. The `conferenceManager.js` `maybeAutoRecord()` function only handles `CONFERENCE_CREATED` and `FIRST_PARTICIPANT`. The `MODERATOR_JOIN` case is a no-op.
- **Severity:** Low (feature deferred, but no error is thrown — recording silently never starts)
- **Action:** Implement by identifying the moderator member in the ESL `add-member` event (check member's `Member-Type` or a custom channel variable set during originate).

---

### ISSUE-007 — Advanced Conference Behaviour Fields: Stored, Not Enforced

- **File:** `backend/src/db/migrations/027_ers_conference_config.sql`
- **Description:** Migration 027 added `max_participants`, `conference_lock`, `auto_destroy`, `allow_external`, `allow_duplicate_responders`, `moderator_required`, `bridge_timeout_sec` to `ers_configurations`. These values are saved via the UI but **not yet enforced** anywhere in the conference flow. The `max_participants` limit is not checked during `ring-all`; `moderator_required` does not gate the conference.
- **Severity:** Medium (operators may set values expecting behaviour that does not yet exist)
- **Action:** Enforce in `ersInternalController.js` and `ersRingService.js` in a future phase.

---

### ISSUE-008 — Campaign Engine Does Not Emit `CHANNEL_ANSWER` for Call Handled Entirely by Lua

- **Description:** When the ENS outbound call is answered and `blast_call.lua` runs, the Lua script calls `POST /internal/ens/campaign/start` — but the delivery update for the individual destination (`PATCH /internal/ens/notifications/:uuid/delivery`) must be called separately (by the Lua script or Lua callback). If Lua does not call back, the destination stays in `CALLING` status indefinitely.
- **Severity:** Medium (can cause stalled campaigns on Lua error or crash)
- **Action:** Add a safety timeout in the campaign engine: destinations in `CALLING` status for >120s should be marked `FAILED` with cause `LUA_TIMEOUT`.

---

### ISSUE-009 — ESL Reconnect Does Not Replay Missed Events

- **File:** `backend/src/services/eslService.js`
- **Description:** On ESL reconnect, the conference registry is rebuilt via `xml_list`. However, any `CHANNEL_ANSWER` or `CHANNEL_HANGUP` events that fired while ESL was disconnected are permanently lost. Campaign destinations for calls that completed during the disconnect stay stuck in `CALLING`.
- **Severity:** Low-Medium (short disconnects are rare; PM2 restarts the ESL connection quickly)
- **Action:** After reconnect, query `ens_campaign_destinations WHERE status='CALLING' AND last_attempted_at < NOW()-120s` and mark them failed.

---

### ISSUE-010 — Socket.IO Has No Room-Based Tenant Isolation

- **File:** `backend/src/services/socketService.js`
- **Description:** `emitInternal()` broadcasts all events to all authenticated Socket.IO connections regardless of tenant. In a multi-tenant deployment, tenants can see each other's incident events if they happen to be connected at the same time.
- **Severity:** High in multi-tenant SaaS context; Low in single-tenant or dedicated deployments
- **Action:** Put each connection in a tenant-scoped Socket.IO room on connect (`socket.join(tenantId)`); replace `io.emit()` with `io.to(tenantId).emit()` in `emitInternal`.

---

### ISSUE-011 — IVR Deployment Writes Files as Node.js Process User

- **Description:** `deploymentEngine.js` writes Lua scripts and XML dialplan files directly to FreeSWITCH directories. This requires the Node.js process to have write access to `/etc/freeswitch/dialplan/` and `/usr/share/freeswitch/scripts/`. In production this is typically run as root or `freeswitch` user, which is a privilege escalation risk.
- **Severity:** Medium (acceptable in on-premise deployments, unacceptable in hardened environments)
- **Action:** Consider a file drop + SFTP handoff, or a dedicated deployment agent running as `freeswitch` user.

---

## Deferred Phase 4 Features

These were scoped in the project design but not yet implemented:

| Feature | Config field | Status |
|---|---|---|
| Maximum participants enforcement | `max_participants` | Stored, not enforced |
| Conference auto-lock | `conference_lock` | Stored, not enforced |
| Auto-destroy empty conference | `auto_destroy` | Stored, not enforced |
| Restrict external participants | `allow_external` | Stored, not enforced |
| Block duplicate responders | `allow_duplicate_responders` | Stored, not enforced |
| Moderator-required gate | `moderator_required` | Stored, not enforced |
| Bridge session timeout | `bridge_timeout_sec` | Stored, not enforced |
| `MODERATOR_JOIN` recording trigger | `recording_trigger` | Partially implemented |
