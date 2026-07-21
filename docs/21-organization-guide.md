# Organization and Contact Management Guide

## Overview

fs-enrs uses a hierarchical organizational model to scope contacts, configurations, and reporting. Understanding this hierarchy is essential for correctly assigning contacts to ENS targeting lists and ERS responder tiers.

---

## Organizational Hierarchy

```
Tenant
└── Organizations (1 or more)
    ├── Locations (buildings, floors, rooms)
    ├── Departments
    └── Emergency Contacts
        └── (may belong to Responder Groups)
```

---

## Tenant

The tenant is the top-level isolation boundary in fs-enrs. All users, configurations, IVR flows, and contacts belong to exactly one tenant.

- Created once during initial setup via the seed script
- `tenant_id` is always sourced from the authenticated JWT (`req.user.tenantId`) — it is never accepted from the request body
- Multi-tenancy is controlled by feature flag `feature_flags.multi_tenant = true`; when enabled, separate tenants share one database instance but remain fully isolated by `tenant_id` on all rows

---

## Organizations

Organizations represent legal entities, sites, or administrative groupings within a tenant.

**Base route:** `GET|POST|PUT|DELETE /api/v1/organizations`

**Required role:** ADMIN for write operations; SUPERVISOR or OPERATOR for read

**Fields:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name |
| `slug` | string | URL-safe unique identifier |
| `code` | string | Short reference code |
| `description` | string | Optional free-text description |
| `address` | string | Physical address |
| `phone` | string | Contact telephone number |
| `email` | string | Contact email address |
| `is_active` | boolean | Inactive organizations are excluded from dropdowns |

---

## Locations

Physical locations represent buildings, floors, or rooms within an organization. Locations are used for contact assignment and incident location tracking in reports.

**Fields:** `name`, `type` (building / floor / room), `address`, `organization_id`

---

## Departments

Departments represent organizational units within an organization.

**Fields:** `name`, `type`, `extension_number`, `organization_id`

Contacts can be linked to a department for organizational reporting and filtering.

---

## Emergency Contacts

Emergency contacts are the core entity for both ENS outbound targeting and ERS ring-all responder invitations.

### Key Fields

| Field | Description |
|---|---|
| `first_name`, `last_name` | Display name used in reports and monitoring UI |
| `mobile_number` | **Required.** Used for ENS outbound calling and ERS ring-all to PSTN |
| `extension_number` | Internal FreeSWITCH extension for ring-all originate via `user/` dial string |
| `internal_extension` | Legacy field — use `extension_number` for FreeSWITCH `user/` dialing |
| `gateway_id` | Optional FK to `sip_gateways` — pins this contact to a specific SIP gateway |
| `is_active` | Inactive contacts are excluded from all ENS targeting and ERS tier resolution |

### Contact Identity Matching

`trackParticipant` resolves an incoming ESL channel to a known contact using the following logic:

1. **`destNum` → `extension_number`**: exact match first; falls back to last-9-digit suffix comparison
2. **`callerNum` → `mobile_number`**: last-9-digit suffix comparison

This two-pass approach handles cases where caller ID presentation differs from the stored number format (e.g., country code prefix differences).

---

## Bulk Upload

**Endpoint:** `POST /contacts/bulk-upload`

**Content-Type:** `multipart/form-data`

**Maximum file size:** 5 MB

**Required CSV columns:**

| Column | Description |
|---|---|
| `first_name` | Contact first name |
| `last_name` | Contact last name |
| `mobile_number` | Primary call number (E.164 or local format) |

**Optional CSV columns:** `extension_number`, `email`, `role`, `location_id`, `department_id`

**Behavior:**
- Validation errors are returned per row
- Rows with validation errors are skipped; all valid rows are inserted
- A summary of inserted count and per-row errors is returned in the response

**Prerequisite:** Feature flag `csv_bulk_upload` must be enabled in `feature_flags`.

---

## Responder Groups

Responder groups are named collections of emergency contacts. Groups can be assigned to ENS configurations and ERS responder tiers, simplifying management of large contact sets.

### Group Management

| Operation | Endpoint |
|---|---|
| Create group | `POST /groups { name, description, organization_id }` |
| List groups | `GET /groups` |
| Add member | `POST /groups/:id/members { contactId }` |
| Remove member | `DELETE /groups/:id/members/:contactId` |

### Group Usage

| Context | Table | Description |
|---|---|---|
| ERS tier assignment | `ers_tier_groups` | Groups assigned to a responder tier are rung ring-all alongside individual tier contacts |
| ENS contact targeting | `ens_configuration_groups` | All active members of the group are included in the campaign destination list |

ERS responder resolution (`ersInternalController.js`) reads from both `ers_tier_contacts` (individual contacts) and `ers_tier_groups` + `responder_group_members` (group-based), then merges and deduplicates the result before returning to Lua.

---

## SIP Gateways

SIP gateways define external PSTN trunks used for outbound ENS dialing and ERS ring-all to mobile numbers.

**Endpoint:** `POST /gateways`

**Fields:**

| Field | Description |
|---|---|
| `name` | Gateway display name |
| `type` | Gateway type (e.g., `SIP`) |
| `host` | SIP server hostname or IP |
| `port` | SIP server port (default 5060) |
| `username` | SIP trunk authentication username |
| `password` | SIP trunk authentication password |
| `register` | Whether FreeSWITCH should register to this gateway |
| `is_default_outbound` | If true, this gateway is used when no `gateway_id` is set on a contact |

### Deploy Gateway

**Endpoint:** `POST /gateways/:id/deploy`

Generates a FreeSWITCH SIP profile XML file and writes it to `FS_SIP_PROFILE_DIR`. FreeSWITCH must be reloaded (`reloadxml` + `sofia profile <profile> restart`) to activate the new gateway.

### Originate Mode

The `ENS_ORIGINATE_MODE` environment variable controls how outbound calls are formatted:

| Value | Dial String Format | Use Case |
|---|---|---|
| `user` (default) | `user/{extension}` | Lab environments; internal FreeSWITCH extensions only |
| `gateway` | `sofia/gateway/{gateway_name}/{number}` | Production; PSTN calls via a registered SIP gateway |

Set `ENS_ORIGINATE_MODE=gateway` in production whenever ENS or ERS ring-all must reach mobile or PSTN numbers.
