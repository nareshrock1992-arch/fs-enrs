# FS-ENRS — ERS External PBX Investigation (Verified)

**Date:** 2026-08-09  
**Type:** Read-only forensic investigation — source-verified  
**Supersedes:** Earlier draft produced without full call-path tracing  
**Scope:** ERS outbound responder calling, ENS gateway comparison, caller-ID propagation, extension-length validation

All citations are file-path:line against the current main branch.  
**Source code always wins over prior investigation docs when they conflict.**

---

## Phase 0 — ERS Call Path: Verified Architecture

### 0.1 There are TWO separate ERS responder-calling paths

#### Path 1 — Direct ERS (static Lua) — PRODUCTION PATH for non-IVR deployments

```
SIP INVITE → FreeSWITCH dialplan
  → ers_conference_bridge.lua
      → GET /internal/ers/lookup?number=<dest>        [line 152]
          returns config (NO gateway field — ers_configurations has no gateway column)
      → reads session caller_id_number / caller_id_name  [lines 145–146]
      → POST /internal/ers/incidents                   [line 215]
          {caller_number=caller, caller_name=caller_name, ...}  ← correct
      → invite_tier()                                  [line 299, 316]
          → invite_responder(number, conf_room, conf_profile, incident_uuid, gw)
              gw = cfg.sip_gateway OR nil              [line 135]
              cfg.sip_gateway is ALWAYS nil (no such column in ers_configurations)
              gw = nil → fallback "sofia/gateway/primary" [line 112]
              originate {origination_caller_id_number=ERS-RESP}  ← HARDCODED [line 115]
              freeswitch.bgapi(cmd)                    [line 119]
      → session:execute("conference", room)            [line 330]
```

**`invite_responder()` is NOT dead code.** It is called at lines 299 and 316 of `ers_conference_bridge.lua` in normal ERS call flow. It is the production responder-inviting mechanism for direct ERS.

#### Path 2 — IVR ERS Ring-All (generated Lua) — PRODUCTION PATH for IVR-based deployments

```
IVR flow → ers_ring_all node (registry.js:604)
  → generated Lua calls POST /internal/ers/ring-all    [registry.js:628]
      {configuration_id, tier, caller_number, caller_name, emergency_number}
  → ersRingAll() [ersInternalController.js:884]
      → creates incident via DB INSERT                 [line 954]
      → startRingAll({ incidentId, configId, tier, room, tenantId, callerNumber })
  → startRingAll() [ersRingService.js:128]
      → lookupCallerIdentity(callerNumber)             [line 136]
          → queries emergency_contacts by extension or last-9-digit mobile
          → returns { name: "First Last", number: "4321" }
          → fallback: { name: rawNumber, number: rawNumber }
      → resolveTierResponders(configId, tier)          [line 137]
          → returns contacts with {id, mobile_number, extension_number}
      → per-responder: originateLeg({ contact, room, callerIdentity, tenantId }) [line 218]
          → resolveDialString({ tenantId, contactId: contact.id })  [line 92]
              reads emergency_contacts.gateway_id
              if set → sofia/gateway/<name>/<number>
              if null → tenant's is_default_outbound gateway OR user/<ext>
          → originate {effective_caller_id_name=<real name>, effective_caller_id_number=<real number>, ...}
      → re-rings until answered or timeout
  → Lua s:execute("conference", d.conference_room)     [registry.js:657]
```

**Path 2 has correct gateway handling and correct caller ID passthrough. Path 1 does not.**

### 0.2 Which path does the current lab use?

The deployment system generates FreeSWITCH XML dialplan entries that route ERS emergency numbers to `ers_conference_bridge.lua`. This is Path 1. Path 2 is only active when a customer has built an IVR flow that includes an `ers_ring_all` node.

The task description confirms: "The current lab mainly uses internal FreeSWITCH extensions." This is the direct ERS (Path 1) scenario.

**All required fixes must address Path 1. Path 2 already works correctly for external PBX.**

---

## Phase 1 — ENS Gateway Architecture

### 1.1 `sip_gateways` table

**Source:** `backend/src/db/migrations/015_sip_gateways.sql` lines 12–32

```sql
CREATE TABLE IF NOT EXISTS sip_gateways (
  id                   SERIAL       PRIMARY KEY,
  tenant_id            INT          REFERENCES tenants(id) ON DELETE CASCADE,
  name                 VARCHAR(64)  NOT NULL,   -- FreeSWITCH gateway name (sofia/gateway/<name>/...)
  type                 VARCHAR(32)  NOT NULL DEFAULT 'generic_sip'
                          CHECK (type IN ('avaya', 'cisco', 'generic_sip', 'other')),
  host                 VARCHAR(255) NOT NULL,
  port                 INT          NOT NULL DEFAULT 5060,
  username             VARCHAR(128),
  password             VARCHAR(255),
  register             BOOLEAN      NOT NULL DEFAULT true,
  caller_id_in_from    BOOLEAN      NOT NULL DEFAULT false,
  is_default_outbound  BOOLEAN      NOT NULL DEFAULT false,
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  ...
  deleted_at           TIMESTAMPTZ,
  UNIQUE (tenant_id, name)
);
```

- `name` column maps directly to `sofia/gateway/<name>/` in FreeSWITCH dial strings
- `type` pre-enumerates Avaya, Cisco, generic SIP, other
- `is_default_outbound` — tenant-level default when no per-contact or per-config override exists
- `caller_id_in_from` — routes caller ID through SIP From header rather than P-Asserted-Identity

### 1.2 Per-contact gateway override

**Source:** `backend/src/db/migrations/015_sip_gateways.sql` line 46

```sql
ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS gateway_id INT REFERENCES sip_gateways(id) ON DELETE SET NULL;
```

Single column shared by both ERS and ENS contacts. When set, overrides any configuration-level gateway.

### 1.3 ENS configuration gateway fields

`ens_configurations` has (accumulated across migrations):
- `sip_gateway VARCHAR(128)` — raw FreeSWITCH gateway name string, legacy (`001_initial_schema.sql:212`)
- `gateway_override VARCHAR(255)` — higher-priority raw name, migration 038
- `allow_mobile BOOLEAN` — whether to dial mobile numbers, migration 035
- `allow_extension BOOLEAN` — whether to dial extensions, migration 035 + 039
- `routing_mode VARCHAR(20)` — `auto|internal_only|gateway_only`, migration 034
- `dial_preference VARCHAR(30)` — `extension_mobile|mobile_extension|...`, migration 034

### 1.4 ENS gateway priority chain

**Source:** `backend/src/services/campaignEngine.js` `resolveContact()` lines 96–203

```
1. cfg.gateway_override     (raw name string, highest priority)
2. contact.gateway_id       (FK to sip_gateways, per-contact)
3. cfg.sip_gateway          (raw name string, legacy)
4. config.freeswitch.defaultGateway  (system env fallback)
5. null → internal user/<ext>
```

### 1.5 ENS originate caller ID

**Source:** `backend/src/services/eslService.js` `originateCampaignCall()` lines 1753–1761

```javascript
origination_caller_id_number: clid || number,
origination_caller_id_name:   'Emergency',
```

Where `clid = campaign.sip_caller_id || campaign.trigger_number || '999'`

**ENS does NOT pass the original caller's identity to responders.** It passes the configured blast caller ID. This is by design for ENS (outbound blast = service number, not original caller). ERS behavior should be different.

---

## Phase 2 — ERS vs ENS Comparison

| Capability | ENS | ERS (Direct Path) | ERS (IVR Ring-All) | Required ERS Change |
|---|---|---|---|---|
| Gateway table | `sip_gateways` ✓ | `sip_gateways` (shared) | `sip_gateways` (shared) | None |
| Config-level gateway | `ens_configurations.sip_gateway` + `gateway_override` ✓ | **MISSING** — no column in `ers_configurations` | No column either (uses per-contact only) | Add `sip_gateway_id` to `ers_configurations` |
| Per-contact gateway | `emergency_contacts.gateway_id` ✓ | Only mobile_number passed to Lua — contact FK not used | `emergency_contacts.gateway_id` ✓ via `resolveDialString()` | Lua path: use config gateway; IVR path: already works |
| External PBX destination | `sofia/gateway/<n>/<num>` ✓ | Hardcoded `sofia/gateway/primary` ✗ | `resolveDialString()` ✓ | Fix Lua: use config gateway name from lookup |
| Internal extension | `user/<ext>` ✓ | `user/<ext>` when no gateway ✓ (falls through) | `user/<ext>` ✓ | No change needed |
| Number selection | `mobile_number` or `extension_number` via dialing policy | `mobile_number` only (line 60 in resolveResponders) | `extension_number || mobile_number` ✓ | Lua path limitation (mobile only) |
| Caller ID number | `blast_clid` or trigger number (by design) | Hardcoded `"ERS-RESP"` ✗ | Real caller via `lookupCallerIdentity()` ✓ | Fix Lua: pass session caller_id_number |
| Caller ID name | Hardcoded `"Emergency"` (by design) | Not set ✗ | Real name via directory lookup ✓ | Fix Lua: pass session caller_id_name |
| Original caller passthrough | Not applicable (blast) | Lua reads caller at line 145 but drops at invite_responder ✗ | ✓ full passthrough | Fix Lua invite_responder() |
| Tenant isolation | gateway FK filtered by tenant_id ✓ | N/A — no config gateway | contact FK filtered ✓ | Must enforce on new `sip_gateway_id` FK |
| Min digit validation | z.string().min(7) on internal endpoints | Same ✗ (blocks 4-digit PBX extensions) | Same ✗ | Lower to .min(1) — see Phase 5 |

---

## Phase 3 — `dialResolver.js` Analysis

**Source:** `backend/src/services/dialResolver.js`

```javascript
export async function resolveDialString({
  tenantId, contactId, extension, mobileNumber, gatewayId, gatewayName
}) {
  // Priority chain:
  // 1. explicit gatewayId param → overrides everything
  // 2. contact.gateway_id (read from DB via contactId)
  // 3. gatewayName param → look up in sip_gateways or use as raw name
  // 4. tenant's is_default_outbound gateway
  // 5. null → user/<ext> (internal)
}
```

**Gateway present:** `sofia/gateway/<name>/<number>` where number = `mobile || ext`  
**No gateway:** `user/<dest>` where dest = `ext || mobile`

**Key design note from line 6–18:** "Every call-origination path in this codebase (ERS ring-all, ENS campaign engine, ad-hoc test originate) must go through resolveDialString() — never inline `user/` or `sofia/gateway/` anywhere else."

The Lua direct path (`invite_responder()`) violates this rule — it inlines `sofia/gateway/primary` and `user/` style paths directly in the Lua script. The fix does not require changing `dialResolver.js` itself.

**Conceptual validation of dial string output:**

| Input | dial string |
|---|---|
| contactId=5 (extension_number=4321, gateway_id=null), tenantId=1, no default gateway | `user/4321` |
| contactId=5 (extension_number=4321, gateway_id=avaya_gw.id), tenantId=1 | `sofia/gateway/avaya_gateway/4321` |
| contactId=5 (mobile_number=9665XXXXXXXX, gateway_id=null), tenant has `is_default_outbound` gateway | `sofia/gateway/<default>/<9665...>` |
| contactId=5 (mobile_number=9665XXXXXXXX, gateway_id=null), tenant has no gateway | `user/9665XXXXXXXX` |

---

## Phase 4 — Caller ID Chain Analysis

### 4.1 How FreeSWITCH receives caller identity

When a SIP INVITE arrives at FreeSWITCH:
- `caller_id_number` — calling party number from SIP From URI or P-Asserted-Identity
- `caller_id_name` — display name from SIP From header (e.g., "John Smith")
- `effective_caller_id_number` — same as `caller_id_number` unless overridden
- `sip_from_display` — SIP From Display Name (same source as `caller_id_name`)

### 4.2 What the Lua script currently does with these

**`ers_conference_bridge.lua` lines 145–147:**
```lua
local caller      = session:getVariable("caller_id_number") or ""
local caller_name = session:getVariable("caller_id_name")   or ""
```

Both variables are read correctly from the session. `caller_name` captures the SIP From Display Name, which is exactly the caller's name as presented by the upstream PBX.

**These values are correctly passed to incident creation** (line 218:  `caller_number=caller, caller_name=caller_name`).

**These values are NOT passed to `invite_responder()`** (line 137: `invite_responder(number, conf_room, conf_profile, incident_uuid, gw)` — no caller identity argument).

**Inside `invite_responder()` (line 115):**
```lua
"originate {ignore_early_media=true,call_timeout=30,origination_caller_id_number=ERS-RESP}%s/%s &conference(%s@%s)"
```

- `origination_caller_id_number` = hardcoded `"ERS-RESP"` — replaces real caller number
- `origination_caller_id_name` — not set at all
- `effective_caller_id_number` — not set
- `effective_caller_id_name` — not set

**Result:** The responder's phone shows `"ERS-RESP"` as caller, with no name.

### 4.3 Required caller ID behavior

For caller `number=4321, name="John Smith"`:

| Variable | Required value | Source |
|---|---|---|
| `origination_caller_id_number` | `4321` | `session:getVariable("caller_id_number")` |
| `origination_caller_id_name` | `John Smith` | `session:getVariable("caller_id_name")` |
| `effective_caller_id_number` | `4321` | same |
| `effective_caller_id_name` | `John Smith` | same |

### 4.4 Edge cases

| Scenario | Behavior |
|---|---|
| `caller_id_name` is empty (SIP trunk provides number only) | Use `caller` as fallback for name |
| `caller_id_number` is empty/anonymous | Empty string — originate variable set to empty, gateway/PBX behavior depends on carrier |
| `caller_id_number` is `"anonymous"` | Pass through as-is — do NOT strip or replace |
| Caller in emergency_contacts directory | IVR ring-all path looks up pretty name; Lua direct path does NOT (uses SIP-provided name) |

### 4.5 `caller_id_in_from` gateway column

When `sip_gateways.caller_id_in_from = true`, the gateway XML configures FreeSWITCH to set the SIP From header from the outbound caller ID rather than using P-Asserted-Identity. This is relevant when the target Avaya/Cisco PBX trusts the From header for display. This column exists in `sip_gateways` — no code change needed; it's handled by the FreeSWITCH gateway XML generated by `gatewayXmlGenerator.js`.

---

## Phase 5 — Extension Validation Root Cause

### 5.1 All `.min(7)` instances classified

| File | Line | Schema | Field | Caller context | Type | min(7) appropriate? |
|---|---|---|---|---|---|---|
| `ersInternalController.js` | 19 | `IncidentCreateSchema` | `caller_number` | Lua sends FreeSWITCH `caller_id_number` | Extension OR mobile | NO — can be 4-digit PBX ext |
| `ersInternalController.js` | 33 | `ResponderUpdateSchema` | `responder_number` | Lua sends number of joining responder | Extension OR mobile | NO — responder may have 4-digit ext |
| `ersInternalController.js` | 41 | `ObserverSchema` | `observer_number` | Lua sends observer's number | Extension OR mobile | NO — observer may have 4-digit ext |
| `ersInternalController.js` | 879 | `RingAllSchema` | `caller_number` | IVR Lua sends `caller_id_number` | Extension OR mobile | NO — same as line 19 |
| `ersInternalController.js` | 1101 | `OverflowEnqueueSchema` | `caller_number` | IVR Lua sends caller while queued | Extension OR mobile | NO — same |
| `ersController.js` | 375 | `BroadcastUsersSchema` | `mobile` | REST API bulk import — labeled "mobile" | Primarily mobile | DEBATABLE — but short mobile numbers are valid in some regions |
| `ensInternalController.js` | 18 | `CampaignStartSchema` | `contact_number` | Lua sends ENS contact's number | Mobile or extension | NO — same reasoning |
| `ensInternalController.js` | 31 | `CampaignStartSchema` | `caller_number` | Lua sends ENS trigger caller | Mobile or extension | NO |
| `ensInternalController.js` | 37 | (verify-pin schema) | `caller_number` | Lua sends caller for PIN verify | Mobile or extension | NO |

### 5.2 Where min(7) is NOT enforced

- **Database:** `emergency_contacts.mobile_number VARCHAR(32) NOT NULL` — no `CHECK` constraint. Short extensions are valid at the DB level.
- **Frontend:** No hardcoded minimum digit validation found in `frontend/src/`.
- **Contact CRUD controllers:** `ersController.js` and `ensController.js` contact create/update do NOT enforce min(7) (only `BroadcastUsersSchema` at line 375 does).

### 5.3 Root cause

The `min(7)` validators were placed at the **Lua-to-backend API boundary** under an implicit assumption that all numbers from FreeSWITCH are full PSTN numbers (≥7 digits). This assumption breaks for enterprise PBX environments where extensions are 3–5 digits.

### 5.4 Correct fix

Change all nine instances to `.min(1)`. Rationale:
- `.min(1)` rejects empty strings — prevents sending null/blank numbers as call targets
- `.min(1)` accepts short extensions — correct for enterprise PBX environments
- Gateway-level digit validation (e.g., gateway min/max extension length) is a separate concern from API schema validation and belongs in the gateway configuration, not in a hard-coded Zod rule
- The `INTERNAL_API_KEY` auth on `/api/v1/internal/*` routes ensures only trusted Lua scripts reach these endpoints; weak length validation is not a meaningful security gate here

### 5.5 `ersController.js:375` `mobile` field in `BroadcastUsersSchema`

This field is labeled "mobile" but is used as the primary dial target for bulk-imported responders. In some regions, mobile numbers are 7+ digits; in enterprise PBX environments, the same field holds extensions. Changing to `.min(1)` is consistent with the decision above.

---

## Phase 6 — Gateway Configuration Location

### 6.1 Does `ers_configurations` need a gateway column?

**Yes.** The direct ERS path (Path 1) currently falls back to `"sofia/gateway/primary"` because `cfg.sip_gateway` is always nil. The correct behavior is:

```
ERS config gateway → used when no per-contact override exists
```

This matches the ENS model (which has `sip_gateway` and `gateway_override`).

### 6.2 Recommended column

Add a proper FK column (not a raw string like ENS's legacy `sip_gateway`):

```sql
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS sip_gateway_id INT REFERENCES sip_gateways(id) ON DELETE SET NULL;
```

**Why FK over raw string?**
- ENS's `sip_gateway VARCHAR` is a legacy column from migration 001, before `sip_gateways` table existed
- ENS added `gateway_override VARCHAR` as a workaround (migration 038)
- ERS is adding this now — the correct modern approach is a FK to `sip_gateways`
- FK gives referential integrity, allows admin to rename a gateway safely

### 6.3 Gateway precedence for ERS

**Direct Lua path (Path 1):**
```
1. (per-contact override not available — Lua only has mobile numbers, not contact IDs)
2. ers_configurations.sip_gateway_id → resolved gateway name → used in invite_responder()
3. No gateway → invite_responder() uses user/<number> (no sofia/gateway/ prefix)
```

**IVR ring-all path (Path 2):**
```
1. emergency_contacts.gateway_id (per-contact FK, highest)  ← already works
2. ers_configurations.sip_gateway_id → passed as fallbackGatewayId to resolveDialString()  ← NEW
3. tenant's is_default_outbound gateway  ← already works
4. null → user/<ext>  ← already works
```

### 6.4 Does `sip_gateways` need `min_ext_digits` / `max_ext_digits`?

**Not in this implementation phase.** The extension-length problem is in Zod validation at the API boundary. Changing `.min(7)` to `.min(1)` removes the artificial restriction. Gateway-level digit validation is a separate feature and would require a separate design decision. Excluded from this scope.

---

## Phase 7 — Failure / Retry Behavior (Verified)

**Direct Lua path (Path 1):**
- `freeswitch.bgapi()` is fire-and-forget — no return value checked
- Failed calls result in `CHANNEL_HANGUP` ESL events
- `ersInternalController.js` has `PATCH /incidents/:uuid/responder` endpoint — Lua calls this when a responder joins/fails
- For `invite_responder()`, the patch call at line 122 only marks `INVITED` — it doesn't handle failure states in the Lua
- **No retry in the Lua direct path** — all responders are rung once; those who don't answer are later marked MISSED by `completeIncidentCore()`

**IVR ring-all path (Path 2):**
- `startRingAll()` — continuous re-ring every `LEG_TIMEOUT_S + 3s` until any responder answers or timeout
- Member count checked via ESL — caller abandonment (count=0) stops the ring loop
- One failed responder does NOT stop the conference

**Both paths:** Other responders continue independently. One failed leg does not affect the conference.

---

## Phase 8 — Security Analysis

### 8.1 Tenant isolation — current state

- `sip_gateways.tenant_id` — enforced; `gatewayController.js` always filters by `req.user.tenantId`
- `emergency_contacts.gateway_id` — `resolveDialString()` reads the gateway by ID but does NOT verify `gateway.tenant_id === contact.tenant_id`. The contact must belong to the tenant for the query to return it, making cross-tenant gateway use via per-contact override non-trivial but theoretically possible if contact rows are created without proper tenant scoping.
- `ers_configurations.sip_gateway_id` (proposed) — **must** validate `gateway.tenant_id === config.tenant_id` on every create/update

### 8.2 No open dialing risk

Dial strings are built from `emergency_contacts.mobile_number` / `extension_number` — stored at contact creation time, not from runtime request fields. No runtime injection path exists.

### 8.3 Caller ID — no spoofing risk

`origination_caller_id_number` in the Lua path comes from `session:getVariable("caller_id_number")` — a FreeSWITCH A-leg channel variable. It is set by FreeSWITCH when the SIP INVITE arrives and cannot be overridden by the API request body.

---

## Summary of Confirmed Bugs

| # | Bug | File | Line(s) | Impact |
|---|---|---|---|---|
| B1 | Caller ID hardcoded `"ERS-RESP"` | `ers_conference_bridge.lua` | 115 | Responder cannot identify emergency caller |
| B2 | Caller name not set on originate | `ers_conference_bridge.lua` | 114–116 | Responder phone shows blank name |
| B3 | Gateway hardcoded `"sofia/gateway/primary"` | `ers_conference_bridge.lua` | 112 | External PBX responders unreachable unless gateway is named `primary` |
| B4 | `ers_configurations` has no gateway field | DB schema | — | No way to configure default ERS outbound gateway |
| B5 | `.min(7)` on all internal caller/responder number fields | multiple | see Phase 5 | 4–6 digit PBX extensions rejected by API |
| B6 | `resolveResponders()` selects only `mobile_number` | `ersInternalController.js` | 59–65 | Extension-only contacts unreachable via direct Lua path |
| B7 | ERS config-level gateway not threaded into `startRingAll()` | `ersRingService.js` | 128+ | IVR ring-all path skips ERS config gateway, falls to tenant default |
