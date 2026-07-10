BEGIN;

-- Test Mode: replaces the ad-hoc manual dialplan patch (a hand-inserted
-- <action application="set" data="caller_id_number=..."/> ) that was used
-- to work around ERS/ENS internal API validation requiring caller_number
-- to be 7+ characters — internal SIP test extensions like "1001" fail
-- that check, which is legitimate validation and must not be weakened.
--
-- Test Mode is OFF by default and only affects flows explicitly marked
-- is_test_flow = true. The deploy pipeline (deploymentEngine.js) injects
-- the caller-ID override only for those flows, only while enabled, and
-- the frontend shows a persistent "TEST MODE ACTIVE" banner whenever it
-- is on — a supported, visible, reversible mechanism instead of a
-- silent manual edit to generated files.

ALTER TABLE ivr_flows
  ADD COLUMN IF NOT EXISTS is_test_flow BOOLEAN NOT NULL DEFAULT false;

INSERT INTO system_settings (key, value, description)
VALUES
  ('test_mode_enabled',   'false',      'When true, flows marked as test flows get a caller-ID override injected at deploy time so short lab SIP extensions pass ERS/ENS 7+ character validation. Never enable in production.'),
  ('test_mode_caller_id', '5551234567', 'Caller ID substituted for test flows while Test Mode is enabled. Must be 7+ characters to pass ERS/ENS internal API validation.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
