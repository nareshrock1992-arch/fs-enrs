# Migration Strategy

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Philosophy

Every wave is independently deployable. A wave may be rolled back by deploying the previous application version — no rollback migration scripts are needed because all schema changes are additive (new columns with safe defaults, new tables). Old code ignores new columns. New code reads new columns and falls back gracefully when they are null.

**The only exception:** index creation and constraint addition. These are additive but may lock tables briefly. Schedule them during low-traffic windows.

---

## Wave 0 — Architecture Freeze _(Complete)_

**Goal:** Document the platform architecture before any implementation begins.

**Deliverables:**
- All 16 files in `docs/architecture/`
- Wave 0 validation published at docs/architecture/arch-review.html artifact

**Schema changes:** None.

**Gate:** All documentation files committed to repository. Architecture reviewed and approved by engineering lead.

---

## Wave 1 — Outbound Router + Gateway FK

**Goal:** Remove all inline `bgapi originate` construction from business modules. Centralize channel variable assembly. Add gateway FK references to ENS and ERS configurations.

**Files changed:**
- `backend/src/services/outboundRouter.js` — NEW
- `backend/src/utils/numberNormalizer.js` — NEW (passthrough)
- `backend/src/services/ersRingService.js` — remove inline bgapi, call outboundRouter
- `backend/src/services/campaignEngine.js` — remove inline originate, call outboundRouter
- `backend/src/db/migrations/032_gateway_fields.sql` — NEW

**Migration 032 (additive):**

```sql
BEGIN;

-- Add FK gateway references to module configurations
ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS sip_gateway_id INT REFERENCES sip_gateways(id);

ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS sip_gateway_id INT REFERENCES sip_gateways(id);

-- Add routing metadata to sip_gateways (already in 015 — verify before adding)
-- Skip if columns exist

-- Add priority for gateway failover (Wave 5 activation)
ALTER TABLE sip_gateways
  ADD COLUMN IF NOT EXISTS priority INT DEFAULT 10;

ALTER TABLE sip_gateways
  ADD COLUMN IF NOT EXISTS max_concurrent_calls INT;

ALTER TABLE sip_gateways
  ADD COLUMN IF NOT EXISTS calls_per_second NUMERIC(5,2);

-- Fix recordings.campaign_id type (F9)
ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS campaign_id_int INT REFERENCES ens_campaigns(id) ON DELETE SET NULL;

COMMIT;
```

**Rollback:** Deploy previous application version. New columns (`sip_gateway_id`, `priority`, etc.) are ignored by old code. No data loss.

**Testing:**
- Unit: `outboundRouter.placeCall()` with each DestinationType
- Unit: `sanitizeVarValue()` with special characters `{}=,`
- Integration: ERS ring-all places calls via outboundRouter
- Integration: ENS campaign places calls via outboundRouter
- E2E: Full ERS incident lifecycle in lab environment
- E2E: Full ENS campaign with 3 contacts in lab environment

**Wave 1 IVR bug fixes (same wave):**
- Fix `ens_playback` node endpoint
- Fix `webhook` node URL escaping
- Fix `record_message` path
- Fix `ens_blast_gate` PIN retry count
- Deprecate `ers_connect` node (add warning label in UI, do not remove)

---

## Wave 2 — Observability Foundation

**Goal:** Structured logging, health check endpoint, `session_uuid` correlation on all calls.

**Files changed:**
- `backend/src/services/eslService.js` — set `enrs_session_uuid` on all originated calls
- `backend/src/middleware/logger.js` — NEW structured logging
- `backend/src/routes/v1/health.js` — NEW health endpoint
- `backend/src/db/migrations/033_gateway_unique_default.sql` — partial unique index

**Migration 033:**

```sql
BEGIN;

-- Enforce one-default-per-tenant at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_sip_gateways_one_default_per_tenant
  ON sip_gateways (tenant_id)
  WHERE is_default_outbound = true AND deleted_at IS NULL;

COMMIT;
```

**Testing:**
- Health endpoint returns correct ESL state during ESL disconnect
- Log output is valid JSON with `sessionUuid` on call events
- Correlation: `enrs_session_uuid` in ESL event matches originated session

---

## Wave 3 — Communication Engine

**Goal:** Single entry point for all outbound communication. Cross-module session tracking.

**Files changed:**
- `backend/src/services/communicationEngine.js` — NEW
- `backend/src/services/conferenceManager.js` — remove ERS recording logic
- `backend/src/services/campaignEngine.js` — call Engine instead of outboundRouter
- `backend/src/services/ersRingService.js` — call Engine instead of outboundRouter
- `backend/src/db/migrations/034_communication_sessions.sql` — NEW

**Migration 034:**

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS communication_sessions (
  id                    BIGSERIAL PRIMARY KEY,
  session_uuid          UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             INT NOT NULL REFERENCES tenants(id),
  module                VARCHAR(32) NOT NULL,
  module_ref_table      VARCHAR(64),
  module_ref_id         BIGINT,
  parent_session_id     BIGINT REFERENCES communication_sessions(id),
  channel               VARCHAR(16) NOT NULL DEFAULT 'voice',
  destination_type      VARCHAR(32),
  destination_raw       VARCHAR(128),
  destination_normalized VARCHAR(128),
  provider              VARCHAR(32) NOT NULL DEFAULT 'freeswitch',
  gateway_id            INT REFERENCES sip_gateways(id),
  gateway_name          VARCHAR(128),
  dial_string           TEXT,
  caller_id_number      VARCHAR(32),
  caller_id_name        VARCHAR(128),
  action                VARCHAR(32),
  action_target         TEXT,
  provider_session_id   VARCHAR(128),
  status                VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  originated_at         TIMESTAMPTZ,
  answered_at           TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  disconnect_cause      VARCHAR(64),
  failure_reason        TEXT,
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comm_sessions_tenant_module
  ON communication_sessions (tenant_id, module, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comm_sessions_session_uuid
  ON communication_sessions (session_uuid);

CREATE INDEX IF NOT EXISTS idx_comm_sessions_provider_session
  ON communication_sessions (provider_session_id)
  WHERE provider_session_id IS NOT NULL;

COMMIT;
```

**Rollback:** Deploy Wave 2 application. `communication_sessions` table is unused by old code. No data loss.

---

## Wave 4 — Provider Layer

**Goal:** Wrap ESL access behind a Provider interface. Enable non-FreeSWITCH providers.

**Files changed:**
- `backend/src/providers/freeswitchProvider.js` — NEW
- `backend/src/providers/providerRegistry.js` — NEW
- `backend/src/services/outboundRouter.js` — call providerRegistry instead of ESL directly

**Schema changes:** None.

**Rollback:** Deploy Wave 3 application. FreeSWITCH calls continue via outboundRouter directly.

---

## Wave 5 — Routing Policies and Gateway Failover

**Goal:** Per-tenant routing rules, gateway failover, number normalization.

**Files changed:**
- `backend/src/services/destinationClassifier.js` — NEW (was stub in Wave 1)
- `backend/src/utils/numberNormalizer.js` — activate normalization logic
- `backend/src/services/routingPolicyEngine.js` — NEW
- `backend/src/db/migrations/035_gateway_routes.sql` — NEW

**Rollback:** Deploy Wave 4 application. `gateway_routes` table is unused. Routing falls back to `dialResolver.js` default behavior.

---

## Wave 6 — Multi-Site _(Future)_

**Goal:** Multiple FreeSWITCH clusters, one per site. `esl_connections` table activated.

**Schema changes:** Revise `esl_connections` table schema (TBD at Wave 6 design time).

**Rollback:** Wave 6 is a major feature — rollback requires a data migration plan defined at that wave's design time.

---

## Pre-Deployment Checklist (Every Wave)

Before deploying any wave to a shared/production environment:

- [ ] All Wave N migrations run successfully on a database copy
- [ ] All Wave N tests pass: unit, integration, E2E
- [ ] Old application version runs without error against Wave N schema (backward compat test)
- [ ] New application version runs without error against Wave N-1 schema (graceful null handling)
- [ ] Health check endpoint reports `ok` after deployment
- [ ] ESL event correlation verified (originated call UUID matches CHANNEL_HANGUP event)
- [ ] No `console.error` output in logs during normal operation
- [ ] Socket.IO monitoring dashboard shows live events correctly
- [ ] All pending reports return correct data (regression test for reporting)
