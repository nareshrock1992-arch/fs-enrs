-- ============================================================
--  Migration 035 — Gateway Dialing Policy
--
--  Moves all number-formatting and routing-capability intelligence
--  from ENS configurations into SIP gateway configuration.
--
--  Design principle:
--    ENS decides WHAT to dial (mobile number or extension).
--    The gateway decides HOW to format and route that number.
--    Every future outbound module (Contact Center, AI Voice, etc.)
--    can reuse the same gateway dialing rules without embedding
--    carrier-specific logic in each application.
--
--  Gateway routing capabilities:
--    allow_mobile    — whether this gateway accepts mobile/PSTN numbers
--    allow_extension — whether this gateway can route internal extensions
--
--  Gateway formatting rules:
--    Mobile: optional strip-leading-zero → optional prefix → optional suffix
--    Extension: optional prefix → optional suffix
--
--  Per-destination gateway snapshot:
--    ens_campaign_destinations.gateway_name captures which gateway
--    was selected at campaign creation time so the execution engine
--    never re-reads emergency_contacts at dial time.
--
--  Safety: all DROP COLUMN use IF EXISTS so this migration is safe
--  to run whether or not migration 034 added the columns first.
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- A: Remove normalization columns from ens_configurations
--    (they were added briefly in 034 before this arch decision;
--     IF EXISTS makes this idempotent regardless of 034 status)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_configurations
  DROP COLUMN IF EXISTS mobile_normalize_enabled,
  DROP COLUMN IF EXISTS mobile_strip_leading_zero,
  DROP COLUMN IF EXISTS mobile_prefix,
  DROP COLUMN IF EXISTS ext_normalize_enabled,
  DROP COLUMN IF EXISTS ext_prefix,
  DROP COLUMN IF EXISTS ext_suffix,
  DROP COLUMN IF EXISTS allow_ext_through_gateway;

-- ─────────────────────────────────────────────────────────────
-- B: Add dialing policy to sip_gateways
-- ─────────────────────────────────────────────────────────────

ALTER TABLE sip_gateways
  -- Routing capability: which number types this gateway accepts
  ADD COLUMN IF NOT EXISTS allow_mobile           BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_extension        BOOLEAN      NOT NULL DEFAULT false,

  -- Mobile number formatting applied before originate
  ADD COLUMN IF NOT EXISTS mobile_normalize_enabled  BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_strip_leading_zero BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_prefix          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS mobile_suffix          VARCHAR(20),

  -- Extension formatting (for PBXs that require prefix/suffix)
  ADD COLUMN IF NOT EXISTS ext_normalize_enabled  BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ext_prefix             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ext_suffix             VARCHAR(20);

-- ─────────────────────────────────────────────────────────────
-- C: Capture the resolved gateway per destination
--    Null = internal routing (user/<ext>)
--    Non-null = sofia/gateway/<gateway_name>/<phone_number>
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ens_campaign_destinations
  ADD COLUMN IF NOT EXISTS gateway_name VARCHAR(100);

COMMIT;
