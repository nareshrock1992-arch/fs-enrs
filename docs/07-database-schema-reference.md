# Database Schema Reference

**Database:** PostgreSQL — database name `fs_enrs`  
**Extension:** `pgcrypto` (required for `gen_random_uuid()`)

## Global Conventions

| Convention | Detail |
|---|---|
| Soft-delete | Every application table (except join/audit tables) carries `deleted_at TIMESTAMPTZ`. All queries must include `AND deleted_at IS NULL`. |
| Timestamps | `created_at` and `updated_at` default to `now()`. `updated_at` must be set on every UPDATE. |
| Tenant scope | Every configuration row must carry `tenant_id` sourced from `req.user.tenantId`. Never trust the request body for `tenant_id`. |
| Query helper | `query(sql, params)` from `src/db/pool.js` — annotates errors with `._sql` and `._params`. |
| Transactions | `withTransaction(async tq => { ... })` — `tq` is a bound `query` function running inside the transaction. |
| PG errors | `23505` unique violation and `23503` FK violation are automatically mapped to HTTP 409 by the global error handler. |

---

## Migration System

**Runner:** `backend/src/db/migrate.js`  
**Run with:** `cd backend && node src/db/migrate.js`

### Detection Logic

The runner detects database state by checking whether the `tenants` table exists in `information_schema.tables` (schema `public`).

**Fresh database** (`tenants` table absent):
1. Executes `src/db/schema.sql` — creates all base tables.
2. Records `schema.sql` as applied in `schema_migrations`.
3. Marks `001_initial_schema.sql` as already applied (it is covered by `schema.sql`).
4. Runs all numbered migrations from 002 onwards in sort order.

**Existing database** (`tenants` table present):
1. Records `schema.sql` as applied without executing it.
2. Runs only numbered migration files not yet recorded in `schema_migrations`.

### Migration File Naming

Files live in `backend/src/db/migrations/` and must follow the pattern:

```
NNN_description.sql
```

Where `NNN` is a zero-padded three-digit sequence number (e.g. `007_audio_library.sql`). The runner sorts files lexicographically — keep the prefix width consistent.

### Migration File Requirements

- Must manage their own `BEGIN` / `COMMIT` transaction.
- Must be fully idempotent: use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`.
- Must append a self-registration row:
  ```sql
  INSERT INTO schema_migrations (version) VALUES ('NNN_description.sql')
  ON CONFLICT (version) DO NOTHING;
  ```
- If a migration fails, the runner prints the error and exits with code 1. Fix the file and re-run; already-applied migrations are skipped.

### Backward Compatibility

A one-time step copies rows from the legacy `migration_log` table (if it exists) into `schema_migrations`. This runs on every migration invocation but is idempotent (`ON CONFLICT DO NOTHING`).

---

## Table Reference

Tables are organized into functional groups. Column tables use the following type abbreviations: `SERIAL` = auto-increment integer, `BIGSERIAL` = auto-increment bigint, `TIMESTAMPTZ` = timestamp with time zone.

---

## Identity and Authentication

### `schema_migrations`

Tracks which migration files have been applied. Never soft-deleted.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `version` | `VARCHAR(256)` | NO | — | PRIMARY KEY. Migration filename (e.g. `007_audio_library.sql`). |
| `applied_at` | `TIMESTAMPTZ` | NO | `now()` | — |

---

### `tenants`

Top-level multi-tenancy boundary. All configuration and user data belongs to exactly one tenant.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `name` | `VARCHAR(128)` | NO | — | Display name |
| `slug` | `VARCHAR(64)` | YES | — | UNIQUE. URL-safe identifier. |
| `code` | `VARCHAR(64)` | YES | — | UNIQUE. Short internal code. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Soft-delete:** Yes.

---

### `users`

Application user accounts. Each user belongs to one tenant and carries a role that gates API access.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `email` | `VARCHAR(255)` | NO | — | UNIQUE (table-level). |
| `password_hash` | `VARCHAR(255)` | NO | — | bcrypt hash. |
| `full_name` | `VARCHAR(128)` | NO | — | — |
| `role` | `VARCHAR(32)` | NO | `'OPERATOR'` | CHECK: `ADMIN`, `SUPERVISOR`, `OPERATOR`, `VIEWER` |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `refresh_token_hash` | `VARCHAR(255)` | YES | `NULL` | Hashed refresh token. Nulled on logout. |
| `last_login_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `failed_login_count` | `INT` | NO | `0` | Incremented on bad password. Reset on success. |
| `locked_until` | `TIMESTAMPTZ` | YES | `NULL` | Account locked until this timestamp. |
| `must_change_password` | `BOOLEAN` | NO | `false` | Forces password change on next login. |
| `password_changed_at` | `TIMESTAMPTZ` | YES | `NULL` | Last successful password change. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_users_email` | `email` | `WHERE deleted_at IS NULL` |
| `idx_users_tenant` | `tenant_id` | `WHERE deleted_at IS NULL` |

**Soft-delete:** Yes.

---

### `password_history`

Stores previous password hashes to prevent reuse. No soft-delete — rows are retained for auditing.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `user_id` | `INT` | NO | — | FK → `users(id)` ON DELETE CASCADE |
| `hash` | `VARCHAR(255)` | NO | — | bcrypt hash of a previous password. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Indexes:**

| Name | Columns |
|---|---|
| `idx_pw_history_user` | `(user_id, created_at DESC)` |

---

### `feature_flags`

Runtime on/off switches for product features. Seeded at install time; no soft-delete.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `key` | `VARCHAR(128)` | NO | — | UNIQUE. Flag identifier. |
| `description` | `TEXT` | YES | `NULL` | — |
| `is_enabled` | `BOOLEAN` | NO | `false` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Seeded flags:**

| Key | Default | Purpose |
|---|---|---|
| `ens_enabled` | `true` | Enable the Emergency Notification System. |
| `ers_enabled` | `true` | Enable the Emergency Response System. |
| `ivr_designer` | `true` | Enable the IVR visual flow editor. |
| `multi_tenant` | `false` | Multi-tenant mode. |
| `csv_bulk_upload` | `true` | Bulk contact upload via CSV. |
| `audit_logging` | `true` | Write all data changes to `audit_logs`. |

---

### `system_settings`

Key-value store for application-level configuration. No soft-delete.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `key` | `VARCHAR(128)` | NO | — | UNIQUE. Setting name. |
| `value` | `TEXT` | YES | `NULL` | String value. |
| `value_json` | `JSONB` | YES | `NULL` | Structured value (mutually exclusive with `value`). |
| `description` | `TEXT` | YES | `NULL` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

---

### `audit_logs`

Append-only record of all user-initiated mutations. No soft-delete.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `user_id` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `action` | `VARCHAR(64)` | NO | — | e.g. `CREATE`, `UPDATE`, `DELETE`, `ers_playback_attempt`. |
| `entity_type` | `VARCHAR(64)` | NO | — | Table or domain name of the affected record. |
| `entity_id` | `VARCHAR(64)` | YES | `NULL` | PK of the affected record (stored as text). |
| `details` | `JSONB` | YES | `NULL` | Before/after snapshot or additional context. |
| `ip_address` | `INET` | YES | `NULL` | Client IP. |
| `http_method` | `VARCHAR(8)` | YES | `NULL` | e.g. `POST`, `PUT`. |
| `http_path` | `VARCHAR(512)` | YES | `NULL` | Request path. |
| `user_agent` | `VARCHAR(512)` | YES | `NULL` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_audit_user` | `user_id` | `WHERE user_id IS NOT NULL` |
| `idx_audit_entity` | `(entity_type, entity_id)` | — |
| `idx_audit_time` | `created_at DESC` | — |

---

## Organization

### `organizations`

A logical unit (company, facility, or department cluster) within a tenant. Contacts, configurations, and IVR flows belong to organizations.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `name` | `VARCHAR(128)` | NO | — | — |
| `slug` | `VARCHAR(64)` | YES | `NULL` | UNIQUE. |
| `code` | `VARCHAR(64)` | YES | `NULL` | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `address` | `VARCHAR(256)` | YES | `NULL` | — |
| `phone` | `VARCHAR(32)` | YES | `NULL` | — |
| `email` | `VARCHAR(255)` | YES | `NULL` | — |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:** `idx_org_tenant` on `(tenant_id)` where `deleted_at IS NULL`.

**Soft-delete:** Yes.

---

### `tenant_mappings`

Many-to-many association between tenants and organizations. Supports multi-tenant scenarios where one organization is shared across tenants.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | NO | — | FK → `tenants(id)` ON DELETE CASCADE |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique constraint:** `(tenant_id, organization_id)`.

---

### `locations`

Physical locations within an organization (buildings, floors, rooms).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(128)` | NO | — | — |
| `building` | `VARCHAR(128)` | YES | `NULL` | — |
| `floor` | `VARCHAR(64)` | YES | `NULL` | — |
| `room` | `VARCHAR(64)` | YES | `NULL` | — |
| `address` | `VARCHAR(256)` | YES | `NULL` | — |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:** `idx_location_org` on `(organization_id)` where `deleted_at IS NULL`.

**Soft-delete:** Yes.

---

### `departments`

Operational units (departments, teams) optionally anchored to a location.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `location_id` | `INT` | YES | `NULL` | FK → `locations(id)` ON DELETE SET NULL |
| `name` | `VARCHAR(128)` | NO | — | — |
| `type` | `VARCHAR(64)` | YES | `NULL` | Free-text department type. |
| `extension` | `VARCHAR(32)` | YES | `NULL` | Direct-dial extension for the department. |
| `notes` | `TEXT` | YES | `NULL` | — |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Soft-delete:** Yes.

---

## Contacts

### `emergency_contacts`

The canonical person record for anyone who may be called (ENS blast targets) or invited to a conference (ERS responders).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `location_id` | `INT` | YES | `NULL` | FK → `locations(id)` ON DELETE SET NULL |
| `department_id` | `INT` | YES | `NULL` | FK → `departments(id)` ON DELETE SET NULL |
| `first_name` | `VARCHAR(64)` | NO | — | — |
| `last_name` | `VARCHAR(64)` | NO | — | — |
| `role` | `VARCHAR(64)` | YES | `NULL` | Job title / role label. |
| `mobile_number` | `VARCHAR(32)` | NO | — | Primary dialable number. |
| `internal_extension` | `VARCHAR(32)` | YES | `NULL` | — |
| `extension_number` | `VARCHAR(32)` | YES | `NULL` | Desk phone / SIP extension dialed alongside mobile for ENS. |
| `email` | `VARCHAR(255)` | YES | `NULL` | — |
| `gateway_id` | `INT` | YES | `NULL` | FK → `sip_gateways(id)` ON DELETE SET NULL. Per-contact gateway override; falls back to tenant default when NULL. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_contact_org` | `organization_id` | `WHERE deleted_at IS NULL` |
| `idx_contact_mobile` | `mobile_number` | `WHERE deleted_at IS NULL` |

**Soft-delete:** Yes.

**Note on dual-channel dialing:** ENS blast resolves both `mobile_number` and `extension_number` per contact and dials each as an independent delivery leg, giving each channel its own answer/retry tracking.

---

### `responder_groups`

Named collections of `emergency_contacts` used as a unit in ERS tier assignments and ENS blast targets.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Soft-delete:** Yes.

---

### `responder_group_members`

Join table linking contacts to groups. A contact may belong to multiple groups.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `responder_group_id` | `INT` | NO | — | FK → `responder_groups(id)` ON DELETE CASCADE |
| `emergency_contact_id` | `INT` | NO | — | FK → `emergency_contacts(id)` ON DELETE CASCADE |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique constraint:** `(responder_group_id, emergency_contact_id)`.

---

### `esl_connections`

FreeSWITCH ESL connection parameters. No soft-delete.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `name` | `VARCHAR(128)` | NO | — | — |
| `host` | `VARCHAR(256)` | NO | — | ESL hostname or IP. |
| `port` | `INT` | NO | `8021` | — |
| `password` | `VARCHAR(128)` | NO | `'ClueCon'` | ESL password. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `last_heartbeat_at` | `TIMESTAMPTZ` | YES | `NULL` | Updated by the heartbeat monitor. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

---

## Media

### `media_files`

Audio and media assets uploaded to the platform.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE SET NULL |
| `uploaded_by_user_id` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `type` | `VARCHAR(32)` | NO | `'RECORDING'` | CHECK: `RECORDING`, `PROMPT`, `MUSIC`, `OTHER`, `ivr_prompt` |
| `name` | `VARCHAR(255)` | NO | — | — |
| `path_or_uri` | `VARCHAR(512)` | NO | — | Filesystem path or URI. |
| `duration_seconds` | `INT` | YES | `NULL` | — |
| `size_bytes` | `BIGINT` | YES | `NULL` | — |
| `sample_rate` | `INT` | YES | `NULL` | — |
| `channels` | `INT` | YES | `NULL` | — |
| `codec` | `VARCHAR(32)` | YES | `NULL` | — |
| `bitrate_kbps` | `INT` | YES | `NULL` | — |
| `checksum` | `VARCHAR(64)` | YES | `NULL` | — |
| `version` | `INT` | YES | `NULL` | — |
| `tags` | `TEXT[]` | YES | `NULL` | — |
| `notes` | `TEXT` | YES | `NULL` | — |
| `usage_count` | `INT` | YES | `NULL` | — |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Soft-delete:** Yes.

---

### `audio_library`

Structured audio file catalog with category taxonomy. Supersedes direct `media_files` references for deployment workflows.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE SET NULL |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `name` | `VARCHAR(255)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `file_path` | `VARCHAR(512)` | NO | — | Filesystem path. |
| `file_size` | `BIGINT` | YES | `NULL` | Bytes. |
| `duration_sec` | `NUMERIC(10,2)` | YES | `NULL` | — |
| `mime_type` | `VARCHAR(64)` | NO | `'audio/wav'` | — |
| `category` | `VARCHAR(32)` | NO | `'general'` | CHECK: `general`, `announcement`, `hold_music`, `ivr_prompt`, `recording` |
| `uploaded_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:** `idx_audio_org` on `(organization_id)`, `idx_audio_tenant` on `(tenant_id)`, both where `deleted_at IS NULL`.

**Soft-delete:** Yes.

---

### `notification_templates`

Reusable message templates for ENS configurations.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE SET NULL |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `media_file_id` | `INT` | YES | `NULL` | FK → `media_files(id)` ON DELETE SET NULL |
| `text_body` | `TEXT` | YES | `NULL` | Text-to-speech message body. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Soft-delete:** Yes.

---

## SIP

### `sip_gateways`

FreeSWITCH SIP gateway definitions for outbound call routing. One tenant may have multiple gateways; at most one may be marked `is_default_outbound`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(64)` | NO | — | Must match the FreeSWITCH gateway name for `sofia/gateway/<name>/`. |
| `type` | `VARCHAR(32)` | NO | `'generic_sip'` | CHECK: `avaya`, `cisco`, `generic_sip`, `other` |
| `host` | `VARCHAR(255)` | NO | — | Gateway host / IP. |
| `port` | `INT` | NO | `5060` | SIP port. |
| `username` | `VARCHAR(128)` | YES | `NULL` | SIP registration username. |
| `password` | `VARCHAR(255)` | YES | `NULL` | SIP registration password. |
| `register` | `BOOLEAN` | NO | `true` | Whether FreeSWITCH registers to this gateway. |
| `caller_id_in_from` | `BOOLEAN` | NO | `false` | Pass caller ID in SIP `From` header. |
| `is_default_outbound` | `BOOLEAN` | NO | `false` | Default gateway for outbound calls. Enforced at application layer (not a DB unique constraint). |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `last_deployed_at` | `TIMESTAMPTZ` | YES | `NULL` | Last gateway XML deployment timestamp. |
| `last_deployment_status` | `VARCHAR(16)` | YES | `NULL` | e.g. `success`, `failed`. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Unique constraint:** `(tenant_id, name)`.  
**Index:** `idx_sip_gateways_tenant` on `(tenant_id)` where `deleted_at IS NULL`.

**Soft-delete:** Yes.

---

## IVR

### `ivr_flows`

Visual IVR call flow definitions. The `graph` JSONB stores the full node graph. Flows are identified externally by `flow_uuid` (not the `id` surrogate).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY (internal; use `flow_uuid` externally) |
| `flow_uuid` | `UUID` | NO | `gen_random_uuid()` | UNIQUE. Public identifier used in all API and deployment paths. |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `graph` | `JSONB` | NO | `'{}'` | `{ entry_node_id, nodes: { [id]: { type, label, config, next } } }` |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `updated_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_ivr_flow_tenant` | `tenant_id` | `WHERE deleted_at IS NULL` |
| `idx_ivr_flow_org` | `organization_id` | `WHERE deleted_at IS NULL` |
| `idx_ivr_flow_uuid` | `flow_uuid` | `WHERE deleted_at IS NULL` |

**Soft-delete:** Yes.

---

### `ivr_flow_versions`

Immutable published snapshots of IVR flow graphs. A new version is created each time a flow is published; existing versions are never mutated.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `version_uuid` | `UUID` | NO | `gen_random_uuid()` | UNIQUE. |
| `ivr_flow_id` | `BIGINT` | NO | — | FK → `ivr_flows(id)` ON DELETE CASCADE |
| `version_number` | `INT` | NO | `1` | Auto-incremented per flow. |
| `graph` | `JSONB` | NO | `'{}'` | Snapshot of the graph at publish time. |
| `published_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `published_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `change_notes` | `TEXT` | YES | `NULL` | Optional release notes. |

**Unique constraint:** `(ivr_flow_id, version_number)`.  
**Index:** `idx_ivr_ver_flow` on `(ivr_flow_id)`.

---

### `ivr_templates`

Pre-built IVR flow templates that can be instantiated as new flows. No soft-delete.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `slug` | `VARCHAR(64)` | NO | — | UNIQUE. |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `graph` | `JSONB` | NO | `'{}'` | Template graph structure. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

---

### `emergency_numbers`

Unified service registry. Each row maps a dialled number to a service type and its configuration. This is the single source of truth that FreeSWITCH Lua scripts query to route calls.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE SET NULL |
| `number` | `VARCHAR(32)` | NO | — | UNIQUE. The dialled PSTN/SIP number. |
| `type` | `VARCHAR(16)` | NO | `'ENS'` | CHECK: `ENS`, `ERS`, `IVR`, `REJOIN`, `OPEN_ACCESS` |
| `ens_configuration_id` | `INT` | YES | `NULL` | FK → `ens_configurations(id)` ON DELETE SET NULL |
| `ers_configuration_id` | `INT` | YES | `NULL` | FK → `ers_configurations(id)` ON DELETE SET NULL |
| `ivr_flow_id` | `BIGINT` | YES | `NULL` | FK → `ivr_flows(id)` ON DELETE SET NULL |
| `service_name` | `VARCHAR(128)` | YES | `NULL` | Display label for the service registry UI. |
| `description` | `VARCHAR(255)` | YES | `NULL` | — |
| `icon` | `VARCHAR(64)` | YES | `'shield-alert'` | UI icon name. |
| `color` | `VARCHAR(32)` | YES | `'red'` | UI accent color. |
| `sort_order` | `INT` | NO | `0` | Display order in the service registry. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_emnum_tenant` | `tenant_id` | `WHERE deleted_at IS NULL` |
| `idx_emnum_number` | `number` | `WHERE deleted_at IS NULL` |
| `idx_emnum_type` | `type` | `WHERE deleted_at IS NULL` |

**Soft-delete:** Yes.

---

## ENS (Emergency Notification System)

### `ens_configurations`

Configuration profile for one ENS service (blast line). Defines dialing behavior, rate limits, retry policy, PIN protection, and playback parameters.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `pin` | `VARCHAR(32)` | YES | `NULL` | If set, callers must enter this PIN before recording. Never returned to Lua. |
| `blast_clid` | `VARCHAR(32)` | YES | `NULL` | Caller ID shown to blast recipients. |
| `reply_clid` | `VARCHAR(32)` | YES | `NULL` | Caller ID for the callback replay number. Unique index (active configs). |
| `sip_gateway` | `VARCHAR(128)` | YES | `NULL` | Named SIP gateway for outbound calls. |
| `sip_caller_id` | `VARCHAR(64)` | YES | `NULL` | Caller ID when using SIP gateway. |
| `destination_number` | `VARCHAR(32)` | YES | `NULL` | Trigger number for the blast. Unique index (active configs). |
| `phone_number` | `VARCHAR(32)` | YES | `NULL` | Legacy alias for destination number. |
| `caller_id` | `VARCHAR(64)` | YES | `NULL` | Legacy caller ID field. |
| `max_concurrent` | `INT` | NO | `30` | Legacy concurrent call limit. |
| `max_concurrent_calls` | `INT` | NO | `30` | Effective concurrent call cap (preferred over `max_concurrent`). |
| `calls_per_second` | `NUMERIC(5,2)` | NO | `2.0` | Maximum call initiation rate. |
| `batch_size` | `INT` | NO | `30` | Contacts dialed per batch. |
| `retry_count` | `INT` | NO | `3` | Legacy retry count field. |
| `retry_delay_seconds` | `INT` | NO | `60` | Legacy retry delay field. |
| `retry_interval_sec` | `INT` | NO | `60` | Seconds between retry attempts. |
| `max_attempts` | `INT` | NO | `3` | Maximum dial attempts per contact. |
| `campaign_timeout_min` | `INT` | NO | `60` | Minutes before an in-progress campaign is force-completed. |
| `recording_retention_hours` | `INT` | NO | `24` | Hours after which the blast recording is considered expired for playback. |
| `retry_failed_only` | `BOOLEAN` | NO | `false` | When true, only retry contacts that explicitly failed (not no-answer). |
| `adaptive_throttling` | `BOOLEAN` | NO | `true` | Dynamically reduce rate on congestion signals. |
| `campaign_priority` | `INT` | NO | `5` | Priority (1–10) for campaign engine scheduling. |
| `max_active_campaigns` | `INT` | NO | `1` | Maximum simultaneously active campaigns for this configuration. |
| `no_pending_msg` | `TEXT` | YES | `NULL` | TTS or audio path played when no pending blast exists on the playback number. |
| `expiry_announcement` | `TEXT` | YES | `NULL` | TTS or audio path played when the blast recording has expired. |
| `playback_number` | `VARCHAR(32)` | YES | `NULL` | Number recipients call to hear the blast recording. |
| `template_id` | `INT` | YES | `NULL` | FK → `notification_templates(id)` ON DELETE SET NULL |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Unique indexes (conditional):**

| Name | Column | Condition |
|---|---|---|
| `idx_ens_dest_number` | `destination_number` | `WHERE deleted_at IS NULL AND is_active = true AND destination_number IS NOT NULL` |
| `idx_ens_reply_clid` | `reply_clid` | `WHERE deleted_at IS NULL AND is_active = true AND reply_clid IS NOT NULL` |

**Soft-delete:** Yes.

---

### `ens_configuration_groups`

Links an ENS configuration to one or more responder groups whose members will receive the blast.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ens_configuration_id` | `INT` | NO | — | FK → `ens_configurations(id)` ON DELETE CASCADE |
| `ens_group_id` | `INT` | YES | `NULL` | Legacy group FK (deprecated). |
| `responder_group_id` | `INT` | YES | `NULL` | FK → `responder_groups(id)` ON DELETE CASCADE |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique index:** `uidx_ens_cfg_groups_rg` on `(ens_configuration_id, responder_group_id)` where `responder_group_id IS NOT NULL`.

---

### `ens_configuration_contacts`

Links an ENS configuration to individual contacts that will receive the blast (outside of any group assignment).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ens_configuration_id` | `INT` | NO | — | FK → `ens_configurations(id)` ON DELETE CASCADE |
| `ens_contact_id` | `INT` | YES | `NULL` | Legacy contact FK (deprecated). |
| `emergency_contact_id` | `INT` | YES | `NULL` | FK → `emergency_contacts(id)` ON DELETE CASCADE |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique index:** `uidx_ens_cfg_contacts_ec` on `(ens_configuration_id, emergency_contact_id)` where `emergency_contact_id IS NOT NULL`.

---

### `ens_notifications`

One row per triggered blast event. Tracks aggregate delivery statistics and lifecycle status.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ens_configuration_id` | `INT` | NO | — | FK → `ens_configurations(id)` ON DELETE CASCADE |
| `notification_uuid` | `UUID` | NO | `gen_random_uuid()` | UNIQUE. Public identifier. |
| `triggered_via` | `VARCHAR(16)` | NO | `'PHONE'` | CHECK: `PHONE`, `UI`, `API` |
| `triggered_by_user_id` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL. Set for UI/API triggers. |
| `caller_number` | `VARCHAR(32)` | YES | `NULL` | Phone number of the caller who triggered the blast. |
| `recording_file` | `VARCHAR(512)` | YES | `NULL` | Path to the recorded blast message audio. |
| `recording_reference` | `VARCHAR(512)` | YES | `NULL` | Alternative recording reference. |
| `status` | `VARCHAR(16)` | NO | `'PENDING'` | CHECK: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `total_targets` | `INT` | NO | `0` | Total number of contacts targeted. |
| `total_answered` | `INT` | NO | `0` | Contacts that answered. |
| `total_no_answer` | `INT` | NO | `0` | Contacts that did not answer. |
| `total_replayed` | `INT` | NO | `0` | Contacts that called back to replay the recording. |
| `callback_count` | `INT` | NO | `0` | Total playback replay accesses. |
| `pin_verified_at` | `TIMESTAMPTZ` | YES | `NULL` | When the PIN was verified by the triggering caller. |
| `recorded_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL. User who recorded the message. |
| `started_at` | `TIMESTAMPTZ` | YES | `NULL` | When dialing began. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `completed_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_ens_notif_cfg` | `ens_configuration_id` | — |
| `idx_ens_notif_status` | `status` | `WHERE deleted_at IS NULL` |
| `idx_ens_notif_uuid` | `notification_uuid` | — |

**Soft-delete:** Yes.

---

### `ens_notification_deliveries`

Per-contact delivery tracking for a notification. One row per `(notification, contact_number)` pair.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ens_notification_id` | `INT` | NO | — | FK → `ens_notifications(id)` ON DELETE CASCADE |
| `contact_number` | `VARCHAR(32)` | NO | — | — |
| `delivery_status` | `VARCHAR(16)` | NO | `'PENDING'` | CHECK: `PENDING`, `DIALLING`, `ANSWERED`, `NO_ANSWER`, `FAILED`, `REPLAYED`, `CANCELLED` |
| `attempt_number` | `INT` | NO | `1` | Current attempt count. |
| `call_uuid` | `VARCHAR(64)` | YES | `NULL` | FreeSWITCH call UUID. |
| `hangup_cause` | `VARCHAR(64)` | YES | `NULL` | FreeSWITCH hangup cause string. |
| `answered_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `updated_at` | `TIMESTAMPTZ` | YES | `NULL` | — |

**Unique constraint:** `(ens_notification_id, contact_number)`.  
**Index:** `idx_delivery_notif` on `(ens_notification_id)`.

---

### `ens_campaigns`

Campaign engine records — one row per blast execution. The `id` is a UUID (primary key generated by `gen_random_uuid()`). Campaign configuration is snapshot-copied from the ENS configuration at trigger time so that in-flight campaigns are not affected by configuration changes.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `UUID` | NO | `gen_random_uuid()` | PRIMARY KEY |
| `ens_configuration_id` | `INT` | NO | — | FK → `ens_configurations(id)` |
| `organization_id` | `INT` | YES | `NULL` | FK → `organizations(id)` ON DELETE SET NULL |
| `triggered_by` | `INT` | YES | `NULL` | FK → `users(id)` ON DELETE SET NULL |
| `triggered_via` | `VARCHAR(20)` | NO | `'PHONE'` | CHECK: `PHONE`, `UI`, `API`, `SCHEDULE` |
| `trigger_number` | `VARCHAR(30)` | YES | `NULL` | Number that triggered the campaign. |
| `status` | `VARCHAR(20)` | NO | `'queued'` | CHECK: `queued`, `running`, `paused`, `completed`, `cancelled`, `failed` |
| `recording_file` | `TEXT` | YES | `NULL` | Blast message recording path. |
| `message_audio_url` | `TEXT` | YES | `NULL` | Alternative audio URL. |
| `message_text` | `TEXT` | YES | `NULL` | Text-to-speech message body. |
| `max_concurrent` | `INT` | NO | `30` | Snapshot from config at trigger time. |
| `calls_per_second` | `NUMERIC(5,2)` | NO | `2.0` | — |
| `retry_count` | `INT` | NO | `3` | — |
| `retry_interval_sec` | `INT` | NO | `300` | — |
| `max_attempts` | `INT` | NO | `4` | — |
| `retry_failed_only` | `BOOLEAN` | NO | `true` | — |
| `adaptive_throttling` | `BOOLEAN` | NO | `true` | — |
| `campaign_priority` | `INT` | NO | `5` | — |
| `campaign_timeout_min` | `INT` | NO | `60` | — |
| `sip_gateway` | `VARCHAR(100)` | YES | `NULL` | — |
| `sip_caller_id` | `VARCHAR(50)` | YES | `NULL` | — |
| `scheduled_at` | `TIMESTAMPTZ` | YES | `NULL` | Future execution time (scheduled campaigns). |
| `started_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `completed_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `total_destinations` | `INT` | NO | `0` | — |
| `queued_count` | `INT` | NO | `0` | — |
| `dialing_count` | `INT` | NO | `0` | — |
| `answered_count` | `INT` | NO | `0` | — |
| `busy_count` | `INT` | NO | `0` | — |
| `no_answer_count` | `INT` | NO | `0` | — |
| `failed_count` | `INT` | NO | `0` | — |
| `retried_count` | `INT` | NO | `0` | — |
| `completed_count` | `INT` | NO | `0` | — |
| `peak_concurrent` | `INT` | NO | `0` | Maximum simultaneous active calls observed. |
| `campaign_duration_sec` | `INT` | YES | `NULL` | Total campaign wall-clock duration. |
| `batch_size` | `INT` | YES | `NULL` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_ens_campaigns_status` | `(status, campaign_priority DESC, created_at)` | `WHERE status IN ('queued','running')` |
| `idx_ens_campaigns_config` | `(ens_configuration_id, created_at DESC)` | — |

---

### `ens_campaign_destinations`

Per-contact state machine for a campaign. One row per `(campaign_id, phone_number)` pair.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `campaign_id` | `UUID` | NO | — | FK → `ens_campaigns(id)` ON DELETE CASCADE |
| `contact_id` | `INT` | YES | `NULL` | FK → `emergency_contacts(id)` ON DELETE SET NULL |
| `phone_number` | `VARCHAR(50)` | NO | — | — |
| `contact_name` | `VARCHAR(200)` | YES | `NULL` | — |
| `status` | `VARCHAR(20)` | NO | `'queued'` | CHECK: `queued`, `dialing`, `answered`, `busy`, `no_answer`, `failed`, `completed`, `expired`, `skipped` |
| `attempt_count` | `INT` | NO | `0` | — |
| `max_attempts` | `INT` | NO | `4` | Per-destination override. |
| `queued_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `next_attempt_at` | `TIMESTAMPTZ` | YES | `NULL` | Engine-computed next dial time. |
| `last_attempt_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `answered_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `completed_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `call_uuid` | `VARCHAR(100)` | YES | `NULL` | FreeSWITCH call UUID for in-flight leg. |
| `hangup_cause` | `VARCHAR(50)` | YES | `NULL` | — |
| `error_message` | `TEXT` | YES | `NULL` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_camp_dest_campaign_status` | `(campaign_id, status)` | — |
| `idx_camp_dest_next_attempt` | `(campaign_id, next_attempt_at)` | `WHERE status = 'queued'` |
| `idx_camp_dest_call_uuid` | `call_uuid` | `WHERE call_uuid IS NOT NULL` |

---

## ERS (Emergency Response System)

### `ers_configurations`

Configuration profile for one ERS service (emergency conference bridge). Controls bridge numbers, tier responder groups, concurrency limits, queue behavior, PIN protection, and recording settings.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `organization_id` | `INT` | NO | — | FK → `organizations(id)` ON DELETE CASCADE |
| `name` | `VARCHAR(128)` | NO | — | — |
| `description` | `TEXT` | YES | `NULL` | — |
| `pin` | `VARCHAR(32)` | YES | `NULL` | If set, callers must enter this PIN. Never returned to Lua. |
| `primary_bridge_number` | `VARCHAR(32)` | YES | `NULL` | STATIC conference room name for primary tier. |
| `secondary_bridge_number` | `VARCHAR(32)` | YES | `NULL` | STATIC conference room name for secondary tier. |
| `conference_profile` | `VARCHAR(64)` | NO | `'default'` | FreeSWITCH conference profile name. |
| `primary_group_id` | `INT` | YES | `NULL` | FK → `responder_groups(id)` ON DELETE SET NULL. Legacy primary tier group. |
| `secondary_group_id` | `INT` | YES | `NULL` | FK → `responder_groups(id)` ON DELETE SET NULL. Legacy secondary tier group. |
| `max_concurrent_conferences` | `INT` | NO | `2` | Maximum simultaneous active incidents. |
| `max_conference_duration_min` | `INT` | NO | `0` | Maximum conference duration in minutes (0 = unlimited). |
| `queue_enabled` | `BOOLEAN` | NO | `true` | When true, overflow callers are queued rather than rejected. |
| `queue_announcement_audio` | `VARCHAR(512)` | YES | `NULL` | Path to queue position announcement audio. |
| `queue_music_path` | `VARCHAR(512)` | YES | `NULL` | Hold music path for queued callers. |
| `queue_hold_audio` | `VARCHAR(512)` | YES | `NULL` | On-hold audio for queued callers. |
| `queue_timeout_sec` | `INT` | NO | `0` | Seconds before a queued caller is dropped (0 = no timeout). |
| `queue_priority` | `INT` | NO | `5` | Queue priority for this configuration. |
| `record_conferences` | `BOOLEAN` | NO | `false` | Lua channel recording (record_session per leg). |
| `recording_directory` | `VARCHAR(512)` | YES | `NULL` | Filesystem directory for Lua recordings. |
| `recording_retention_hours` | `INT` | NO | `48` | — |
| `retry_ring_count` | `INT` | NO | `3` | Number of ring attempts per responder dial. |
| `retry_ring_interval` | `INT` | NO | `30` | Seconds between ring retry attempts. |
| `allow_rejoin` | `BOOLEAN` | NO | `true` | Allow responders to rejoin after leaving. |
| `cli_authentication` | `BOOLEAN` | NO | `false` | Verify caller identity against tier contact list before admitting. |
| `primary_retry_count` | `INT` | NO | `3` | Retry count for primary tier responders. |
| `primary_retry_interval_sec` | `INT` | NO | `30` | — |
| `secondary_retry_count` | `INT` | NO | `3` | — |
| `secondary_retry_interval_sec` | `INT` | NO | `30` | — |
| `emergency_number` | `VARCHAR(32)` | YES | `NULL` | Inbound emergency number (unique index on active configs). |
| `rejoin_number` | `VARCHAR(32)` | YES | `NULL` | Number responders dial to rejoin an active conference. |
| `open_access_number` | `VARCHAR(32)` | YES | `NULL` | Number for anonymous/observer join. |
| `conference_room_prefix` | `VARCHAR(64)` | YES | `NULL` | Prefix for DYNAMIC conference room names. |
| `ring_timeout_seconds` | `INT` | YES | `NULL` | Overall ring-all timeout; NULL means ring indefinitely (capped internally). |
| `conference_type` | `VARCHAR(16)` | NO | `'STATIC'` | CHECK: `STATIC`, `DYNAMIC`. DYNAMIC generates unique room names per incident. |
| `recording_enabled` | `BOOLEAN` | NO | `false` | Backend-driven ESL conference recording (distinct from `record_conferences`). |
| `recording_mode` | `VARCHAR(16)` | NO | `'MANUAL'` | CHECK: `AUTO`, `MANUAL`. AUTO issues ESL `conference record` at the trigger point. |
| `recording_trigger` | `VARCHAR(32)` | NO | `'CONFERENCE_CREATED'` | CHECK: `CONFERENCE_CREATED`, `FIRST_PARTICIPANT`, `MODERATOR_JOIN` |
| `recording_format` | `VARCHAR(8)` | NO | `'wav'` | — |
| `max_participants` | `INT` | NO | `0` | Maximum conference participants (0 = unlimited, reserved). |
| `conference_lock` | `BOOLEAN` | NO | `false` | Lock after moderator joins (reserved). |
| `auto_destroy` | `BOOLEAN` | NO | `true` | Auto-destroy empty conference (reserved). |
| `allow_external` | `BOOLEAN` | NO | `false` | Allow non-configured participants (reserved). |
| `allow_duplicate_responders` | `BOOLEAN` | NO | `false` | Allow same responder to join more than once (reserved). |
| `moderator_required` | `BOOLEAN` | NO | `false` | Require moderator before conference becomes audible (reserved). |
| `bridge_timeout_sec` | `INT` | NO | `0` | Seconds to wait for first participant before teardown (0 = disabled, reserved). |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Unique index:** `idx_ers_emergency_number` on `(emergency_number)` where `deleted_at IS NULL AND is_active = true AND emergency_number IS NOT NULL`.

**Soft-delete:** Yes.

---

### `ers_tier_groups`

Associates a responder group with a tier (primary or secondary) for an ERS configuration.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `ers_configuration_id` | `INT` | NO | — | FK → `ers_configurations(id)` ON DELETE CASCADE |
| `tier` | `VARCHAR(10)` | NO | — | CHECK: `primary`, `secondary` |
| `group_id` | `INT` | NO | — | FK → `responder_groups(id)` ON DELETE CASCADE |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique constraint:** `(ers_configuration_id, tier, group_id)`.  
**Index:** `idx_ers_tier_groups_config` on `(ers_configuration_id)`.

---

### `ers_tier_contacts`

Associates individual contacts directly with a tier for an ERS configuration. Merged with `ers_tier_groups` at ring-all time; duplicates are deduplicated by mobile number.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `ers_configuration_id` | `INT` | NO | — | FK → `ers_configurations(id)` ON DELETE CASCADE |
| `tier` | `VARCHAR(10)` | NO | — | CHECK: `primary`, `secondary` |
| `contact_id` | `INT` | NO | — | FK → `emergency_contacts(id)` ON DELETE CASCADE |
| `priority` | `INT` | NO | `1` | Ring priority (lower = higher priority, reserved). |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique constraint:** `(ers_configuration_id, tier, contact_id)`.  
**Index:** `idx_ers_tier_contacts_config_tier` on `(ers_configuration_id, tier)`.

---

### `ers_incidents`

One row per emergency conference incident. An incident represents a single caller-initiated emergency event from the moment the conference is created until it ends.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ers_configuration_id` | `INT` | NO | — | FK → `ers_configurations(id)` ON DELETE CASCADE |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE SET NULL |
| `incident_uuid` | `UUID` | NO | `gen_random_uuid()` | UNIQUE. Public identifier. |
| `emergency_call_number` | `VARCHAR(32)` | YES | `NULL` | The emergency number dialled by the initiating caller. |
| `conference_id` | `VARCHAR(128)` | YES | `NULL` | FreeSWITCH internal conference ID. |
| `caller_number` | `VARCHAR(32)` | YES | `NULL` | Initiating caller's number. |
| `caller_name` | `VARCHAR(128)` | YES | `NULL` | Initiating caller's display name. |
| `conference_room` | `VARCHAR(128)` | YES | `NULL` | FreeSWITCH conference room name. |
| `group_type` | `VARCHAR(16)` | YES | `NULL` | CHECK: `primary`, `secondary`. Which tier was activated. |
| `tier_group_id` | `INT` | YES | `NULL` | FK → `ers_tier_groups(id)` ON DELETE SET NULL. Specific tier group definition used. |
| `recording_path` | `VARCHAR(512)` | YES | `NULL` | Filesystem path to the conference recording. |
| `status` | `VARCHAR(16)` | NO | `'ACTIVE'` | CHECK: `ACTIVE`, `COMPLETED`, `QUEUED`, `FAILED`, `CANCELLED` |
| `started_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `ended_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `queued_at` | `TIMESTAMPTZ` | YES | `NULL` | When the incident was queued (overflow). |
| `dequeued_at` | `TIMESTAMPTZ` | YES | `NULL` | When the incident was promoted from queue. |
| `cancelled_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_incident_cfg` | `ers_configuration_id` | — |
| `idx_incident_status` | `status` | `WHERE deleted_at IS NULL` |
| `idx_incident_tenant` | `tenant_id` | `WHERE deleted_at IS NULL` |
| `idx_ers_incidents_conference_room` | `conference_room` | — |
| `idx_ers_incidents_config_tier_status` | `(ers_configuration_id, group_type, status)` | — |

**Soft-delete:** Yes.

---

### `ers_incident_responders`

Authoritative dispatch record for each responder invited to an incident. Tracks invitation, join, leave, and rejoin events.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ers_incident_id` | `INT` | NO | — | FK → `ers_incidents(id)` ON DELETE CASCADE |
| `emergency_contact_id` | `INT` | NO | — | FK → `emergency_contacts(id)`. NOT NULL — every row must resolve to a known contact. |
| `join_time` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `leave_time` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `call_uuid` | `VARCHAR(64)` | YES | `NULL` | FreeSWITCH call UUID. |
| `joined_via` | `VARCHAR(32)` | YES | `NULL` | e.g. `ring_all`, `rejoin`, `observer`. |
| `rejoin_count` | `INT` | NO | `0` | Incremented on each REJOINED status transition. |
| `mobile_number` | `VARCHAR(32)` | YES | `NULL` | Responder mobile number (normalized). |
| `status` | `VARCHAR(16)` | NO | `'INVITED'` | CHECK: `INVITED`, `JOINED`, `MISSED`, `REJOINED`, `OBSERVER` |

**Unique constraint:** `(ers_incident_id, mobile_number)` — prevents duplicate rows when the same responder is invited multiple times.

---

### `ers_incident_participants`

Detailed event audit trail for every leg that joined a conference. Supports multiple join/leave/rejoin cycles per person. Used by reporting (GET /reports/ers-incidents) to produce per-participant timelines.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `BIGSERIAL` | NO | — | PRIMARY KEY |
| `incident_id` | `INT` | NO | — | FK → `ers_incidents(id)` ON DELETE CASCADE |
| `contact_id` | `INT` | YES | `NULL` | FK → `emergency_contacts(id)` ON DELETE SET NULL. NULL for anonymous participants. |
| `raw_number` | `VARCHAR(32)` | YES | `NULL` | Caller/responder number when not a known contact. |
| `role` | `VARCHAR(16)` | NO | `'responder'` | CHECK: `initiator`, `responder` |
| `joined_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `left_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `rejoined_at` | `TIMESTAMPTZ` | YES | `NULL` | Set on each subsequent rejoin; `left_at`/`joined_at` track the current leg. |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Index:** `idx_ers_participants_incident` on `(incident_id)`.

---

### `ers_queues`

Queue entry for an overflow incident (all conference slots occupied). One row per queued incident; when a slot frees, `completeIncidentCore` promotes the highest-priority entry.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `ers_configuration_id` | `INT` | NO | — | FK → `ers_configurations(id)` ON DELETE CASCADE |
| `incident_id` | `INT` | NO | — | FK → `ers_incidents(id)` ON DELETE SET NULL |
| `position` | `INT` | NO | `1` | Queue position (lower = earlier). |
| `status` | `VARCHAR(16)` | NO | `'QUEUED'` | CHECK: `QUEUED`, `DEQUEUED`, `CANCELLED` |
| `caller_number` | `VARCHAR(32)` | YES | `NULL` | Queued caller's number. |
| `caller_name` | `VARCHAR(128)` | YES | `NULL` | Queued caller's display name. |
| `destination_number` | `VARCHAR(32)` | YES | `NULL` | Emergency number the caller dialled. |
| `queued_reason` | `VARCHAR(64)` | YES | `NULL` | e.g. `all_slots_occupied`. |
| `dequeued_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `cancelled_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |

**Unique constraint:** `(incident_id)` — one queue entry per incident.

---

### `ers_playback_lines`

Authorized playback line (observer/UUUU number). Callers on the authorized list may dial in to hear the current conference audio without appearing as a responder.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `SERIAL` | NO | — | PRIMARY KEY |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)` ON DELETE CASCADE |
| `ers_configuration_id` | `INT` | YES | `NULL` | FK → `ers_configurations(id)` ON DELETE CASCADE |
| `authorized_callers` | `TEXT[]` | NO | `'{}'` | Array of normalized phone numbers permitted to access playback. |
| `message_recording_path` | `VARCHAR(512)` | YES | `NULL` | Path to message to play on the line. |
| `message_started_at` | `TIMESTAMPTZ` | YES | `NULL` | Last recording start time; message expires at `message_started_at + 24h`. |
| `is_active` | `BOOLEAN` | NO | `true` | — |
| `created_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NO | `now()` | — |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Index:** `idx_ers_playback_lines_tenant` on `(tenant_id)` where `deleted_at IS NULL`.

**Soft-delete:** Yes.

---

### `recordings`

Unified recording table for ERS conferences, ENS blast messages, IVR sessions, and manual operator-initiated recordings. Renamed from `conference_recordings` in migration 026.

**Path conventions by type:**

| Type | Path Pattern |
|---|---|
| ERS | `recordings/ers/{YYYY}/{MM}/ers_{room}_{ts}.wav` |
| ENS | `recordings/ens/{YYYY}/{MM}/ens_{id}_{ts}.wav` |
| IVR | `recordings/ivr/{YYYY}/{MM}/ivr_{id}_{ts}.wav` |
| MANUAL | `recordings/manual/{YYYY}/{MM}/conf_{room}_{ts}.wav` |

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `UUID` | NO | `gen_random_uuid()` | PRIMARY KEY |
| `conference_room` | `VARCHAR(128)` | YES | `NULL` | FreeSWITCH conference room name. NULL for Lua record_session recordings. |
| `incident_uuid` | `UUID` | YES | `NULL` | FK → `ers_incidents(incident_uuid)`. Set for ERS recordings. |
| `ers_configuration_id` | `INT` | YES | `NULL` | FK → `ers_configurations(id)`. |
| `recording_path` | `TEXT` | NO | — | UNIQUE. Canonical filesystem path (dedup key). |
| `recording_file` | `TEXT` | YES | — | Generated column alias for `recording_path`. |
| `file_size_bytes` | `BIGINT` | YES | `NULL` | — |
| `duration_sec` | `NUMERIC(10,2)` | YES | `NULL` | — |
| `status` | `VARCHAR(16)` | NO | — | CHECK: `RECORDING`, `COMPLETED`, `ARCHIVED`, `FAILED` |
| `started_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `ended_at` | `TIMESTAMPTZ` | YES | `NULL` | — |
| `created_by` | `VARCHAR(64)` | YES | `NULL` | e.g. `lua`, user ID, `esl`. |
| `tenant_id` | `INT` | YES | `NULL` | FK → `tenants(id)`. |
| `recording_type` | `VARCHAR(16)` | NO | `'ERS'` | CHECK: `ERS`, `ENS`, `IVR`, `MANUAL` |
| `campaign_id` | `UUID` | YES | `NULL` | ENS: `ens_notifications.notification_uuid`. |
| `ivr_session_id` | `TEXT` | YES | `NULL` | IVR session reference (future). |
| `relative_path` | `TEXT` | YES | `NULL` | Path relative to `RECORDINGS_BASE`. |
| `original_path` | `TEXT` | YES | `NULL` | FS path as written by FreeSWITCH before any move. |
| `waveform_peaks` | `JSONB` | YES | `NULL` | Pre-computed waveform peak data for UI rendering. |
| `participants` | `JSONB` | YES | `NULL` | Participant snapshot: `[{id, callerNum, callerName, joinedAt, leftAt}]`. |
| `conference_name` | `TEXT` | YES | — | Generated column: always equals `conference_room`. |
| `deleted_at` | `TIMESTAMPTZ` | YES | `NULL` | Soft-delete sentinel. |

**Indexes:**

| Name | Columns | Condition |
|---|---|---|
| `idx_recordings_type` | `recording_type` | `WHERE deleted_at IS NULL` |
| `idx_recordings_incident` | `incident_uuid` | `WHERE incident_uuid IS NOT NULL AND deleted_at IS NULL` |
| `idx_recordings_campaign` | `campaign_id` | `WHERE campaign_id IS NOT NULL AND deleted_at IS NULL` |
| `idx_recordings_tenant_ts` | `(tenant_id, started_at DESC)` | `WHERE deleted_at IS NULL` |

**Soft-delete:** Yes.
