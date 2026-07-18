# 06 — Database Documentation

## Connection

- **Driver:** `pg` (node-postgres) — pool via `src/db/pool.js`
- **Database:** `fs_enrs` (default) — overridden by `DB_NAME` env var
- **Pattern:** All queries use `query(sql, params)` or `withTransaction(async tq => {...})`
- **Soft-delete:** Every table has `deleted_at TIMESTAMPTZ DEFAULT NULL`. Active rows always need `AND deleted_at IS NULL`.

---

## Migration System

```
backend/src/db/
  schema.sql            Full schema for fresh installs (covers migrations 001–005)
  migrate.js            Runner — auto-detects fresh vs existing DB
  migrations/
    006_*.sql … 027_*.sql   Numbered, idempotent, self-contained BEGIN/COMMIT blocks
```

Fresh installs: `migrate.js` applies `schema.sql`, marks migrations 001–005 as applied, then runs 006–027.  
Upgrades: skips `schema.sql`, runs only unapplied numbered migrations.

---

## Tables

### `tenants`
Multi-tenancy root. Created by schema.sql.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `name` | VARCHAR(255) | |
| `subdomain` | VARCHAR(100) UNIQUE | |
| `is_active` | BOOLEAN | DEFAULT true |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | Soft-delete |

---

### `users`
Application accounts. One tenant → many users.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK → tenants | |
| `email` | VARCHAR(255) UNIQUE | |
| `password_hash` | VARCHAR(255) | bcrypt |
| `role` | VARCHAR(50) | ADMIN / SUPERVISOR / OPERATOR / VIEWER |
| `first_name` | VARCHAR(100) | |
| `last_name` | VARCHAR(100) | |
| `is_active` | BOOLEAN | DEFAULT true |
| `last_login_at` | TIMESTAMPTZ | |
| `refresh_token_hash` | VARCHAR(255) | Hashed refresh token |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `organizations`
Customer organisations. Contacts and configurations belong to an org.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK → tenants | |
| `name` | VARCHAR(255) | |
| `code` | VARCHAR(50) | Short org code |
| `address` | TEXT | |
| `phone` | VARCHAR(50) | |
| `email` | VARCHAR(255) | |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `organization_locations`
Physical sites within an organisation.

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `organization_id` | INT FK → organizations |
| `name` | VARCHAR(255) |
| `address` | TEXT |
| `created_at` | TIMESTAMPTZ |
| `deleted_at` | TIMESTAMPTZ |

---

### `organization_departments`

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `organization_id` | INT FK → organizations |
| `name` | VARCHAR(255) |
| `created_at` | TIMESTAMPTZ |
| `deleted_at` | TIMESTAMPTZ |

---

### `emergency_contacts`
Directory of people who can be reached. Used by ERS responder lists, ENS contact lists, and the campaign engine.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `organization_id` | INT FK → organizations | |
| `first_name` | VARCHAR(100) | |
| `last_name` | VARCHAR(100) | |
| `extension_number` | VARCHAR(50) | Internal SIP extension |
| `mobile_number` | VARCHAR(50) | E.164 mobile |
| `email` | VARCHAR(255) | |
| `department` | VARCHAR(100) | |
| `location` | VARCHAR(100) | |
| `gateway_id` | INT FK → sip_gateways | Per-contact gateway override |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `responder_groups`
Named group of contacts. Assigned to ERS tiers.

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `tenant_id` | UUID FK |
| `name` | VARCHAR(255) |
| `description` | TEXT |
| `organization_id` | INT FK → organizations |
| `created_at` | TIMESTAMPTZ |
| `deleted_at` | TIMESTAMPTZ |

---

### `responder_group_members`
Join table: group ↔ contact (many-to-many).

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `responder_group_id` | INT FK → responder_groups |
| `emergency_contact_id` | INT FK → emergency_contacts |
| `created_at` | TIMESTAMPTZ |

---

### `ens_configurations`
ENS (Emergency Notification System) broadcast configuration.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `organization_id` | INT FK | |
| `name` | VARCHAR(255) | |
| `description` | TEXT | |
| `pin` | VARCHAR(20) | Raw PIN — never returned to Lua directly |
| `no_pending_msg` | TEXT | TTS when no active broadcast |
| `expiry_announcement` | TEXT | TTS when broadcast expired |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `ens_configuration_contacts`
Join table: ENS config ↔ contacts (direct members).

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `ens_configuration_id` | INT FK → ens_configurations |
| `emergency_contact_id` | INT FK → emergency_contacts |

---

### `ens_configuration_groups`
Join table: ENS config ↔ responder groups.

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `ens_configuration_id` | INT FK → ens_configurations |
| `responder_group_id` | INT FK → responder_groups |

---

### `ers_configurations`
ERS (Emergency Response System) conference configuration. Single source of truth for all conference behaviour after migration 027.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | SERIAL PK | | |
| `tenant_id` | UUID FK | | |
| `organization_id` | INT FK | | |
| `name` | VARCHAR(255) | | |
| `description` | TEXT | | |
| `primary_bridge_number` | VARCHAR(50) | | STATIC mode conference room |
| `secondary_bridge_number` | VARCHAR(50) | | STATIC secondary room |
| `conference_profile` | VARCHAR(100) | `'default'` | FS profile name — sanitized by `getConferenceProfile()` before use |
| `conference_type` | VARCHAR(20) | `'STATIC'` | `STATIC` or `DYNAMIC` |
| `max_concurrent_conferences` | INT | 2 | Bridge slots before queue |
| `queue_enabled` | BOOLEAN | true | |
| `queue_max_size` | INT | 10 | |
| `ring_timeout_seconds` | INT | NULL | NULL = 2h safety cap |
| `record_conferences` | BOOLEAN | false | Legacy Lua-side recording flag |
| `recording_directory` | TEXT | NULL | Override path for recordings |
| `recording_enabled` | BOOLEAN | false | ESL auto-recording flag (migration 027) |
| `recording_mode` | VARCHAR(20) | `'MANUAL'` | `AUTO` or `MANUAL` |
| `recording_trigger` | VARCHAR(30) | `'CONFERENCE_CREATED'` | `CONFERENCE_CREATED`, `FIRST_PARTICIPANT`, `MODERATOR_JOIN` |
| `recording_format` | VARCHAR(8) | `'wav'` | File extension |
| `max_participants` | INT | 0 | 0 = unlimited (reserved) |
| `conference_lock` | BOOLEAN | false | Reserved |
| `auto_destroy` | BOOLEAN | true | Reserved |
| `allow_external` | BOOLEAN | false | Reserved |
| `allow_duplicate_responders` | BOOLEAN | false | Reserved |
| `moderator_required` | BOOLEAN | false | Reserved |
| `bridge_timeout_sec` | INT | 0 | Reserved |
| `is_active` | BOOLEAN | true | |
| `created_at` | TIMESTAMPTZ | | |
| `updated_at` | TIMESTAMPTZ | | |
| `deleted_at` | TIMESTAMPTZ | | |

---

### `ers_tier_contacts`
Direct contact assignments to ERS tiers (individual, not group).

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `ers_configuration_id` | INT FK | |
| `emergency_contact_id` | INT FK | |
| `tier` | VARCHAR(20) | `'primary'` or `'secondary'` |
| `sort_order` | INT | |
| `created_at` | TIMESTAMPTZ | |

---

### `ers_tier_groups`
Group assignments to ERS tiers.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `ers_configuration_id` | INT FK | |
| `group_id` | INT FK → responder_groups | |
| `tier` | VARCHAR(20) | `'primary'` or `'secondary'` |
| `created_at` | TIMESTAMPTZ | |

---

### `ers_incidents`
One row per emergency conference session.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `uuid` | UUID UNIQUE | Public reference ID |
| `tenant_id` | UUID FK | |
| `ers_configuration_id` | INT FK | |
| `caller_number` | VARCHAR(50) | Inbound ANI |
| `caller_name` | VARCHAR(100) | Looked up from directory |
| `conference_room` | VARCHAR(100) | FS conference name |
| `group_type` | VARCHAR(20) | `'primary'` or `'secondary'` |
| `status` | VARCHAR(20) | `ACTIVE`, `QUEUED`, `COMPLETED`, `CANCELLED` |
| `recording_path` | TEXT | File path on FS server |
| `queue_position` | INT | Set when status = QUEUED |
| `started_at` | TIMESTAMPTZ | |
| `ended_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `ers_incident_responders`
Per-responder invitation and answer log per incident.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `incident_id` | INT FK → ers_incidents | |
| `emergency_contact_id` | INT FK | May be NULL for unresolved numbers |
| `responder_number` | VARCHAR(50) | Dialed/joined number |
| `status` | VARCHAR(20) | `INVITED`, `ANSWERED`, `NO_ANSWER`, `FAILED` |
| `invited_at` | TIMESTAMPTZ | |
| `answered_at` | TIMESTAMPTZ | |
| `joined_via` | VARCHAR(50) | `ring_all`, `direct_dial`, `ivr_transfer` |
| `created_at` | TIMESTAMPTZ | |

---

### `ers_incident_observers`
Non-responder listeners (open-access joins).

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `incident_id` | INT FK |
| `observer_number` | VARCHAR(50) |
| `joined_at` | TIMESTAMPTZ |

---

### `ers_queue`
Queue entries for overflow callers (third-slot+).

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `uuid` | UUID UNIQUE | |
| `tenant_id` | UUID FK | |
| `ers_configuration_id` | INT FK | |
| `caller_number` | VARCHAR(50) | |
| `position` | INT | |
| `status` | VARCHAR(20) | `WAITING`, `DEQUEUED`, `CANCELLED` |
| `enqueued_at` | TIMESTAMPTZ | |
| `dequeued_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

---

### `ens_campaigns`
One campaign row per ENS broadcast initiated from Lua.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `uuid` | UUID UNIQUE | |
| `tenant_id` | UUID FK | |
| `ens_configuration_id` | INT FK | |
| `campaign_name` | VARCHAR(255) | Auto-generated or provided |
| `recording_file` | TEXT | Path to caller's message |
| `caller_number` | VARCHAR(50) | Who initiated the blast |
| `status` | VARCHAR(20) | `PENDING`, `RUNNING`, `COMPLETED`, `CANCELLED`, `PAUSED` |
| `total_contacts` | INT | |
| `delivered_count` | INT | |
| `failed_count` | INT | |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `ens_campaign_destinations`
One row per contact in a campaign. Updated by `campaignEngine.js` and Lua callbacks.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `campaign_id` | INT FK → ens_campaigns | |
| `emergency_contact_id` | INT FK | |
| `phone_number` | VARCHAR(50) | Snapshot at time of creation |
| `status` | VARCHAR(20) | `PENDING`, `CALLING`, `DELIVERED`, `FAILED`, `SKIPPED` |
| `attempt_count` | INT | |
| `last_attempted_at` | TIMESTAMPTZ | |
| `answered_at` | TIMESTAMPTZ | |
| `hangup_cause` | VARCHAR(50) | FS hangup cause on failure |
| `created_at` | TIMESTAMPTZ | |

---

### `emergency_numbers`
Service registry — maps dialed number → service type + configuration. The Lua lookup entry point.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `number` | VARCHAR(50) | Dialed number / extension |
| `type` | VARCHAR(20) | `ENS`, `ERS`, `IVR`, `REJOIN`, `OPEN_ACCESS` |
| `description` | TEXT | |
| `ers_configuration_id` | INT FK | Set when type = ERS |
| `ens_configuration_id` | INT FK | Set when type = ENS |
| `ivr_flow_id` | UUID FK → ivr_flows | Set when type = IVR |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `ivr_flows`
IVR flow graph (working copy). Published snapshots go to `ivr_flow_versions`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `tenant_id` | UUID FK | |
| `name` | VARCHAR(255) | |
| `description` | TEXT | |
| `graph` | JSONB | `{ entry_node_id, nodes: { [id]: { type, label, config, next } } }` |
| `last_published_version` | INT | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `ivr_flow_versions`
Immutable published snapshots. Once created, never modified.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `flow_id` | UUID FK → ivr_flows | |
| `version` | INT | Monotonically increasing per flow |
| `graph` | JSONB | Snapshot of graph at publish time |
| `change_notes` | TEXT | |
| `published_by` | INT FK → users | |
| `published_at` | TIMESTAMPTZ | |

---

### `ivr_flow_deployments`
Deployment history per flow.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `flow_id` | UUID FK | |
| `version` | INT | Version number deployed |
| `lua_path` | TEXT | Written Lua file path |
| `xml_path` | TEXT | Written dialplan XML path |
| `deployed_by` | INT FK → users | |
| `deployed_at` | TIMESTAMPTZ | |
| `status` | VARCHAR(20) | `SUCCESS`, `FAILED` |
| `error_message` | TEXT | |

---

### `recordings`
Unified recording table (renamed from `conference_recordings` in migration 026).

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `recording_type` | VARCHAR(20) | `ERS`, `ENS`, `IVR`, `MANUAL` |
| `file_path` | TEXT | Absolute path on FS server |
| `file_name` | VARCHAR(255) | |
| `file_size` | BIGINT | bytes |
| `duration_seconds` | INT | |
| `conference_room` | VARCHAR(100) | |
| `incident_id` | INT FK → ers_incidents | |
| `campaign_id` | INT FK → ens_campaigns | |
| `status` | VARCHAR(20) | `ACTIVE`, `ARCHIVED` |
| `waveform_peaks` | JSONB | Cached peak data for waveform visualizer |
| `tags` | TEXT[] | |
| `notes` | TEXT | |
| `recorded_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `audio_library`
Audio files deployed to FreeSWITCH sounds directory.

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `tenant_id` | UUID FK |
| `file_name` | VARCHAR(255) |
| `original_name` | VARCHAR(255) |
| `file_path` | TEXT |
| `category` | VARCHAR(100) |
| `description` | TEXT |
| `deployed` | BOOLEAN |
| `deployed_at` | TIMESTAMPTZ |
| `created_at` | TIMESTAMPTZ |
| `deleted_at` | TIMESTAMPTZ |

---

### `media_files`
Enterprise media library (superset of audio_library).

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `file_name` | VARCHAR(255) | |
| `original_name` | VARCHAR(255) | |
| `file_path` | TEXT | |
| `mime_type` | VARCHAR(100) | |
| `file_size` | BIGINT | |
| `duration_seconds` | INT | |
| `category` | VARCHAR(100) | |
| `description` | TEXT | |
| `tags` | TEXT[] | |
| `waveform_peaks` | JSONB | |
| `deployed` | BOOLEAN | |
| `deployed_path` | TEXT | |
| `deployed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `sip_gateways`
SIP trunk / gateway configuration.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `tenant_id` | UUID FK | |
| `name` | VARCHAR(255) | |
| `host` | VARCHAR(255) | SIP server hostname or IP |
| `username` | VARCHAR(100) | |
| `password` | VARCHAR(255) | Stored plaintext (no external exposure) |
| `register` | BOOLEAN | Whether FS should register this gateway |
| `proxy` | VARCHAR(255) | Optional outbound proxy |
| `port` | INT | DEFAULT 5060 |
| `codec` | VARCHAR(100) | e.g. `PCMA,PCMU` |
| `is_active` | BOOLEAN | |
| `deployed` | BOOLEAN | Whether XML has been written to FS |
| `deployed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | |

---

### `system_settings`
Key-value store for global configuration. Mutable by ADMIN via `PUT /api/v1/settings/:key`.

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `key` | VARCHAR(100) UNIQUE |
| `value` | TEXT |
| `description` | TEXT |
| `created_at` | TIMESTAMPTZ |
| `updated_at` | TIMESTAMPTZ |

Common keys: `test_mode`, `test_mode_caller_id`, `tts_engine`, `tts_voice`

---

### `feature_flags`

| Column | Type |
|---|---|
| `id` | SERIAL PK |
| `key` | VARCHAR(100) UNIQUE |
| `is_enabled` | BOOLEAN |
| `description` | TEXT |
| `created_at` | TIMESTAMPTZ |
| `updated_at` | TIMESTAMPTZ |

---

### `applied_migrations`
Migration runner bookkeeping. Never modified manually.

| Column | Type |
|---|---|
| `id` | VARCHAR(50) PK |
| `applied_at` | TIMESTAMPTZ |

---

## Key Relationships

```
tenants
  └── users
  └── organizations
        └── organization_locations
        └── organization_departments
        └── emergency_contacts ──┐
        └── responder_groups     │
              └── responder_group_members → emergency_contacts
  └── ens_configurations
        └── ens_configuration_contacts → emergency_contacts
        └── ens_configuration_groups → responder_groups
        └── ens_campaigns
              └── ens_campaign_destinations → emergency_contacts
  └── ers_configurations
        └── ers_tier_contacts → emergency_contacts
        └── ers_tier_groups → responder_groups
        └── ers_incidents
              └── ers_incident_responders → emergency_contacts
              └── ers_incident_observers
        └── ers_queue
  └── emergency_numbers → (ers_configurations | ens_configurations | ivr_flows)
  └── ivr_flows
        └── ivr_flow_versions
        └── ivr_flow_deployments
  └── recordings → (ers_incidents | ens_campaigns)
  └── media_files
  └── audio_library
  └── sip_gateways ← emergency_contacts (per-contact gateway override)
```

---

## Common Query Patterns

### Tenant-scoped list
```sql
SELECT * FROM ers_configurations
WHERE tenant_id = $1 AND deleted_at IS NULL
ORDER BY created_at DESC;
```

### Resolve ERS responders (both direct + group)
```sql
SELECT DISTINCT ec.id, ec.first_name, ec.last_name, ec.mobile_number, ec.extension_number
FROM emergency_contacts ec
WHERE ec.deleted_at IS NULL AND ec.is_active = true
  AND (
    ec.id IN (
      SELECT contact_id FROM ers_tier_contacts
      WHERE ers_configuration_id = $1 AND tier = $2
    )
    OR ec.id IN (
      SELECT rgm.emergency_contact_id
      FROM responder_group_members rgm
      JOIN ers_tier_groups etg ON etg.group_id = rgm.responder_group_id
      WHERE etg.ers_configuration_id = $1 AND etg.tier = $2
    )
  );
```

### Service lookup (Lua entry point)
```sql
SELECT en.type, en.ers_configuration_id, en.ens_configuration_id, en.ivr_flow_id,
       ec.name, ec.conference_type, ...
FROM emergency_numbers en
LEFT JOIN ers_configurations ec ON ec.id = en.ers_configuration_id
WHERE en.number = $1 AND en.is_active = true AND en.deleted_at IS NULL
  AND en.tenant_id = $2
LIMIT 1;
```

### Upsert recording from ESL event
```sql
INSERT INTO recordings (tenant_id, recording_type, file_path, ...)
VALUES ($1, $2, $3, ...)
ON CONFLICT (file_path) DO UPDATE SET ...;
```

---

## Indexes

Key indexes created by migrations (partial list):

| Table | Index | Columns |
|---|---|---|
| `users` | `users_email_idx` | `email` |
| `emergency_contacts` | `contacts_extension_idx` | `extension_number` |
| `emergency_contacts` | `contacts_mobile_idx` | `mobile_number` |
| `emergency_numbers` | `en_number_tenant_idx` | `(number, tenant_id)` |
| `ers_incidents` | `incidents_uuid_idx` | `uuid` |
| `ers_incidents` | `incidents_config_status_idx` | `(ers_configuration_id, status)` |
| `ens_campaigns` | `campaigns_config_status_idx` | `(ens_configuration_id, status)` |
| `ens_campaign_destinations` | `dest_campaign_status_idx` | `(campaign_id, status)` |
| `ivr_flows` | `ivr_tenant_idx` | `tenant_id` |
| `recordings` | `recordings_conf_room_idx` | `conference_room` |
