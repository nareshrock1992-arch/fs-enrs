# Database Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Core Conventions

### Soft Delete

All tables that represent business objects use soft delete:

```sql
deleted_at TIMESTAMPTZ
```

Every query must include `AND deleted_at IS NULL`. Hard deletes are never used on business tables. An admin `PURGE` operation (future) will hard-delete rows older than a configurable retention window.

### Tenant Isolation

Every configuration and event table has `tenant_id INT NOT NULL REFERENCES tenants(id)`. Queries in controller code must always include `AND tenant_id = req.user.tenantId`. The ORM layer does not enforce this automatically — it is a code convention enforced at code review.

Row-level security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) would make this automatic, but has not been applied. This is acceptable for the current deployment model (single-tenant deployments per installation are the norm). Multi-tenant SaaS deployment would require RLS before shipping.

### Timestamps

All tables have:

```sql
created_at TIMESTAMPTZ DEFAULT now()
updated_at TIMESTAMPTZ DEFAULT now()  -- updated via trigger
```

The `updated_at` trigger is applied in `001_initial_schema.sql`. New tables added in later migrations must explicitly add the trigger.

### UUID vs SERIAL

- **Primary keys:** Mix of `SERIAL` (older tables) and `UUID` (IVR tables). The IVR module uses UUIDs because flow IDs are shared across tenants (template references) and must be globally unique. All new tables should use `UUID DEFAULT gen_random_uuid()`.
- **Foreign keys to users, tenants, orgs:** Always INT (references SERIAL PKs in those tables).

### PG Error Mapping

The error handler in `server.js` maps these PostgreSQL error codes:
- `23505` (unique violation) → HTTP 409
- `23503` (FK violation) → HTTP 409

---

## Migration System

### `src/db/migrate.js`

Two paths, auto-detected:

- **Fresh DB** (no `tenants` table): applies `001_initial_schema.sql` (covers migrations 001–005 equivalent), marks those as applied in `schema_migrations`, then runs numbered migrations 006+ in order.
- **Existing DB**: skips `001_initial_schema.sql`, runs only unapplied migrations from the `schema_migrations` table.

### Naming Convention

```
NNN_short_description.sql
```

Current: 001 through 031. Next available: 032.

### Migration Rules (non-negotiable)

1. **Additive only** — `ALTER TABLE ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Never `DROP COLUMN`, `DROP TABLE`, or `ALTER COLUMN TYPE`.
2. **Idempotent** — `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`. Safe to run twice.
3. **Self-contained transactions** — each migration must start with `BEGIN;` and end with `COMMIT;`.
4. **No rollback script** — rollback is achieved by deploying the previous application version (which doesn't use the new columns). New columns with `DEFAULT NULL` or safe defaults are always backward-compatible.
5. **Never modify a migration that has been deployed** — once a migration number appears in `schema_migrations` on any environment, that SQL is frozen. Write a new migration instead.

---

## Table Inventory

### Core Infrastructure (001_initial_schema.sql)

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | Top-level security boundary | `id`, `name`, `slug`, `is_active` |
| `organizations` | UX grouping within a tenant | `tenant_id`, `name`, `location_id` |
| `users` | Platform users | `tenant_id`, `org_id`, `email`, `role`, `password_hash` |
| `locations` | Physical sites | `tenant_id`, `name`, `address_*` |
| `departments` | Organizational units | `tenant_id`, `org_id`, `name` |
| `emergency_contacts` | Responder directory | `tenant_id`, `mobile_number`, `extension`, `gateway_id` |
| `responder_groups` | Named contact groups | `tenant_id`, `name` |
| `responder_group_members` | Group membership | `group_id`, `contact_id` |
| `media_files` | Audio file library (deprecated → `audio_library`) | `tenant_id`, `filename`, `path` |
| `audio_library` | Audio file library (active) | `tenant_id`, `name`, `file_path`, `type` |
| `notification_templates` | ENS message templates | `tenant_id`, `name`, `content` |
| `system_settings` | Global key-value config | `key`, `value` |
| `feature_flags` | Feature toggles | `name`, `is_enabled`, `tenant_id` |
| `audit_logs` | Admin action audit trail | `tenant_id`, `user_id`, `action` |
| `esl_connections` | Reserved for Wave 6 multi-cluster | not yet read |

### ENS Tables

| Table | Purpose | Status |
|---|---|---|
| `ens_configurations` | ENS blast configuration | Active |
| `ens_configuration_groups` | Contact group assignment to config | Active |
| `ens_configuration_contacts` | Individual contact assignment | Active |
| `ens_notifications` | Legacy blast tracking (pre-Wave 1) | Deprecated post-Wave 1 |
| `ens_notification_deliveries` | Legacy per-contact delivery tracking | Deprecated post-Wave 1 |
| `ens_campaigns` | Current blast campaign tracking | Active (authoritative post-Wave 1) |
| `ens_campaign_deliveries` | Per-contact delivery tracking | Active (authoritative post-Wave 1) |

**F1 Critical:** Until the legacy columns are removed, all ENS writes must go to both tables during the transition period (Wave 1). See `CommunicationEngine.md` for the transition plan.

### ERS Tables

| Table | Purpose |
|---|---|
| `ers_configurations` | ERS bridge configuration |
| `ers_tier_groups` | Responder group assignments per tier |
| `ers_tier_contacts` | Individual responder assignments per tier |
| `ers_incidents` | Active and historical incidents |
| `ers_incident_responders` | Per-responder dial tracking (one row per contact per incident) |
| `ers_incident_participants` | ESL event audit (who actually joined conference) |
| `ers_incident_events` | Mute/unmute/floor change events |
| `ers_queues` | Callers waiting for a conference slot |
| `ers_playback_lines` | Playback number configuration |

### IVR Tables

| Table | Purpose |
|---|---|
| `ivr_flows` | Flow graph JSONB (mutable until published) |
| `ivr_flow_versions` | Immutable published snapshots |
| `ivr_templates` | Reusable starting-point flows |

### Gateway & Service Registry

| Table | Purpose |
|---|---|
| `sip_gateways` | SIP gateway configuration and deployment state |
| `emergency_numbers` | Service registry: number → module → config |

### Platform Tables

| Table | Purpose |
|---|---|
| `recordings` | Unified recording table (ERS/ENS/IVR/MANUAL) |
| `communication_sessions` | Wave 3 — cross-module call tracking (not yet created) |

---

## Known Schema Issues (from architecture review)

### F9 — `recordings.campaign_id` wrong type

Migration 026 adds `campaign_id UUID` to the `recordings` table as a foreign key to ENS campaigns. However, `ens_notifications.notification_uuid` is type UUID while `ens_campaigns.id` is type INT. The column type is wrong. Correct type: `campaign_id INT REFERENCES ens_campaigns(id)`.

**Fix:** Wave 1 migration adds `campaign_id INT REFERENCES ens_campaigns(id) ON DELETE SET NULL` as an additive column. The UUID column is kept (not removed) until all code that wrote to it has been migrated.

### F8 — Reserved columns not enforced in `ers_configurations`

Migration 027 adds 7 columns (`max_participants`, `conference_lock`, `auto_destroy`, `allow_external`, `allow_duplicate_responders`, `moderator_required`, `bridge_timeout_sec`) that are NOT enforced by any application code. They appear in the schema but have zero effect. These must not appear in UI until enforcement logic exists.

**Risk:** A user setting `max_participants = 2` expecting it to cap conference size will see no behavior change. This erodes trust.

**Fix:** Document them as `RESERVED` in `DomainModel.md` (done). Remove them from the UI configuration form until enforcement is implemented. Do not remove the columns — they are additive and harmless.

### F7 — `recordings.conference_name` generated column redundancy

Migration 026 adds `conference_name` as a generated column alias for `conference_room`. Two columns with the same value. Application code should standardize on `conference_room`. The alias column will be removed in a future cleanup migration (not Wave 1).

### `ens_configurations.caller_id` / `blast_clid` deprecated fields

`ens_configurations` has four caller ID fields. Two are deprecated:
- `caller_id` — deprecated, superseded by `sip_caller_id`
- `blast_clid` — deprecated, superseded by `sip_caller_id`

Authoritative fields:
- `sip_caller_id` — used for blast outbound caller ID
- `reply_clid` — used for callback numbers shown in messages

These deprecated columns must not appear in the UI or be written to. They may be removed in a Wave 2 cleanup migration after confirming all production data has been migrated.

---

## Index Strategy

Indexes must be created for:
- All FK columns used in JOIN conditions
- All `WHERE tenant_id = $1` filter columns (usually covered by the FK index)
- Partial indexes for hot-path queries (see `idx_ers_incidents_conference_room_active`)

The most critical existing index:

```sql
CREATE UNIQUE INDEX idx_ers_incidents_conference_room_active
  ON ers_incidents (conference_room)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;
```

This prevents two simultaneous incidents from claiming the same conference room.

---

## `query()` and `withTransaction()` patterns

```javascript
// Single query — auto-logs SQL + params on error
const { rows } = await query(
  `SELECT * FROM ers_configurations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
  [configId, tenantId]
);

// Transaction — tq is a bound query inside the transaction
await withTransaction(async tq => {
  await tq(`UPDATE sip_gateways SET is_default_outbound = false WHERE tenant_id = $1`, [tenantId]);
  await tq(`UPDATE sip_gateways SET is_default_outbound = true WHERE id = $1`, [id]);
});
```

`withTransaction` automatically rolls back on thrown errors. Never call `query()` inside `withTransaction` — always use `tq`.
