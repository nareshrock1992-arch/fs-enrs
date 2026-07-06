-- ============================================================
--  Migration 004 — Sprint B3: IVR Flow Engine
--  Run with: psql -d fs_enrs -f 004_sprint_b3_ivr_engine.sql
--  Idempotent: all statements use IF NOT EXISTS / IF EXISTS
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- ivr_flows — editable draft container
-- Operators build/edit the graph here; Lua never reads this.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ivr_flows (
  id                BIGSERIAL     PRIMARY KEY,
  flow_uuid         UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name              VARCHAR(128)  NOT NULL,
  description       TEXT,
  organization_id   INT           REFERENCES organizations(id),
  tenant_id         INT           NOT NULL REFERENCES tenants(id),
  graph             JSONB         NOT NULL DEFAULT '{}',
  is_active         BOOLEAN       NOT NULL DEFAULT true,
  created_by        INT           REFERENCES users(id),
  updated_by        INT           REFERENCES users(id),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

-- ────────────────────────────────────────────────────────────
-- ivr_flow_versions — immutable published snapshots
-- Lua reads the latest version per flow_id.
-- Publishing always creates a new row; rows are never mutated.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ivr_flow_versions (
  id              BIGSERIAL    PRIMARY KEY,
  version_uuid    UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ivr_flow_id     BIGINT       NOT NULL REFERENCES ivr_flows(id),
  version_number  INT          NOT NULL,
  graph           JSONB        NOT NULL,
  published_by    INT          REFERENCES users(id),
  published_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  change_notes    TEXT,
  UNIQUE (ivr_flow_id, version_number)
);

-- ────────────────────────────────────────────────────────────
-- Bind IVR flow to emergency_numbers
-- Nullable FK: number without a flow falls through to direct
-- ENS/ERS routing (backwards-compatible).
-- ────────────────────────────────────────────────────────────
ALTER TABLE emergency_numbers
  ADD COLUMN IF NOT EXISTS ivr_flow_id BIGINT REFERENCES ivr_flows(id);

-- ────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ivr_flows_tenant
  ON ivr_flows (tenant_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_org
  ON ivr_flows (organization_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_flows_active
  ON ivr_flows (is_active) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ivr_versions_flow
  ON ivr_flow_versions (ivr_flow_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_ivr_versions_latest
  ON ivr_flow_versions (ivr_flow_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_emergency_numbers_ivr_flow
  ON emergency_numbers (ivr_flow_id) WHERE ivr_flow_id IS NOT NULL;

COMMIT;
