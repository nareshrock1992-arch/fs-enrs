-- =============================================================================
-- sample_data_yasref.sql
-- Complete YASREF test data for ENS/ERS production verification
-- =============================================================================
--
-- Creates:
--   - YASREF tenant + organization
--   - 5 Tier-1 responder groups + contacts (1001–1005)
--   - 5 Tier-2 responder groups + contacts (2001–2005)
--   - ERS Configuration for 1222 (Bridge1=7000, Bridge2=7001)
--   - ENS Configuration for 1888 (Playback=1999, PIN=1234)
--   - Service registry entries for all numbers
--
-- Safe to re-run (uses INSERT ... ON CONFLICT DO NOTHING).
-- Run AFTER all migrations (001–010).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TENANT
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO tenants (name, slug, is_active, created_at)
VALUES ('YASREF', 'yasref', true, now())
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ORGANIZATION
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO organizations (name, slug, tenant_id, is_active, created_at)
SELECT 'YASREF Security Operations', 'yasref-security', t.id, true, now()
FROM tenants t WHERE t.slug = 'yasref'
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RESPONDER GROUPS (Tier 1)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO responder_groups (name, description, organization_id, is_active, created_at)
SELECT g.name, g.description, o.id, true, now()
FROM organizations o,
     (VALUES
       ('Fire Team Alpha',    'Primary fire response team'),
       ('Medical Team Alpha', 'Primary medical response team'),
       ('CCB Alpha',          'Crisis coordination board — primary'),
       ('Safety Alpha',       'Safety officers — primary tier'),
       ('SCC Alpha',          'Security control center — primary')
     ) AS g(name, description)
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RESPONDER GROUPS (Tier 2)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO responder_groups (name, description, organization_id, is_active, created_at)
SELECT g.name, g.description, o.id, true, now()
FROM organizations o,
     (VALUES
       ('Fire Team Bravo',    'Secondary fire response team'),
       ('Medical Team Bravo', 'Secondary medical response team'),
       ('CCB Bravo',          'Crisis coordination board — secondary'),
       ('Safety Bravo',       'Safety officers — secondary tier'),
       ('SCC Bravo',          'Security control center — secondary')
     ) AS g(name, description)
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CONTACTS — Tier 1 (extensions 1001–1005)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO emergency_contacts
  (first_name, last_name, mobile_number, internal_extension,
   role, organization_id, is_active, created_at)
SELECT c.first_name, c.last_name, c.mobile, c.ext,
       c.role, o.id, true, now()
FROM organizations o,
     (VALUES
       ('Ahmed',   'Al-Farid',   '1001', '1001', 'Fire Responder'),
       ('Sara',    'Al-Rashidi', '1002', '1002', 'Medical Officer'),
       ('Khalid',  'Al-Mansoor', '1003', '1003', 'CCB Coordinator'),
       ('Fatima',  'Al-Zahrani', '1004', '1004', 'Safety Officer'),
       ('Omar',    'Al-Harbi',   '1005', '1005', 'SCC Operator')
     ) AS c(first_name, last_name, mobile, ext, role)
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CONTACTS — Tier 2 (extensions 2001–2005)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO emergency_contacts
  (first_name, last_name, mobile_number, internal_extension,
   role, organization_id, is_active, created_at)
SELECT c.first_name, c.last_name, c.mobile, c.ext,
       c.role, o.id, true, now()
FROM organizations o,
     (VALUES
       ('Nasser', 'Al-Dossari', '2001', '2001', 'Fire Responder (Backup)'),
       ('Mona',   'Al-Qahtani', '2002', '2002', 'Medical Officer (Backup)'),
       ('Walid',  'Al-Shehri',  '2003', '2003', 'CCB Coordinator (Backup)'),
       ('Hessa',  'Al-Otaibi',  '2004', '2004', 'Safety Officer (Backup)'),
       ('Turki',  'Al-Ghamdi',  '2005', '2005', 'SCC Operator (Backup)')
     ) AS c(first_name, last_name, mobile, ext, role)
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. MAP CONTACTS INTO GROUPS
-- ─────────────────────────────────────────────────────────────────────────────

-- Tier 1 group memberships
INSERT INTO responder_group_members (responder_group_id, emergency_contact_id)
SELECT rg.id, c.id
FROM responder_groups rg
JOIN emergency_contacts c ON c.organization_id = rg.organization_id
JOIN organizations o ON o.id = rg.organization_id
WHERE o.slug = 'yasref-security'
  AND (
    (rg.name = 'Fire Team Alpha'    AND c.internal_extension = '1001') OR
    (rg.name = 'Medical Team Alpha' AND c.internal_extension = '1002') OR
    (rg.name = 'CCB Alpha'          AND c.internal_extension = '1003') OR
    (rg.name = 'Safety Alpha'       AND c.internal_extension = '1004') OR
    (rg.name = 'SCC Alpha'          AND c.internal_extension = '1005')
  )
ON CONFLICT DO NOTHING;

-- Tier 2 group memberships
INSERT INTO responder_group_members (responder_group_id, emergency_contact_id)
SELECT rg.id, c.id
FROM responder_groups rg
JOIN emergency_contacts c ON c.organization_id = rg.organization_id
JOIN organizations o ON o.id = rg.organization_id
WHERE o.slug = 'yasref-security'
  AND (
    (rg.name = 'Fire Team Bravo'    AND c.internal_extension = '2001') OR
    (rg.name = 'Medical Team Bravo' AND c.internal_extension = '2002') OR
    (rg.name = 'CCB Bravo'          AND c.internal_extension = '2003') OR
    (rg.name = 'Safety Bravo'       AND c.internal_extension = '2004') OR
    (rg.name = 'SCC Bravo'          AND c.internal_extension = '2005')
  )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ERS CONFIGURATION — 1222
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO ers_configurations (
  organization_id, name, description,
  primary_bridge_number, secondary_bridge_number, conference_profile,
  max_concurrent_conferences, max_conference_duration_min,
  queue_enabled, queue_timeout_sec, queue_priority,
  record_conferences, recording_directory,
  retry_ring_count, retry_ring_interval,
  allow_rejoin, cli_authentication, pin,
  primary_retry_count, primary_retry_interval_sec,
  secondary_retry_count, secondary_retry_interval_sec,
  is_active, created_at
)
SELECT
  o.id,
  'YASREF Emergency Response',
  'Primary ERS configuration for YASREF Security Operations',
  '7000', '7001', 'default',
  2, 0,
  true, 300, 5,
  true, '/opt/freeswitch/recordings/ers',
  3, 30,
  true, false, null,
  3, 30,
  3, 30,
  true, now()
FROM organizations o
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. ERS TIER GROUPS
-- ─────────────────────────────────────────────────────────────────────────────

-- Tier 1 groups → primary tier
INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id)
SELECT ec.id, 'primary', rg.id
FROM ers_configurations ec
JOIN organizations o ON o.id = ec.organization_id
JOIN responder_groups rg ON rg.organization_id = o.id
WHERE o.slug = 'yasref-security'
  AND ec.name = 'YASREF Emergency Response'
  AND rg.name IN ('Fire Team Alpha','Medical Team Alpha','CCB Alpha','Safety Alpha','SCC Alpha')
ON CONFLICT DO NOTHING;

-- Tier 2 groups → secondary tier
INSERT INTO ers_tier_groups (ers_configuration_id, tier, group_id)
SELECT ec.id, 'secondary', rg.id
FROM ers_configurations ec
JOIN organizations o ON o.id = ec.organization_id
JOIN responder_groups rg ON rg.organization_id = o.id
WHERE o.slug = 'yasref-security'
  AND ec.name = 'YASREF Emergency Response'
  AND rg.name IN ('Fire Team Bravo','Medical Team Bravo','CCB Bravo','Safety Bravo','SCC Bravo')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. ENS CONFIGURATION — 1888
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO ens_configurations (
  organization_id, name, description,
  blast_clid, reply_clid, pin,
  max_concurrent_calls, max_concurrent, calls_per_second, batch_size,
  max_attempts, retry_count, retry_interval_sec, retry_delay_seconds,
  campaign_timeout_min, recording_retention_hours,
  retry_failed_only, adaptive_throttling, campaign_priority,
  max_active_campaigns, playback_number,
  no_pending_msg, expiry_announcement,
  is_active, created_at
)
SELECT
  o.id,
  'YASREF Emergency Notification',
  'Primary ENS blast system for YASREF operations',
  '1888', '1888', '1234',
  30, 30, 2.0, 30,
  3, 3, 60, 60,
  120, 24,
  false, true, 5,
  1, '1999',
  'There are no pending emergency notifications at this time.',
  'This emergency notification has expired.',
  true, now()
FROM organizations o
WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. ENS CONTACT GROUPS (all tier-1 and tier-2 groups receive blasts)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id)
SELECT ec.id, rg.id
FROM ens_configurations ec
JOIN organizations o ON o.id = ec.organization_id
JOIN responder_groups rg ON rg.organization_id = o.id
WHERE o.slug = 'yasref-security'
  AND ec.name = 'YASREF Emergency Notification'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. SERVICE REGISTRY — emergency_numbers
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO emergency_numbers (
  number, type, organization_id, tenant_id,
  ers_configuration_id, ens_configuration_id,
  service_name, description,
  icon, color, sort_order, is_active, created_at
)
SELECT
  '1222', 'ERS',
  o.id, o.tenant_id,
  (SELECT id FROM ers_configurations WHERE name='YASREF Emergency Response' AND deleted_at IS NULL LIMIT 1),
  NULL,
  'Emergency Response', 'Dial 1222 to activate emergency conference bridge',
  'shield-alert', 'red', 1, true, now()
FROM organizations o WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

INSERT INTO emergency_numbers (
  number, type, organization_id, tenant_id,
  ens_configuration_id, ers_configuration_id,
  service_name, description,
  icon, color, sort_order, is_active, created_at
)
SELECT
  '1888', 'ENS',
  o.id, o.tenant_id,
  (SELECT id FROM ens_configurations WHERE name='YASREF Emergency Notification' AND deleted_at IS NULL LIMIT 1),
  NULL,
  'Emergency Blast', 'Dial 1888 to send emergency notification blast',
  'bell', 'orange', 2, true, now()
FROM organizations o WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

INSERT INTO emergency_numbers (
  number, type, organization_id, tenant_id,
  ens_configuration_id, ers_configuration_id,
  service_name, description,
  icon, color, sort_order, is_active, created_at
)
SELECT
  '1999', 'ENS',
  o.id, o.tenant_id,
  (SELECT id FROM ens_configurations WHERE name='YASREF Emergency Notification' AND deleted_at IS NULL LIMIT 1),
  NULL,
  'Blast Playback', 'Dial 1999 to hear the latest emergency notification',
  'radio', 'blue', 3, true, now()
FROM organizations o WHERE o.slug = 'yasref-security'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_org_id      INT;
  v_ers_id      INT;
  v_ens_id      INT;
  v_t1_groups   INT;
  v_t2_groups   INT;
  v_t1_contacts INT;
  v_t2_contacts INT;
  v_numbers     INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug='yasref-security';
  SELECT id INTO v_ers_id FROM ers_configurations WHERE name='YASREF Emergency Response' AND deleted_at IS NULL;
  SELECT id INTO v_ens_id FROM ens_configurations  WHERE name='YASREF Emergency Notification' AND deleted_at IS NULL;

  SELECT COUNT(*) INTO v_t1_groups   FROM ers_tier_groups WHERE ers_configuration_id=v_ers_id AND tier='primary';
  SELECT COUNT(*) INTO v_t2_groups   FROM ers_tier_groups WHERE ers_configuration_id=v_ers_id AND tier='secondary';
  SELECT COUNT(*) INTO v_t1_contacts FROM emergency_contacts WHERE organization_id=v_org_id AND internal_extension IN ('1001','1002','1003','1004','1005');
  SELECT COUNT(*) INTO v_t2_contacts FROM emergency_contacts WHERE organization_id=v_org_id AND internal_extension IN ('2001','2002','2003','2004','2005');
  SELECT COUNT(*) INTO v_numbers     FROM emergency_numbers   WHERE organization_id=v_org_id AND deleted_at IS NULL;

  RAISE NOTICE '=== YASREF Sample Data Verification ===';
  RAISE NOTICE 'Organization ID : %', v_org_id;
  RAISE NOTICE 'ERS Config ID   : %', v_ers_id;
  RAISE NOTICE 'ENS Config ID   : %', v_ens_id;
  RAISE NOTICE 'Tier-1 groups   : % (expect 5)', v_t1_groups;
  RAISE NOTICE 'Tier-2 groups   : % (expect 5)', v_t2_groups;
  RAISE NOTICE 'Tier-1 contacts : % (expect 5)', v_t1_contacts;
  RAISE NOTICE 'Tier-2 contacts : % (expect 5)', v_t2_contacts;
  RAISE NOTICE 'Service numbers : % (expect 3)', v_numbers;
  RAISE NOTICE '========================================';

  IF v_t1_groups < 5 THEN RAISE WARNING 'Tier-1 groups incomplete!'; END IF;
  IF v_t2_groups < 5 THEN RAISE WARNING 'Tier-2 groups incomplete!'; END IF;
  IF v_numbers   < 3 THEN RAISE WARNING 'Service numbers incomplete!'; END IF;
END $$;

COMMIT;
