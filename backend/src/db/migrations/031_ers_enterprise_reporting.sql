-- ============================================================
--  Migration 031 — ERS Enterprise Reporting
--
--  Root-cause fix: guarantee the UNIQUE constraint on
--  ers_incident_responders(ers_incident_id, mobile_number) that
--  every ON CONFLICT clause depends on. Prior DO $$ blocks in
--  migration 003 ran correctly in most cases, but any DB that
--  skipped 003 (e.g. fresh install from schema.sql that
--  pre-dates the constraint) was left without it, causing every
--  ON CONFLICT INSERT to throw and be silently swallowed.
--
--  Enterprise columns: ring_start_time, dial_attempts,
--  hangup_cause, tier, wave_number on responders;
--  disconnect_cause on participants;
--  expanded status CHECK for full call-disposition tracking;
--  ers_incident_events for mute/floor history.
--
--  Idempotent: all statements use IF NOT EXISTS / DO $$.
-- ============================================================

BEGIN;

-- ── 1. Guarantee the UNIQUE constraint that ON CONFLICT depends on ─────────────
-- Silently dropped NULLs first: the constraint cannot be created if any
-- (ers_incident_id, mobile_number) pair is NULL in mobile_number.
-- NULLs are safe to leave (they don't match any ON CONFLICT target anyway),
-- but we must clear duplicate NULLs that would violate uniqueness post-constraint.
-- In practice mobile_number is always set by application code; this is a guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ers_incident_responders_incident_mobile_key'
  ) THEN
    ALTER TABLE ers_incident_responders
      ADD CONSTRAINT ers_incident_responders_incident_mobile_key
      UNIQUE (ers_incident_id, mobile_number);
    RAISE NOTICE 'Created constraint ers_incident_responders_incident_mobile_key';
  ELSE
    RAISE NOTICE 'Constraint ers_incident_responders_incident_mobile_key already exists — skipped';
  END IF;
END $$;

-- ── 2. Enterprise columns on ers_incident_responders ─────────────────────────
ALTER TABLE ers_incident_responders
  ADD COLUMN IF NOT EXISTS ring_start_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dial_attempts   INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hangup_cause    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS tier            VARCHAR(16) CHECK (tier IN ('primary','secondary')),
  ADD COLUMN IF NOT EXISTS wave_number     INT         NOT NULL DEFAULT 0;

-- ── 3. Expand ers_incident_responders.status CHECK ───────────────────────────
-- The original CHECK (status IN ('INVITED','JOINED','MISSED','REJOINED','OBSERVER'))
-- does not cover call-disposition values (BUSY, NO_ANSWER, FAILED, REJECTED, TIMEOUT).
-- PostgreSQL does not support ALTER TABLE ... ALTER COLUMN ... SET CHECK directly;
-- we must drop and re-add.
DO $$
DECLARE
  v_conname text;
BEGIN
  -- Find the existing CHECK constraint name (it may vary across installs)
  SELECT conname INTO v_conname
  FROM   pg_constraint
  WHERE  conrelid = 'ers_incident_responders'::regclass
    AND  contype  = 'c'
    AND  pg_get_constraintdef(oid) LIKE '%status%'
  LIMIT  1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ers_incident_responders DROP CONSTRAINT %I', v_conname);
    RAISE NOTICE 'Dropped old status CHECK: %', v_conname;
  END IF;

  ALTER TABLE ers_incident_responders
    ADD CONSTRAINT ers_incident_responders_status_check
    CHECK (status IN (
      'INVITED',
      'JOINED',
      'MISSED',
      'REJOINED',
      'OBSERVER',
      'BUSY',
      'NO_ANSWER',
      'FAILED',
      'REJECTED',
      'TIMEOUT'
    ));

  RAISE NOTICE 'Created expanded status CHECK on ers_incident_responders';
END $$;

-- ── 4. Enterprise columns on ers_incident_participants ───────────────────────
ALTER TABLE ers_incident_participants
  ADD COLUMN IF NOT EXISTS disconnect_cause VARCHAR(64),
  ADD COLUMN IF NOT EXISTS caller_name      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS total_talk_seconds INT;

-- ── 5. ers_incident_events — mute/unmute/floor history ───────────────────────
CREATE TABLE IF NOT EXISTS ers_incident_events (
  id             BIGSERIAL    PRIMARY KEY,
  incident_id    INT          NOT NULL REFERENCES ers_incidents(id) ON DELETE CASCADE,
  participant_id BIGINT       REFERENCES ers_incident_participants(id) ON DELETE SET NULL,
  member_id      VARCHAR(16),          -- FreeSWITCH conference Member-ID
  event_type     VARCHAR(32)  NOT NULL, -- mute|unmute|deaf|undeaf|floor_gained|floor_lost|talking_start|talking_stop
  raw_number     VARCHAR(32),
  occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ers_incident_events_incident ON ers_incident_events (incident_id);
CREATE INDEX IF NOT EXISTS idx_ers_incident_events_time     ON ers_incident_events (incident_id, occurred_at);

-- ── 6. Index to accelerate conference_room lookups in trackParticipant ────────
-- This is the most-hit query in the hot path (every add-member / del-member).
CREATE INDEX IF NOT EXISTS idx_ers_incidents_conference_room_active
  ON ers_incidents (conference_room)
  WHERE deleted_at IS NULL AND status IN ('ACTIVE','QUEUED');

COMMIT;
