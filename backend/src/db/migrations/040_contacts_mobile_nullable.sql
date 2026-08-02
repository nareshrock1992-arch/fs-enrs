-- Migration 040: Allow emergency_contacts.mobile_number to be NULL.
--
-- Contacts may have an extension number only (internal FreeSWITCH routing)
-- without a mobile number. The previous NOT NULL constraint forced mobile_number
-- to be supplied at the API layer even for extension-only contacts, which is
-- incorrect. At least one of mobile_number or extension_number must be non-null;
-- that invariant is enforced at the application layer (Zod refine).

BEGIN;

ALTER TABLE emergency_contacts
  ALTER COLUMN mobile_number DROP NOT NULL;

COMMIT;
