# Domain Model

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Reading This Document

For every business object:
- **Owner** — the module that has write authority
- **Source of truth** — the database table
- **May write** — modules that may INSERT/UPDATE this object
- **May read** — modules that may SELECT this object
- **Forbidden** — modules that must never write this object

---

## Platform Objects

### Tenant
The top-level organizational boundary. Every row in every table carries a `tenant_id`. No data crosses tenant boundaries. The JWT `tenantId` is the security enforcement point.

| Field | Value |
|---|---|
| Owner | Platform Admin |
| Source of truth | `tenants` |
| Lifecycle | Created by platform admin. Soft-deleted only. |
| May write | Platform Admin UI |
| May read | All modules (FK reference) |

**Frozen rule:** `tenant_id` on every business row is set from `req.user.tenantId` (JWT) at INSERT time. It is never sourced from the request body.

---

### Organization
A named grouping within a tenant. Used as a UX organizational unit (departments, branches, divisions). **Organization is not a security boundary — Tenant is.**

| Field | Value |
|---|---|
| Owner | Configuration module |
| Source of truth | `organizations` |
| Lifecycle | Created by tenant admin. Soft-deleted. |
| Relationship | One organization belongs to one tenant (via `tenant_id` FK). The `tenant_mappings` table is legacy — its many-to-many model is not used for security enforcement. |
| May write | Configuration module |
| May read | All modules |

---

### Site _(Wave 6)_
A physical or logical deployment location within a tenant. Sites own FreeSWITCH cluster connections, gateway registrations, and recording storage paths.

| Field | Value |
|---|---|
| Owner | Gateway Manager |
| Source of truth | `sites` (table to be created in Wave 6) |
| Lifecycle | Created per physical location or network zone. |
| May write | Gateway Manager |
| May read | Outbound Router, Provider Layer, Recording module |

---

### Gateway
A SIP gateway or trunk registered with FreeSWITCH. The routing layer selects a Gateway. Business modules must never reference gateways directly.

| Field | Value |
|---|---|
| Owner | Gateway Manager |
| Source of truth | `sip_gateways` |
| Lifecycle | Created → Deployed (FreeSWITCH XML) → Active → Decommissioned (soft-delete after verifying no active calls) |
| May write | Gateway Manager only |
| May read | Outbound Router, Destination Classifier, Provider Layer |
| Forbidden | ENS, ERS, IVR must never select a gateway or reference gateway names |

---

### Provider _(Wave 4)_
An execution backend (FreeSWITCH, Twilio, SBC, WebRTC). Providers are code objects, not database rows. Each provider implements the Provider interface and is registered in `providerRegistry.js`.

| Field | Value |
|---|---|
| Owner | Provider Layer |
| Registry | `src/providers/providerRegistry.js` |
| Current providers | `freeswitch` (active) |
| May call | Outbound Router (selects via gateway config) |
| Forbidden | Business modules must never call provider APIs |

---

### Contact
An individual person reachable by the platform. The single source of truth for extension numbers, mobile numbers, and per-contact gateway overrides.

| Field | Value |
|---|---|
| Owner | Configuration module |
| Source of truth | `emergency_contacts` |
| Lifecycle | Created by tenant admin. Soft-deleted. |
| Key fields | `extension_number`, `mobile_number`, `gateway_id` (FK to sip_gateways) |
| May write | Configuration module |
| May read | ENS, ERS, IVR, Destination Classifier, Outbound Router |

---

### Contact Group
A named collection of Contacts. Used by ERS for responder tiers, ENS for blast recipients, and future Contact Center queue staffing.

| Field | Value |
|---|---|
| Owner | Configuration module |
| Source of truth | `responder_groups` + `responder_group_members` |
| Lifecycle | Created by tenant admin. Soft-deleted. |
| May write | Configuration module |
| May read | ENS, ERS, Contact Center (future) |

---

### Route (Service Registry)
The mapping of a dialled number to a service type and configuration. The single source of truth for "what happens when this number is called."

| Field | Value |
|---|---|
| Owner | Configuration module |
| Source of truth | `emergency_numbers` |
| Lifecycle | Created per service binding. Soft-deleted. |
| Key fields | `number`, `type` (ENS/ERS/IVR/REJOIN/OPEN_ACCESS), FK to configuration |
| May write | Configuration module |
| May read | Lua scripts (via internal API), IVR Deployment Engine, Outbound Router |

---

### Routing Policy _(Wave 5)_
A rule controlling which gateway is selected for a given destination type or number pattern. Allows routing configuration without code changes.

| Field | Value |
|---|---|
| Owner | Gateway Manager |
| Source of truth | `gateway_routes` (table to be created in Wave 5) |
| May write | Gateway Manager |
| May read | Outbound Router only |
| Forbidden | Business modules must never read routing policies |

---

## Communication Objects

### Communication Request _(Wave 3)_
A transient, in-memory intent object submitted by a business module. Contains zero provider-specific concepts.

| Field | Value |
|---|---|
| Owner | Transient — discarded after Engine processes it |
| Source of truth | None — in-memory only |
| Produced by | ENS, ERS, IVR, Contact Center |
| Consumed by | Communication Engine only |
| Key fields | tenantId, module, moduleRefId, destination, callerIdentity, action, priority, channel |

---

### Communication Session _(Wave 3)_
A persistent record of every outbound call attempt across all modules. The platform-level unified audit trail.

| Field | Value |
|---|---|
| Owner | Communication Engine |
| Source of truth | `communication_sessions` |
| Lifecycle | PENDING → ORIGINATING → RINGING → ANSWERED → COMPLETED \| NO_ANSWER \| FAILED \| BUSY \| CANCELLED |
| May write | Communication Engine only |
| May read | Reporting, Observability, all modules (status checks) |
| Key fields | session_uuid, module, module_ref_table, module_ref_id, provider_session_id, status, channel |

---

### Conference
An audio conference room managed by FreeSWITCH. A platform concept — not owned by ERS exclusively.

| Field | Value |
|---|---|
| Owner | Platform (Conference Manager service) |
| Source of truth | `ers_incidents.conference_room` (current); future: standalone `conferences` table |
| Lifecycle | Created by first participant joining. Destroyed when last participant leaves. |
| May write | Provider Layer (ESL events), Conference Manager |
| May read | ERS, Recording module, Reporting |

---

### Recording
An audio file produced from a conference, IVR message, or ENS blast. Business modules request recording; they do not manage files.

| Field | Value |
|---|---|
| Owner | Recording module |
| Source of truth | `recordings` |
| Lifecycle | Requested by business module → started by Recording module → file written by provider → path stored |
| May write | Recording module only |
| May read | ENS (playback), ERS (download link), Reporting, Media Library |

---

## ENS Objects

### ENS Configuration
The setup for one Emergency Notification System service.

| Field | Value |
|---|---|
| Owner | ENS module |
| Source of truth | `ens_configurations` |
| Lifecycle | Created by tenant admin. Active until deleted. |
| Key fields | `sip_gateway_id` (FK, Wave 1), recipient groups, `pin`, `expiry_hours`, `sip_caller_id`, `reply_clid` |
| May write | ENS module (Configuration UI) |
| May read | ENS Campaign Engine, IVR (blast node), Reporting |

**Caller ID fields guidance:**
- `sip_caller_id` — authoritative outbound number shown to recipients (used by campaign engine)
- `reply_clid` — callback number for playback authorization
- `blast_clid` — deprecated (Wave 3 cleanup)
- `caller_id` — deprecated (Wave 3 cleanup)

---

### ENS Campaign
An active or completed notification blast. One Campaign is created per trigger event.

| Field | Value |
|---|---|
| Owner | ENS module |
| Source of truth | `ens_campaigns` |
| Lifecycle | queued → running → completed \| failed \| cancelled |
| May write | ENS Campaign Engine |
| May read | ENS Playback, IVR, Reporting |

**Note:** `ens_notifications` / `ens_notification_deliveries` are the legacy equivalent — read-only after Wave 1, scheduled for removal in Wave 4.

---

### ENS Notification (Delivery Record)
One outbound call attempt to one recipient as part of an ENS Campaign.

| Field | Value |
|---|---|
| Owner | ENS module |
| Source of truth | `ens_campaign_deliveries` |
| Lifecycle | pending → dialling → answered \| no_answer \| failed \| cancelled |
| May write | ENS Campaign Engine (status), Communication Engine (via session events, Wave 3) |
| May read | Reporting |

---

## ERS Objects

### ERS Configuration
The setup for one Emergency Response System service.

| Field | Value |
|---|---|
| Owner | ERS module |
| Source of truth | `ers_configurations` |
| Key fields | tier contacts/groups, conference profile, ring timeout, recording settings |
| May write | ERS module (Configuration UI) |
| May read | ERS Ring Service, ERS Internal Controller, IVR (ERS node), Reporting |

**Reserved columns (migration 027):** `max_participants`, `conference_lock`, `auto_destroy`, `allow_external`, `allow_duplicate_responders`, `moderator_required`, `bridge_timeout_sec` — provisioned but not yet enforced by application code. Must not be exposed in the UI until enforcement code is implemented.

---

### ERS Incident
An active or completed emergency response event.

| Field | Value |
|---|---|
| Owner | ERS module |
| Source of truth | `ers_incidents` |
| Lifecycle | ACTIVE → COMPLETED \| ABANDONED |
| Key fields | incident_uuid, conference_room, tier, caller_number, status, recording_path |
| May write | ERS Internal API (create), ESL event handlers (participant tracking), ERS Ring Service (recording path) |
| May read | ERS Ring Service, Reporting |

---

### ERS Participant
One person present in an ERS conference (initiator, responder, or observer). The ESL event audit trail — every join and leave, including rejoins.

| Field | Value |
|---|---|
| Owner | ERS module (written by ESL event handler `trackParticipant`) |
| Source of truth | `ers_incident_participants` |
| Lifecycle | Created on ESL add-member event. `left_at` set on del-member event. |
| May write | `trackParticipant` function in eslService.js only |
| May read | Reporting |

**Distinction from ERS Responder Leg:** Participants records every join/leave (including multiple rejoins for the same person). Responder Legs record whether the person was INVITED, answered, or missed the ring-all.

---

### ERS Responder Leg
The per-responder dispatch record: INVITED at ring-all start, updated when the responder answers or times out.

| Field | Value |
|---|---|
| Owner | ERS module (written by ERS Ring Service) |
| Source of truth | `ers_incident_responders` |
| Lifecycle | INVITED → JOINED (when participant joins) \| NO_ANSWER \| BUSY \| TIMEOUT |
| May write | ERS Ring Service |
| May read | Reporting |

---

## IVR Objects

### IVR Flow
A versioned JSONB graph of nodes defining caller interaction. Source of truth for all IVR logic.

| Field | Value |
|---|---|
| Owner | IVR module |
| Source of truth | `ivr_flows` (draft) + `ivr_flow_versions` (immutable published snapshots) |
| Lifecycle | DRAFT → PUBLISHED (immutable) → DEPLOYED → ACTIVE |
| May write | IVR Designer (draft graph), IVR Publisher (version snapshot) |
| May read | IVR Deployment Engine, Lua Executor (at call time via internal API), Reporting |

### IVR Session _(transient)_
Runtime state of one call executing through an IVR Flow. Lives in FreeSWITCH Lua session memory only.

| Field | Value |
|---|---|
| Owner | Lua Executor (transient) |
| Source of truth | None — Lua session variables only |
| May write | IVR Lua Executor only |
| May read | Nothing — internal to Lua |
