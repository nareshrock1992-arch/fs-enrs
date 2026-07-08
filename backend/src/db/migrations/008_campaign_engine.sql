-- ============================================================
--  Migration 008 — Multi-Service Campaign Engine
--
--  Adds:
--    1. service_name / description / icon / sort fields on emergency_numbers
--    2. Campaign engine config columns on ens_configurations
--    3. ens_campaigns — one row per blast event
--    4. ens_campaign_destinations — per-contact state machine
--    5. Indexes for efficient tick queries
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- A1: Enhance emergency_numbers for Service Registry display
-- ─────────────────────────────────────────────────────────────

ALTER TABLE emergency_numbers
  ADD COLUMN IF NOT EXISTS service_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS icon          VARCHAR(50)  DEFAULT 'shield-alert',
  ADD COLUMN IF NOT EXISTS color         VARCHAR(20)  DEFAULT 'red',
  ADD COLUMN IF NOT EXISTS sort_order    INT          DEFAULT 0;

-- ─────────────────────────────────────────────────────────────
-- A2: Campaign defaults on ens_configurations
--     These are snapshot-copied into ens_campaigns at trigger time
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS max_concurrent_calls  INT            NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS calls_per_second      NUMERIC(5,2)  NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS retry_interval_sec    INT            NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS max_attempts          INT            NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS retry_failed_only     BOOLEAN        NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS adaptive_throttling   BOOLEAN        NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS campaign_priority     INT            NOT NULL DEFAULT 5
                             CHECK (campaign_priority BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS campaign_timeout_min  INT            NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS sip_gateway           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sip_caller_id         VARCHAR(50);

-- ─────────────────────────────────────────────────────────────
-- A3: ENS Campaigns — one row per blast event
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ens_campaigns (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  ens_configuration_id INT          NOT NULL REFERENCES ens_configurations(id),
  organization_id     INT          REFERENCES organizations(id) ON DELETE SET NULL,
  triggered_by        INT          REFERENCES users(id) ON DELETE SET NULL,
  triggered_via       VARCHAR(20)  NOT NULL DEFAULT 'PHONE'
                        CHECK (triggered_via IN ('PHONE','UI','API','SCHEDULE')),
  trigger_number      VARCHAR(30),

  -- Status state machine
  status              VARCHAR(20)  NOT NULL DEFAULT 'queued'
                        CHECK (status IN
                          ('queued','running','paused','completed','cancelled','failed')),

  -- Message payload
  recording_file      TEXT,
  message_audio_url   TEXT,
  message_text        TEXT,

  -- Campaign config snapshot (copied from ens_configurations at trigger time)
  max_concurrent      INT          NOT NULL DEFAULT 30,
  calls_per_second    NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  retry_count         INT          NOT NULL DEFAULT 3,
  retry_interval_sec  INT          NOT NULL DEFAULT 300,
  max_attempts        INT          NOT NULL DEFAULT 4,
  retry_failed_only   BOOLEAN      NOT NULL DEFAULT true,
  adaptive_throttling BOOLEAN      NOT NULL DEFAULT true,
  campaign_priority   INT          NOT NULL DEFAULT 5,
  campaign_timeout_min INT         NOT NULL DEFAULT 60,
  sip_gateway         VARCHAR(100),
  sip_caller_id       VARCHAR(50),

  -- Scheduling
  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  paused_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,

  -- Running stats (atomically incremented)
  total_destinations  INT          NOT NULL DEFAULT 0,
  queued_count        INT          NOT NULL DEFAULT 0,
  dialing_count       INT          NOT NULL DEFAULT 0,
  answered_count      INT          NOT NULL DEFAULT 0,
  busy_count          INT          NOT NULL DEFAULT 0,
  no_answer_count     INT          NOT NULL DEFAULT 0,
  failed_count        INT          NOT NULL DEFAULT 0,
  retried_count       INT          NOT NULL DEFAULT 0,
  completed_count     INT          NOT NULL DEFAULT 0,
  expired_count       INT          NOT NULL DEFAULT 0,
  skipped_count       INT          NOT NULL DEFAULT 0,
  peak_concurrent     INT          NOT NULL DEFAULT 0,
  campaign_duration_sec INT,
  avg_answer_time_ms  INT,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ens_campaigns_status
  ON ens_campaigns (status, campaign_priority DESC, created_at)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_ens_campaigns_config
  ON ens_campaigns (ens_configuration_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- A4: ENS Campaign Destinations — per-contact state machine
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ens_campaign_destinations (
  id              BIGSERIAL    PRIMARY KEY,
  campaign_id     UUID         NOT NULL REFERENCES ens_campaigns(id) ON DELETE CASCADE,
  contact_id      INT          REFERENCES emergency_contacts(id) ON DELETE SET NULL,
  phone_number    VARCHAR(50)  NOT NULL,
  contact_name    VARCHAR(200),

  -- State
  status          VARCHAR(20)  NOT NULL DEFAULT 'queued'
                    CHECK (status IN
                      ('queued','dialing','answered','busy','no_answer',
                       'failed','completed','expired','skipped')),
  attempt_count   INT          NOT NULL DEFAULT 0,
  max_attempts    INT          NOT NULL DEFAULT 4,

  -- Timing
  queued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  answered_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- ESL tracking
  call_uuid       VARCHAR(100),

  -- Outcome
  answer_time_ms  INT,
  call_duration_sec INT,
  hangup_cause    VARCHAR(50),
  error_message   TEXT,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camp_dest_campaign_status
  ON ens_campaign_destinations (campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_camp_dest_next_attempt
  ON ens_campaign_destinations (campaign_id, next_attempt_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_camp_dest_call_uuid
  ON ens_campaign_destinations (call_uuid)
  WHERE call_uuid IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- A5: Record migration
-- ─────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version)
VALUES ('008_campaign_engine.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
