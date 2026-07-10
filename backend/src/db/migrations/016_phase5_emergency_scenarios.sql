BEGIN;

-- Phase 5: full 3-scenario ERS emergency flow + Blast Call + Playback.
-- Extends the existing, already-functional schema (ers_tier_groups,
-- ers_tier_contacts, ers_incidents, ens_configurations, ens_notifications,
-- ers_queues) — nothing here duplicates what's already built.

-- ── A1: Level 1 / Level 2 are independent concurrent incidents ────────────────
-- tier_group_id ties an incident to the specific ers_tier_groups row (tier +
-- responder group) that was rung for it, so two tiers ringing simultaneously
-- for the same ers_configuration_id are genuinely separate incident rows,
-- each with its own conference_room/started_at/recording_path/status —
-- which is already true structurally (ers_incidents.group_type distinguishes
-- primary/secondary), this column just lets a query join back to exactly
-- which tier_group definition was used, since one config can have multiple
-- groups per tier.
ALTER TABLE ers_incidents
  ADD COLUMN IF NOT EXISTS tier_group_id INT REFERENCES ers_tier_groups(id) ON DELETE SET NULL;

-- ── A2: Participant-level detail — backs rejoin support + reporting ───────────
-- One row per leg that ever joined a conference room, independent of the
-- incident's own status. This is what makes "responder dropped and
-- rejoined the SAME conference" reportable in detail (join/leave/rejoin
-- timestamps per person), rather than only knowing the incident-level
-- status. ers_incident_responders already exists and remains the
-- authoritative "was this responder invited/joined/missed" record for
-- dispatch — this table is the detailed, repeatable-event audit trail
-- report queries actually want (GET /reports/ers-incidents needs "all
-- participants (join/leave/rejoin)", which a single status column can't
-- represent for someone who left and came back twice).
CREATE TABLE IF NOT EXISTS ers_incident_participants (
  id            BIGSERIAL    PRIMARY KEY,
  incident_id   INT          NOT NULL REFERENCES ers_incidents(id) ON DELETE CASCADE,
  contact_id    INT          REFERENCES emergency_contacts(id) ON DELETE SET NULL,
  raw_number    VARCHAR(32), -- caller/responder number when not a known contact
  role          VARCHAR(16)  NOT NULL DEFAULT 'responder'
                   CHECK (role IN ('initiator', 'responder')),
  joined_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  left_at       TIMESTAMPTZ,
  rejoined_at   TIMESTAMPTZ, -- set on each subsequent rejoin; left_at/joined_at track the CURRENT leg
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ers_participants_incident ON ers_incident_participants (incident_id);

-- ── A3: ers_queues — overflow requirement fields ──────────────────────────────
-- caller_number already exists (migration 002 B10). caller_name and
-- destination_number were missing — needed so Caller C's identity and the
-- number they dialed survive the wait without a join back to a live call
-- session (which won't exist once FreeSWITCH has parked/queued them).
ALTER TABLE ers_queues
  ADD COLUMN IF NOT EXISTS caller_name        VARCHAR(128),
  ADD COLUMN IF NOT EXISTS destination_number VARCHAR(32);

-- ── A4: Authorized playback line (UUUU number) ────────────────────────────────
CREATE TABLE IF NOT EXISTS ers_playback_lines (
  id                   SERIAL       PRIMARY KEY,
  tenant_id            INT          REFERENCES tenants(id) ON DELETE CASCADE,
  ers_configuration_id INT          REFERENCES ers_configurations(id) ON DELETE CASCADE,
  authorized_callers   TEXT[]       NOT NULL DEFAULT '{}', -- normalized numbers allowed to dial in
  message_recording_path VARCHAR(512),
  message_started_at   TIMESTAMPTZ, -- last recording START time; expires message_started_at + 24h
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ers_playback_lines_tenant ON ers_playback_lines (tenant_id) WHERE deleted_at IS NULL;

-- ── A0: ers_configurations — ring_timeout_seconds ─────────────────────────────
-- NULL = ring indefinitely (bounded internally by MAX_RING_MINUTES in
-- ersInternalController.js as a runaway-job safety cap, never surfaced as
-- a user-facing limit). Distinct from the existing retry_ring_count /
-- retry_ring_interval fields, which govern per-leg retry pacing — this is
-- the overall "give up ringing after N seconds with nobody answering"
-- ceiling for a whole ring-all pass.
ALTER TABLE ers_configurations
  ADD COLUMN IF NOT EXISTS ring_timeout_seconds INT;

-- ── A5: ens_notifications — PIN verification + recorder audit trail ───────────
ALTER TABLE ens_notifications
  ADD COLUMN IF NOT EXISTS pin_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recorded_by     INT REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
