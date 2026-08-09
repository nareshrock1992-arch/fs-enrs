# FS-ENRS — ERS External PBX Implementation Plan

**Date:** 2026-08-09  
**Status:** AWAITING APPROVAL — no implementation has occurred  
**Prerequisite:** `FS-ENRS-ERS-EXTERNAL-PBX-INVESTIGATION.md` (source-verified)

---

## Current Architecture Summary

### Two ERS responder-calling paths exist

**Path 1 — Direct ERS** (`ers_conference_bridge.lua`):  
Used when FreeSWITCH dialplan routes directly to an ERS number without an IVR flow. **This is the lab and common production path.** It calls responders via `invite_responder()` directly from Lua using `freeswitch.bgapi()`. It has three bugs: hardcoded `"ERS-RESP"` caller ID, no caller name, and hardcoded `"sofia/gateway/primary"` fallback.

**Path 2 — IVR Ring-All** (`ers_ring_all` node):  
Used when an IVR flow contains an `ers_ring_all` node. Calls `POST /internal/ers/ring-all` → `startRingAll()` in `ersRingService.js`. Uses `resolveDialString()` (gateway-agnostic) and `lookupCallerIdentity()` (real caller identity). **Already correct for external PBX.** No changes needed for caller ID or gateway routing.

### Key gap

`ers_configurations` has no gateway column. Lua's `cfg.sip_gateway` is always nil because that column belongs to `ens_configurations`, not `ers_configurations`. The fallback `"sofia/gateway/primary"` is hardcoded in Lua.

---

## Comparison: ENS vs ERS (Current)

| Capability | ENS | ERS Direct Path | ERS IVR Path |
|---|---|---|---|
| Config-level gateway | `sip_gateway` + `gateway_override` ✓ | **MISSING** ✗ | **MISSING** (per-contact only) |
| Per-contact gateway | `emergency_contacts.gateway_id` ✓ | Not accessible (Lua has numbers only) | ✓ via `resolveDialString()` |
| External PBX dial string | `sofia/gateway/<n>/<num>` ✓ | Hardcoded `sofia/gateway/primary` ✗ | ✓ |
| Caller ID number | Blast CLID (by design) | Hardcoded `"ERS-RESP"` ✗ | Real caller ✓ |
| Caller ID name | `"Emergency"` (by design) | Not set ✗ | Real name ✓ |
| Min digit validation | `.min(7)` ✗ | `.min(7)` ✗ | `.min(7)` ✗ |

---

## Phased Implementation Plan

### Phase A — Database Migration (do first)

**Migration number:** 042  
**File:** `backend/src/db/migrations/042_ers_gateway.sql`

```sql
BEGIN;

-- Add config-level SIP gateway to ERS configurations.
-- Priority: emergency_contacts.gateway_id (per-contact, highest)
--           → ers_configurations.sip_gateway_id (config default, NEW)
--           → tenant's is_default_outbound gateway
--           → null → user/<ext> (internal)
--
-- ON DELETE SET NULL: removing a gateway leaves existing ERS configs
-- functional (falls through to tenant default or internal routing).
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS sip_gateway_id INT REFERENCES sip_gateways(id) ON DELETE SET NULL;

INSERT INTO schema_migrations (version) VALUES ('042_ers_gateway.sql')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
```

**Files to modify:**
- `backend/src/db/migrations/042_ers_gateway.sql` (NEW)

**Files NOT to modify:** All existing migrations 001–041.

**Backward compatibility:** `sip_gateway_id` defaults to NULL. All existing ERS configurations continue to work exactly as before — they fall through to the tenant's `is_default_outbound` gateway or internal routing.

**Rollback:**
```sql
ALTER TABLE ers_configurations DROP COLUMN IF EXISTS sip_gateway_id;
```

---

### Phase B — Caller ID Passthrough (Lua fix)

**Root cause:** `invite_responder()` in `ers_conference_bridge.lua` uses hardcoded `origination_caller_id_number=ERS-RESP` and sets no caller name. The session variables `caller` and `caller_name` are already read at lines 145–146 but not forwarded.

**Files to modify:**
- `Lua-scripts/ers_conference_bridge.lua`

**Changes:**

1. Add caller identity parameters to `invite_responder()`:

```lua
-- BEFORE (line 111):
local function invite_responder(number, conf_room, conf_profile, incident_uuid, gateway)

-- AFTER:
local function invite_responder(number, conf_room, conf_profile, incident_uuid, gateway, c_num, c_name)
```

2. Replace the hardcoded caller ID in the originate command:

```lua
-- BEFORE (lines 112–117):
local gw      = gateway or "sofia/gateway/primary"
local profile = conf_profile or "default"
local cmd     = string.format(
  "originate {ignore_early_media=true,call_timeout=30,origination_caller_id_number=ERS-RESP}%s/%s &conference(%s@%s)",
  gw, number, conf_room, profile
)

-- AFTER:
local gw       = gateway or nil
local profile  = conf_profile or "default"
local num_val  = c_num  ~= "" and c_num  or "unknown"
local name_val = c_name ~= "" and c_name or num_val
-- Sanitise: FreeSWITCH originate variable syntax cannot contain raw '
-- (single-quote) or } — strip them rather than risk a malformed command.
name_val = name_val:gsub("['}]", "")
num_val  = num_val:gsub("['}]", "")

local dial_target
if gw then
  dial_target = gw .. "/" .. number
else
  dial_target = "user/" .. number
end

local cmd = string.format(
  "originate {ignore_early_media=true,call_timeout=30," ..
  "origination_caller_id_number=%s," ..
  "origination_caller_id_name='%s'," ..
  "effective_caller_id_number=%s," ..
  "effective_caller_id_name='%s'" ..
  "}%s &conference(%s@%s)",
  num_val, name_val, num_val, name_val,
  dial_target, conf_room, profile
)
```

3. Update `invite_tier()` to forward caller identity:

```lua
-- BEFORE (line 130):
local function invite_tier(responders, conf_room, conf_profile, incident_uuid, cfg)

-- AFTER:
local function invite_tier(responders, conf_room, conf_profile, incident_uuid, cfg, c_num, c_name)
```

4. Inside `invite_tier()`, forward to `invite_responder()`:

```lua
-- BEFORE (line 136):
for _, number in ipairs(responders) do
  invite_responder(number, conf_room, conf_profile, incident_uuid, gw)
end

-- AFTER:
for _, number in ipairs(responders) do
  invite_responder(number, conf_room, conf_profile, incident_uuid, gw, c_num, c_name)
end
```

5. Update both call sites of `invite_tier()` (lines 299 and 316) to pass `caller` and `caller_name`:

```lua
-- Line 299 (queued path):
invite_tier(cfg.primary_responders or {}, conf_room, conf_profile, incident_uuid, cfg, caller, caller_name)

-- Line 316 (active path):
invite_tier(responders, conf_room, conf_profile, incident_uuid, cfg, caller, caller_name)
```

**Files NOT to modify:** `invite_tier()` call at line 299 currently exists — only the argument list changes.

**Backward compatibility:** Pure addition of parameters. Existing callers that don't pass caller identity get `c_num=""` and `c_name=""` → fallback to `"unknown"` / `"unknown"`. No existing behavior removed.

---

### Phase C — Gateway Selection (Lua + backend)

**Root cause — Lua direct path:** `cfg.sip_gateway` at line 135 is always nil because `ers_configurations` has no `sip_gateway` column. The gateway defaults to `"sofia/gateway/primary"`.

**Root cause — IVR ring-all path:** `startRingAll()` receives `tenantId` but no ERS config gateway. `resolveDialString()` falls back to `is_default_outbound` tenant gateway, skipping any config-level gateway preference.

#### Phase C1 — Backend: return gateway name from ERS lookup

**File:** `backend/src/controllers/internal/ersInternalController.js`

In `ersLookup()` (line 151), the DB query selects from `ers_configurations` but does not join `sip_gateways`. Add the join and return `gateway_name` in the response.

**DB query change** (add to SELECT and FROM):
```sql
SELECT
  ...existing columns...,
  sg.name AS gateway_name
FROM emergency_numbers en
JOIN ers_configurations ec ON ec.id = en.ers_configuration_id ...
LEFT JOIN sip_gateways sg
  ON sg.id = ec.sip_gateway_id
  AND sg.is_active = true
  AND sg.deleted_at IS NULL
WHERE ...
```

**Response change** — add to `res.json({ success: true, data: { ... } })`:
```javascript
gateway_name: cfg.gateway_name || null,
```

#### Phase C2 — Lua: use gateway from lookup response

**File:** `Lua-scripts/ers_conference_bridge.lua`

The Lua script already reads `cfg.sip_gateway` at line 135. Change this to read `cfg.gateway_name` (the new field in the lookup response):

```lua
-- BEFORE (line 135):
local gw = cfg and cfg.sip_gateway or nil

-- AFTER:
local gw = cfg and cfg.gateway_name and ("sofia/gateway/" .. cfg.gateway_name) or nil
```

When `cfg.gateway_name` is set, `gw` becomes `"sofia/gateway/avaya_gateway"` (for example).  
When `cfg.gateway_name` is nil (no gateway configured), `gw` is nil.  
`invite_responder()` (after Phase B changes) then dials `user/<number>` when `gw` is nil — preserving internal FreeSWITCH calling.

**This eliminates the hardcoded `"sofia/gateway/primary"` fallback entirely.**

#### Phase C3 — Backend: thread config gateway into IVR ring-all path

**File:** `backend/src/controllers/internal/ersInternalController.js`

In `ersRingAll()` (line 884), the DB query already selects from `ers_configurations`. Add `sip_gateway_id` to the SELECT:

```javascript
const { rows: [cfg] } = await query(
  `SELECT id, tenant_id, ring_timeout_seconds,
          primary_bridge_number, secondary_bridge_number,
          conference_type, conference_profile,
          sip_gateway_id                    -- ADD THIS
   FROM ers_configurations
   WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
  [d.configuration_id]
);
```

Pass `configGatewayId` to `startRingAll()`:

```javascript
startRingAll({
  incidentId:         incident.id,
  incidentUuid:       incident.incident_uuid,
  configId:           d.configuration_id,
  tier:               d.tier,
  room,
  conferenceProfile,
  tenantId:           cfg.tenant_id,
  callerNumber:       d.caller_number,
  ringTimeoutSeconds: cfg.ring_timeout_seconds,
  configGatewayId:    cfg.sip_gateway_id ?? null,   // ADD THIS
});
```

**File:** `backend/src/services/ersRingService.js`

In `startRingAll()`, accept and thread the new parameter:

```javascript
export function startRingAll({ ..., configGatewayId = null }) {
  ...
  // pass configGatewayId to originateLeg per responder
  await originateLeg({ contact, room, conferenceProfile, tenantId, callerIdentity, configGatewayId });
}
```

In `originateLeg()`, use `configGatewayId` as a fallback when the contact has no per-contact gateway:

```javascript
async function originateLeg({ contact, room, conferenceProfile, tenantId, callerIdentity, configGatewayId }) {
  const { dialString } = await resolveDialString({
    tenantId,
    contactId: contact.id,
    // Config-level gateway as fallback: only used when contact has no per-contact override.
    // Must NOT be passed as gatewayId (which takes priority over contact.gateway_id) —
    // instead, it's used as gatewayName so contact.gateway_id still wins if set.
    // resolveDialString priority: gatewayId > contact.gateway_id > gatewayName > tenant default
    // We want: contact.gateway_id > configGatewayId > tenant default
    // So we pass nothing as gatewayId and handle the config fallback via gatewayId only
    // when we know the contact has no override (checked below).
  });
  ...
}
```

**Note on `resolveDialString()` priority:** Because `gatewayId` param overrides `contact.gateway_id` in `resolveDialString()`, we cannot blindly pass `configGatewayId` as `gatewayId`. The correct approach is to add a `fallbackGatewayId` parameter to `resolveDialString()`.

**File:** `backend/src/services/dialResolver.js`

Add `fallbackGatewayId` to the function signature and resolution chain:

```javascript
export async function resolveDialString({
  tenantId, contactId, extension, mobileNumber, gatewayId, gatewayName,
  fallbackGatewayId,   // ADD: used when contact has no gateway_id and no gatewayId/gatewayName
  domain: _domain,
} = {}) {
  ...
  // After reading contact.gateway_id:
  // resolvedGatewayId = resolvedGatewayId ?? contact.gateway_id ?? fallbackGatewayId
  ...
}
```

Specifically, the line at the bottom of the contact resolution block becomes:

```javascript
// BEFORE:
resolvedGatewayId = resolvedGatewayId ?? contact.gateway_id;

// AFTER:
resolvedGatewayId = resolvedGatewayId ?? contact.gateway_id ?? (fallbackGatewayId || null);
```

And in the no-contact path (when `contactId` is not provided), similarly:

```javascript
// After all gateway resolution, before the final fallback:
if (!gateway && !rawGatewayName && fallbackGatewayId) {
  const { rows: [g] } = await query(
    `SELECT * FROM sip_gateways WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
    [fallbackGatewayId]
  );
  gateway = g || null;
}
```

Then `originateLeg()` passes:

```javascript
const { dialString } = await resolveDialString({
  tenantId,
  contactId: contact.id,
  fallbackGatewayId: configGatewayId,  // ERS config gateway — lower priority than contact's own
});
```

#### Phase C4 — Backend: ERS configuration CRUD API

**File:** `backend/src/controllers/ersController.js`

Add `sip_gateway_id` to the ERS configuration create and update Zod schemas, and include it in the DB INSERT/UPDATE queries.

Security check: when `sip_gateway_id` is provided, validate that the gateway belongs to the same tenant:

```javascript
if (d.sip_gateway_id) {
  const { rows: [gw] } = await query(
    `SELECT id FROM sip_gateways
     WHERE id = $1 AND tenant_id = $2 AND is_active = true AND deleted_at IS NULL`,
    [d.sip_gateway_id, req.user.tenantId]
  );
  if (!gw) return res.status(422).json({ error: 'Gateway not found or not accessible' });
}
```

Also add `sip_gateway_id` to GET response (join `sip_gateways` to return `gateway_id` + `gateway_name`).

**Files NOT to modify:**
- `backend/src/services/campaignEngine.js` — ENS only
- `backend/src/services/conferenceManager.js` — conference state, no gateway
- All ERS reporting files

---

### Phase D — UI Changes

**File:** `frontend/src/pages/ers/ErsConfiguration.jsx` (or equivalent ERS config edit page)

Add a **Gateway** dropdown to the ERS configuration form:
- Label: "Outbound Gateway (optional)"
- Options: `— None (internal FreeSWITCH or tenant default) —` + active gateways from `GET /api/v1/gateways`
- Displays gateway name and type (Avaya / Cisco / Generic SIP)
- Saves `sip_gateway_id` to API

**File:** `frontend/src/api/client.js`

Ensure ERS configuration API methods include `sip_gateway_id` in request bodies and responses.

**Files NOT to modify:** Gateway management pages (already exist), ENS configuration pages, all report pages.

---

### Phase E — Extension Validation Fix

**Files to modify:**

| File | Lines | Change |
|---|---|---|
| `backend/src/controllers/internal/ersInternalController.js` | 19, 33, 41, 879, 1101 | `.min(7)` → `.min(1)` |
| `backend/src/controllers/internal/ensInternalController.js` | 18, 31, 37 | `.min(7)` → `.min(1)` |
| `backend/src/controllers/ersController.js` | 375 | `.min(7)` → `.min(1)` |

**Each change is one character (`7` → `1`) in the Zod schema definition.**

**Rationale for `.min(1)` not `.min(4)`:**
- Avaya may use 3-digit extensions in some configurations
- FreeSWITCH itself supports single-digit extension routing
- The digit floor is a gateway/dialplan concern, not an API schema concern
- `.min(1)` still rejects empty strings, which is the meaningful validation

**Files NOT to modify:** Database schema (no min-length CHECK constraints exist — correct), frontend validation (no hardcoded 7-digit minimum found).

---

### Phase F — Automated Tests

**Test matrix for Phase A–E:**

#### Dial string tests (conceptual — backend integration)

| Scenario | Contact setup | Expected dial string |
|---|---|---|
| Internal, no gateway | `extension_number=4321`, `gateway_id=null`, no ERS config gateway, no tenant default | `user/4321` |
| Internal short extension | `extension_number=123`, `gateway_id=null`, no gateway configured | `user/123` |
| Per-contact Avaya gateway | `extension_number=4321`, `gateway_id=avaya_gw.id` | `sofia/gateway/avaya_gateway/4321` |
| Per-contact Cisco gateway | `extension_number=5678`, `gateway_id=cisco_gw.id` | `sofia/gateway/cisco_gateway/5678` |
| ERS config gateway, no per-contact override | `extension_number=4321`, `gateway_id=null`; ERS config `sip_gateway_id=avaya_gw.id` | `sofia/gateway/avaya_gateway/4321` |
| Per-contact wins over config gateway | `gateway_id=cisco_gw.id`; ERS config `sip_gateway_id=avaya_gw.id` | `sofia/gateway/cisco_gateway/4321` (contact wins) |
| Mobile via PSTN gateway | `mobile_number=9665XXXXXXXX`, `gateway_id=pstn_gw.id` | `sofia/gateway/pstn_gateway/9665XXXXXXXX` |

#### Extension validation tests

| Input | Field | Expected |
|---|---|---|
| `"4321"` (4 digits) | `caller_number` (internal endpoint) | Accept (was 400, now 200) |
| `"12"` (2 digits) | `caller_number` (internal endpoint) | Accept |
| `"1"` (1 digit) | `caller_number` (internal endpoint) | Accept |
| `""` (empty) | `caller_number` (internal endpoint) | 400 (min 1 rejects empty) |
| `"4321"` (4 digits) | `responder_number` (PATCH) | Accept (was 400) |

#### Caller ID tests (code-path verification)

| Scenario | Expected originate variables |
|---|---|
| `caller_id_number=4321`, `caller_id_name=John Smith` | `origination_caller_id_number=4321`, `origination_caller_id_name='John Smith'`, `effective_caller_id_number=4321`, `effective_caller_id_name='John Smith'` |
| `caller_id_number=4321`, `caller_id_name=""` (no name from SIP) | name fallback to `"4321"` |
| `caller_id_number=anonymous` | passed through as-is |
| `caller_id_number=""` (unavailable) | `num_val="unknown"` |

#### Gateway security tests

| Scenario | Expected |
|---|---|
| ERS config with `sip_gateway_id` belonging to same tenant | 200 / saved |
| ERS config with `sip_gateway_id` belonging to different tenant | 422 |
| ERS config with `sip_gateway_id` = deleted gateway | 422 |
| ERS config with `sip_gateway_id` = inactive gateway | 422 |

#### External PBX runtime tests (require live environment)

All of the following must be marked `CODE-PATH VERIFIED — EXTERNAL PBX RUNTIME TEST PENDING` until a live Avaya or Cisco test environment is available:

- FreeSWITCH dials responder via configured Avaya gateway → extension 4321 rings on Avaya phone
- Responder's Avaya phone displays emergency caller's real number and name
- Responder answers → joined into ERS conference with emergency caller
- Conference continues after responder fails to answer (single responder failure)
- Gateway down → `CHANNEL_HANGUP` fired → responder marked MISSED → conference continues

---

## Files Summary

### New files
- `backend/src/db/migrations/042_ers_gateway.sql`

### Modified files
| File | Phase | Change |
|---|---|---|
| `Lua-scripts/ers_conference_bridge.lua` | B, C | Caller ID passthrough + gateway from config |
| `backend/src/controllers/internal/ersInternalController.js` | C, E | Lookup: add gateway_name; Zod: min(7)→min(1) |
| `backend/src/controllers/internal/ensInternalController.js` | E | Zod: min(7)→min(1) |
| `backend/src/controllers/ersController.js` | C, E | CRUD: add sip_gateway_id; Zod: min(7)→min(1) |
| `backend/src/services/ersRingService.js` | C | Thread configGatewayId through startRingAll/originateLeg |
| `backend/src/services/dialResolver.js` | C | Add fallbackGatewayId parameter |
| `frontend/src/pages/ers/ErsConfiguration.jsx` | D | Gateway dropdown |
| `frontend/src/api/client.js` | D | sip_gateway_id in ERS config methods |

### NOT modified (confirmed)
- `backend/src/services/campaignEngine.js` — ENS, out of scope
- `backend/src/services/conferenceManager.js` — conference state only
- `backend/src/controllers/internal/ensInternalController.js` gateway/originate logic — ENS, only Zod fix
- All `frontend/src/pages/reports/*` — reporting, out of scope
- `Lua-scripts/ens_blast_trigger.lua`, `ens_playback_handler.lua` — ENS, out of scope
- All migrations 001–041

---

## Deployment Order

1. Apply migration 042 (ADD COLUMN — fast, no lock contention)
2. Deploy backend (lookup response includes `gateway_name`; new API fields; Zod fixes)
3. Deploy Lua script (`ers_conference_bridge.lua`) to FreeSWITCH — `cp Lua-scripts/ers_conference_bridge.lua $FS_LUA_DIR/` — no `reloadxml` needed (Lua loaded per-call)
4. Deploy frontend (gateway dropdown in ERS config form)

**Lua can be deployed before or after backend step 2.** The new Lua reads `cfg.gateway_name` — if the backend doesn't return it yet, `cfg.gateway_name` is nil → `gw` is nil → dials `user/<number>` (existing internal behavior, unchanged). No breakage.

---

## Rollback

| Component | Rollback action |
|---|---|
| Migration 042 | `ALTER TABLE ers_configurations DROP COLUMN IF EXISTS sip_gateway_id;` |
| Lua script | `git checkout Lua-scripts/ers_conference_bridge.lua` + redeploy |
| Backend | `git checkout <files>` + restart backend |
| Frontend | `git checkout <files>` + rebuild |

---

## Open Questions (require review before implementation)

1. **`resolveResponders()` in `ersInternalController.js` selects only `mobile_number`** (line 59–65). The direct Lua path therefore only dials mobile numbers even when a contact has `extension_number` set. Should this be fixed in this task, or is it a separate scope item? Changing it to prefer `extension_number` over `mobile_number` (or making it configurable via a dialing policy) would align with the ENS `dial_preference` model. **Recommendation: fix in this task since it affects the same Lua path (Bug B6 in investigation).**

2. **`caller_id_in_from` gateway column** — when true, FreeSWITCH sets the SIP From header from the outbound caller ID. No code change is needed here (it's in the gateway XML). Should we document this in the ERS gateway UI tooltip so admins know to configure it for Avaya/Cisco environments that trust From rather than PAI?

3. **`ersController.js:375` BroadcastUsersSchema** — changing `mobile: z.string().min(7)` to `.min(1)` is consistent with the other fixes, but this schema is for bulk REST import, not a Lua endpoint. Is there a separate business decision here (e.g., enforcing PSTN minimum for mobile numbers specifically)?

---

## STOP

This is the end of the investigation and plan. No implementation has occurred.

Implementation may begin after this plan is explicitly approved. The recommended starting point is **Phase A (migration)** followed by **Phase B (Lua caller ID fix)** as the highest-impact changes.
