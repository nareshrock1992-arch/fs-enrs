BEGIN;

-- Phase 4: gateway-agnostic dialing. All testing today happens on local
-- internal SIP extensions (sofia/internal/<ext>@<domain>) — no external
-- trunk is available yet. Production customers front real phones through
-- an Avaya Aura or Cisco UC SIP trunk/gateway (sofia/gateway/<name>/<num>).
-- Nothing in the dial-resolution code should ever hardcode which of these
-- two a call uses — resolveDialString() (services/dialResolver.js)
-- decides per-contact/per-tenant, defaulting to sofia/internal/ with zero
-- gateways configured so the full local acceptance suite runs unmodified.

CREATE TABLE IF NOT EXISTS sip_gateways (
  id                 SERIAL       PRIMARY KEY,
  tenant_id          INT          REFERENCES tenants(id) ON DELETE CASCADE,
  name               VARCHAR(64)  NOT NULL,  -- matches the FreeSWITCH gateway name (sofia/gateway/<name>/...)
  type               VARCHAR(32)  NOT NULL DEFAULT 'generic_sip'
                        CHECK (type IN ('avaya', 'cisco', 'generic_sip', 'other')),
  host               VARCHAR(255) NOT NULL,
  port               INT          NOT NULL DEFAULT 5060,
  username           VARCHAR(128),
  password           VARCHAR(255),
  register           BOOLEAN      NOT NULL DEFAULT true,
  caller_id_in_from  BOOLEAN      NOT NULL DEFAULT false,
  is_default_outbound BOOLEAN     NOT NULL DEFAULT false,
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  last_deployed_at   TIMESTAMPTZ,
  last_deployment_status VARCHAR(16),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sip_gateways_tenant ON sip_gateways (tenant_id) WHERE deleted_at IS NULL;

-- Only one default-outbound gateway per tenant — enforced at the app
-- layer on write (see gatewayController.js), this index just makes the
-- invariant visible/queryable, not a hard DB constraint (a partial unique
-- index on is_default_outbound=true per tenant would also work, but the
-- app-layer "unset the previous default" transaction is clearer to audit).

-- Per-contact gateway override — defaults to the tenant's
-- is_default_outbound gateway (or sofia/internal/ if none configured)
-- when NULL. One column covers both ERS (ers_tier_contacts.contact_id)
-- and ENS (ens_configuration_contacts.emergency_contact_id) — both
-- ultimately reference emergency_contacts.id.
ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS gateway_id INT REFERENCES sip_gateways(id) ON DELETE SET NULL;

COMMIT;
