-- Migration 028: Critical performance and correctness indexes
-- Fixes: resolveRoom DYNAMIC mode, tenant-scoped monitoring queries,
--        queue position lookups, and active incident lookups.

BEGIN;

-- ers_incidents: conference_room lookup (resolveRoom DYNAMIC mode, ESL event handler)
CREATE INDEX IF NOT EXISTS idx_ers_incidents_conference_room
  ON ers_incidents (conference_room)
  WHERE deleted_at IS NULL;

-- ers_incidents: active incident lookup by config + tier (resolveRoom, tierLiveStatus)
CREATE INDEX IF NOT EXISTS idx_ers_incidents_config_tier_status
  ON ers_incidents (ers_configuration_id, group_type, status)
  WHERE deleted_at IS NULL;

-- ers_queues: queue position lookup and promotion (ersOverflowEnqueue, completeIncidentCore)
CREATE INDEX IF NOT EXISTS idx_ers_queues_config_status_position
  ON ers_queues (ers_configuration_id, status, position)
  WHERE status = 'QUEUED';

-- ens_notifications: tenant-scoped status+date filter for reports
CREATE INDEX IF NOT EXISTS idx_ens_notifications_tenant_status_created
  ON ens_notifications (ens_configuration_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- ens_notification_deliveries: per-notification delivery lookup (report join)
CREATE INDEX IF NOT EXISTS idx_ens_notification_deliveries_notif_id
  ON ens_notification_deliveries (ens_notification_id);

-- emergency_contacts: tenant-scoped active lookup (contact-usage report, responder resolution)
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_active
  ON emergency_contacts (organization_id)
  WHERE deleted_at IS NULL AND is_active = true;

-- audit_logs: action + date filter (playback access report)
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs (action, created_at DESC);

-- recordings: conference room lookup (recording_path sync)
CREATE INDEX IF NOT EXISTS idx_recordings_conf_name
  ON recordings (conf_name)
  WHERE deleted_at IS NULL;

COMMIT;
