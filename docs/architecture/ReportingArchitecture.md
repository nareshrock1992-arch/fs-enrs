# Reporting Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Core Rule

> **Reporting never drives business logic. Business logic never defers to reporting.**

Reports read stored data. They do not recalculate values that business modules are responsible for storing. If a metric should appear in a report, the responsible business module must store it in the database as the event occurs — not at query time.

This rule prevents a common failure mode: logic that should be in the domain model migrating into SQL queries over time, making the reports the only place certain state is computed, making them impossible to unit test, and making business logic invisible to non-DB developers.

---

## Report Module Boundary

The reporting module (`src/routes/v1/reports.js`) is permitted to:
- Read any table with `deleted_at IS NULL` filtering
- JOIN across modules (ERS + recordings, ENS + campaigns, etc.)
- Aggregate, filter, and paginate stored data
- Read from `communication_sessions` (Wave 3+) for cross-module call analytics

The reporting module is forbidden from:
- Writing to any table
- Calling Communication Engine, ESL, or provider APIs
- Recalculating values that should be stored (e.g., computing talk time by diffing `answered_at` and `ended_at` is acceptable; re-counting deliveries by parsing audit logs is not)
- Making routing or business decisions

---

## Current Report Surfaces

### ERS Reports

**Source tables:** `ers_incidents`, `ers_incident_responders`, `ers_incident_participants`, `ers_incident_events`, `ers_queues`, `recordings`

**Key metrics stored at incident time (not computed by reports):**
- `ers_incident_responders.ring_start_time` — when ringing began per responder
- `ers_incident_responders.dial_attempts` — retry count
- `ers_incident_responders.hangup_cause` — disconnect code from FS
- `ers_incident_responders.tier`, `wave_number` — which tier wave reached this responder
- `ers_incident_participants.disconnect_cause` — why participant left
- `ers_incident_participants.total_talk_seconds` — duration in conference
- `ers_incident_participants.caller_name` — resolved name at call time

**What reports compute from stored data (acceptable):**
- Response time = first `CONNECTED` status timestamp − incident `created_at`
- Average talk time across participants
- Tier coverage (how many tiers were reached before answer)
- On-duty vs off-duty responder ratio from `ers_incident_responders.tier`

### ENS Reports

**Source tables:** `ens_notifications`, `ens_notification_deliveries`, `ens_campaigns`, `ens_campaign_deliveries`, `recordings`

**Dual tracking note (F1 Critical):** `ens_notifications` + `ens_notification_deliveries` and `ens_campaigns` + `ens_campaign_deliveries` are parallel tracking systems from two different phases of development. After Wave 1, `ens_campaigns` is the authoritative source. Reports must read from `ens_campaigns` for post-Wave-1 data.

Until migration is complete, reports must UNION or LEFT JOIN across both tables with timestamp discrimination: records with `ens_campaigns.created_at > Wave1DeployDate` are from the new system; earlier records are from the old system. Alternatively, expose separate report endpoints per era.

**Key metrics stored at delivery time:**
- `ens_campaign_deliveries.status` — PENDING / DELIVERED / FAILED / NO_ANSWER / BUSY
- `ens_campaign_deliveries.answered_at`, `duration_seconds`
- `ens_campaign_deliveries.hangup_cause`
- `ens_campaign_deliveries.attempt_number`

### IVR Reports _(Future)_

When `communication_sessions` is available (Wave 3), IVR analytics will read from:
- `communication_sessions WHERE module = 'IVR'`
- IVR executor logs (if written to `audit_logs`)
- DTMF path data (if stored per session — Wave 4 design decision)

### Cross-Module Call Analytics _(Wave 3+)_

`communication_sessions` provides a unified view across ENS, ERS, and IVR:

```sql
-- Platform-wide call volume by module and status
SELECT
  module,
  status,
  COUNT(*) AS calls,
  AVG(duration_seconds) AS avg_duration,
  date_trunc('day', created_at) AS day
FROM communication_sessions
WHERE tenant_id = $1
  AND created_at BETWEEN $2 AND $3
  AND deleted_at IS NULL
GROUP BY module, status, day
ORDER BY day DESC
```

---

## Report API Design

All report endpoints follow these conventions:

1. **Read-only** — GET only, no mutations
2. **Tenant-scoped** — always `WHERE tenant_id = req.user.tenantId`
3. **Time-bounded** — always require `start_date` and `end_date` parameters; max range 90 days without explicit override
4. **Paginated** — all list results: `{ data: [...], total, page, limit }`
5. **Deletions excluded** — always `AND deleted_at IS NULL`
6. **Role-protected** — minimum `OPERATOR` role; detailed reports require `SUPERVISOR`

---

## Report Data Freshness

Reports are synchronous queries on the primary database. There is no report cache or OLAP layer today.

At scale, two patterns are available without redesigning the report module:

1. **Read replica** — Point `reports.js` at a PG replica. All other writes continue on primary. Zero application code change.
2. **Materialized views** — Expensive aggregations (weekly ENS delivery summaries) pre-computed by cron or PG `REFRESH MATERIALIZED VIEW`. The report endpoint reads the materialized view instead of running the live query.

Neither pattern requires changing the report endpoints or any business module.

---

## The Reporting Regression Pattern

A common failure mode in this codebase (identified in `docs/architecture/arch-review`):

Business module stores value A. A report query is written that re-derives A from raw events. When the business module changes how it stores A, the report query breaks silently — the report continues to run but produces wrong numbers.

**Prevention:**
- If a value should appear in a report, the domain event handler must store it explicitly
- Report queries should read stored columns, not re-derive from event streams
- When a new reporting requirement arises, identify which business module is responsible for storing the source data and add the column there — not in the report query

**Example (correct):** `ers_incident_responders.dial_attempts INT` — stored by `ersRingService` each time a call attempt is made. The report reads this column.

**Example (wrong):** Report counts rows in an audit log where `action = 'ring_attempt'` to compute dial attempts. If the audit log format changes, the count breaks.

---

## `audit_logs` Table

General-purpose audit trail for UI and admin actions.

```sql
audit_logs:
  id          BIGSERIAL PRIMARY KEY
  tenant_id   INT
  user_id     INT REFERENCES users(id)
  action      VARCHAR(64) NOT NULL      -- e.g. 'ers_config.update', 'user.login'
  resource_type VARCHAR(64)
  resource_id   INT
  before_state  JSONB                   -- previous value (for updates)
  after_state   JSONB                   -- new value
  ip_address    VARCHAR(45)
  created_at    TIMESTAMPTZ DEFAULT now()
```

`audit_logs` records **admin actions**, not call events. Call events are recorded by the business module tables (`ers_incident_events`, `communication_sessions`, etc.). Do not use `audit_logs` as a call event store.

---

## Future: Report Templates

`notification_templates` (currently used for ENS message templates) could be extended to support report templates — saved report configurations per tenant. Not in current scope. Noted here to avoid the temptation to build report config into `notification_templates` before a proper report template model is designed.
