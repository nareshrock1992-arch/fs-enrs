-- Migration 049: Remove orphaned schema_migrations row from migration 048 defect.
--
-- Migration 048 (048_ens_announcement_audio.sql) incorrectly self-registered
-- using the short key '048' instead of the full filename
-- '048_ens_announcement_audio.sql'. The migration runner records the full
-- filename, so every fresh installation from the defective 048 produced two
-- rows: '048' (orphaned, wrong) and '048_ens_announcement_audio.sql' (correct).
--
-- This migration removes the orphaned '048' row if it exists.
-- It is idempotent: ON CONFLICT / DELETE WHERE is safe to run multiple times.
-- Databases that never ran the defective 048 are unaffected.

BEGIN;

DELETE FROM schema_migrations WHERE version = '048';

COMMIT;
