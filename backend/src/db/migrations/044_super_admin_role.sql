-- Migration 044: Add SUPER_ADMIN role value
-- SUPER_ADMIN is the platform-level administrator role.
-- It has no fixed tenant_id (tenant_id = NULL) and can manage
-- all tenants, create users in any tenant, and administer the platform.
-- All other roles remain tenant-scoped.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('SUPER_ADMIN','ADMIN','SUPERVISOR','OPERATOR','VIEWER'));

COMMIT;
