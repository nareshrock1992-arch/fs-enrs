-- =============================================================================
-- Migration 028 — Critical Performance Indexes
--
-- Adds indexes that were missing from the original schema migrations and are
-- needed for correctness and performance of Phase 1 bug fixes.
--
-- Why this migration became necessary:
--   • resolveRoom() now queries ers_incidents.conference_room to find DYNAMIC
--     conference rooms — previously only ers_configurations was queried.
--   • ersOverflowEnqueue now uses SELECT ... FOR UPDATE on ers_queues before
--     MAX(position), which benefits from an index on (ers_configuration_id, status).
--   • The /reports/ers-incidents endpoint filters on status + config which has
--     no composite index.
--   • Playback access log queries filter audit_logs by action + date.
--
-- Schema compatibility (verified against migrations 001–027):
--   ers_incidents.conference_room   — added in migration 016 / present since 019
--   ers_incidents.group_type        — present in migration 001
--   ers_incidents.status            — present in migration 001
--   ers_queues columns              — verified in migration 001 / 019
--   audit_logs.action               — present in migration 001
--   emergency_contacts.is_active    — present in migration 001
--
-- Indexes already present (NOT duplicated here):
--   idx_crec_room        — recordings(conference_room, started_at DESC) from mig 022
--   idx_delivery_notif   — ens_notification_deliveries(ens_notification_id) from mig 001
--   idx_audit_time       — audit_logs(created_at DESC) from mig 001
--   idx_recordings_*     — various recordings indexes from mig 026
--   idx_ens_notif_*      — ens_notifications indexes from mig 001
-- =============================================================================

BEGIN;

-- ── ers_incidents: conference_room lookup ─────────────────────────────────────
-- Needed by resolveRoom() DYNAMIC path: WHERE conference_room = $2 AND status = 'ACTIVE'
-- Existing indexes (idx_incident_cfg, idx_incident_status, idx_incident_tenant) do not cover this.
CREATE INDEX IF NOT EXISTS idx_ers_incidents_conference_room
  ON ers_incidents (conference_room)
  WHERE deleted_at IS NULL AND conference_room IS NOT NULL;

-- ── ers_incidents: config + tier + status composite ───────────────────────────
-- Needed by resolveRoom() and tierLiveStatus():
--   WHERE ers_configuration_id = $1 AND group_type = $2 AND status = 'ACTIVE'
-- idx_incident_cfg covers config_id alone but not the composite.
CREATE INDEX IF NOT EXISTS idx_ers_incidents_config_tier_status
  ON ers_incidents (ers_configuration_id, group_type, status)
  WHERE deleted_at IS NULL;

-- ── ers_queues: config + status + position ────────────────────────────────────
-- Needed by ersOverflowEnqueue FOR UPDATE + MAX(position) and
-- completeIncidentCore queue promotion (ORDER BY position ASC).
-- No queue indexes existed before this migration.
CREATE INDEX IF NOT EXISTS idx_ers_queues_config_status_position
  ON ers_queues (ers_configuration_id, status, position)
  WHERE status = 'QUEUED';

-- ── audit_logs: action + date ─────────────────────────────────────────────────
-- Needed by /reports/ens-broadcasts playback access log query:
--   WHERE action = 'ers_playback_attempt' AND created_at >= $1
-- idx_audit_time covers (created_at DESC) but not filtered by action.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_date
  ON audit_logs (action, created_at DESC);

-- ── emergency_contacts: active contacts by org ───────────────────────────────
-- Needed by responder-resolution and contact-usage report queries that filter
--   WHERE deleted_at IS NULL AND is_active = true
-- idx_contact_org exists but does not filter on is_active.
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_active
  ON emergency_contacts (organization_id)
  WHERE deleted_at IS NULL AND is_active = true;

INSERT INTO schema_migrations (version) VALUES ('028_critical_indexes.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
