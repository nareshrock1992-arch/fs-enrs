# DATABASE STANDARDS — fs-enrs

## Connection

- Single pool in `backend/src/db/pool.js`, max 20 connections
- All queries via `query(sql, params)` helper — never raw `pool.query` in controllers
- Transactions via `withTransaction(pool, async client => { ... })` — always COMMIT/ROLLBACK

## Naming Conventions

| Object | Convention | Example |
|---|---|---|
| Tables | snake_case, plural | `emergency_contacts` |
| Columns | snake_case | `organization_id`, `created_at` |
| Indexes | `idx_<table>_<columns>` | `idx_contacts_org_id` |
| FKs | `fk_<table>_<ref>` | `fk_contacts_org` |
| Sequences | auto via SERIAL/BIGSERIAL | — |

## Required Columns (Every Table)

```sql
id          SERIAL PRIMARY KEY,
created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at  TIMESTAMPTZ                          -- soft-delete
```

Tables with tenant scope also require:
```sql
tenant_id   INT NOT NULL REFERENCES tenants(id)
```

## Soft Delete Pattern

- Never hard-delete rows except for junction/pivot tables
- All list queries: `WHERE deleted_at IS NULL`
- Delete operation: `UPDATE table SET deleted_at = now() WHERE id = $1`
- Unique constraints must include `WHERE deleted_at IS NULL` partial index:

```sql
CREATE UNIQUE INDEX idx_orgs_code_active
  ON organizations(tenant_id, code)
  WHERE deleted_at IS NULL;
```

## Migration Standards

- Files: `backend/src/db/migrations/NNN_description.sql`
- Always wrapped: `BEGIN; ... COMMIT;`
- Use `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`
- Never destructive without explicit user approval (DROP COLUMN, DROP TABLE)
- Rollback section commented at bottom of each file

## Index Strategy

Every FK column gets an index:
```sql
CREATE INDEX IF NOT EXISTS idx_contacts_org_id ON emergency_contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON emergency_contacts(tenant_id);
```

Columns used in WHERE filters:
```sql
CREATE INDEX IF NOT EXISTS idx_notifs_status ON ens_notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifs_created ON ens_notifications(created_at DESC);
```

## Tenant Scoping

All tables that hold org-level data must have `tenant_id`. List queries must filter:
```sql
AND tenant_id = $n  -- always the last param
```

The tenant_id is read from `req.user.tenant_id` (set by JWT middleware). SUPERADMIN bypasses this filter.

## Canonical Table List (Phase A)

```
tenants                     users                   refresh_tokens
organizations               locations               departments
emergency_contacts          responder_groups        responder_group_members
ens_configurations          ens_configuration_contacts  ens_configuration_groups
ens_notifications           ens_deliveries
ers_configurations          ers_incidents           ers_incident_responders
ers_queues                  esl_connections
ivr_flows                   ivr_flow_versions       ivr_nodes
media_files                 notification_templates
audit_logs                  system_settings         feature_flags
password_history
```

## Phase B7 New Tables

```sql
-- DIDs
CREATE TABLE IF NOT EXISTS dids (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenants(id),
  number              VARCHAR(32) NOT NULL,
  description         TEXT,
  assigned_to_type    VARCHAR(32),  -- 'ENS','ERS','IVR','PBX_USER',NULL
  assigned_to_id      INT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dids_number_active
  ON dids(number) WHERE deleted_at IS NULL;

-- PBX Connections
CREATE TABLE IF NOT EXISTS pbx_connections (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenants(id),
  name                VARCHAR(128) NOT NULL,
  type                VARCHAR(32) NOT NULL, -- 'AVAYA','CISCO_CUCM','CISCO_UCCX','ASTERISK'
  host                VARCHAR(255) NOT NULL,
  port                INT NOT NULL DEFAULT 5060,
  username            VARCHAR(128),
  password_encrypted  TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_sync_at        TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PBX Extensions
CREATE TABLE IF NOT EXISTS pbx_extensions (
  id                      SERIAL PRIMARY KEY,
  pbx_connection_id       INT NOT NULL REFERENCES pbx_connections(id),
  extension               VARCHAR(32) NOT NULL,
  display_name            VARCHAR(128),
  email                   VARCHAR(255),
  emergency_contact_id    INT REFERENCES emergency_contacts(id),
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Phase B8 New Table

```sql
CREATE TABLE IF NOT EXISTS notification_templates (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL REFERENCES tenants(id),
  organization_id INT REFERENCES organizations(id),
  name            VARCHAR(128) NOT NULL,
  channel         VARCHAR(32) NOT NULL, -- 'voice_tts','sms','email','push'
  subject         TEXT,
  body            TEXT NOT NULL,
  variables       JSONB,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
