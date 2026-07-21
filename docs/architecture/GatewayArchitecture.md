# Gateway Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Purpose

The Gateway Manager owns all SIP gateway configuration — from database record to deployed FreeSWITCH XML. Business modules never reference gateways directly. The routing layer selects gateways. The Gateway Manager deploys them.

---

## The `sip_gateways` Table

```sql
sip_gateways:
  id                       SERIAL PRIMARY KEY
  tenant_id                INT REFERENCES tenants(id) ON DELETE CASCADE
  name                     VARCHAR(64) NOT NULL          -- FS gateway name (sofia/gateway/<name>/...)
  type                     VARCHAR(32) DEFAULT 'generic_sip'
                             CHECK (type IN ('avaya','cisco','generic_sip','other'))
  host                     VARCHAR(255) NOT NULL
  port                     INT DEFAULT 5060
  username                 VARCHAR(128)
  password                 VARCHAR(255)
  register                 BOOLEAN DEFAULT true
  caller_id_in_from        BOOLEAN DEFAULT false
  is_default_outbound      BOOLEAN DEFAULT false         -- enforced: one per tenant
  is_active                BOOLEAN DEFAULT true
  last_deployed_at         TIMESTAMPTZ
  last_deployment_status   VARCHAR(16)

  -- Wave 1 additions (additive, safe defaults)
  priority                 INT DEFAULT 10                -- lower = preferred (failover)
  max_concurrent_calls     INT                           -- carrier channel cap
  calls_per_second         NUMERIC(5,2)                 -- CPS throttle
  prefix_add               VARCHAR(16)                  -- prepend to all outbound numbers
  prefix_strip             VARCHAR(16)                  -- strip from outbound numbers
  e164_normalize           BOOLEAN DEFAULT false         -- normalize to E.164 before dial
  transport                VARCHAR(8) DEFAULT 'UDP'
                             CHECK (transport IN ('UDP','TCP','TLS'))
  provider                 VARCHAR(32) DEFAULT 'freeswitch'  -- selects Provider Layer impl
  outbound_clid_override   VARCHAR(32)                  -- carrier-mandated CLID override

  UNIQUE (tenant_id, name)
  deleted_at               TIMESTAMPTZ
```

### One-Default-Per-Tenant Rule

Only one gateway per tenant may have `is_default_outbound = true`. Enforced at the application layer in `gatewayController.js` — when a gateway is set as default, all other gateways for the same tenant are updated in the same transaction:

```javascript
await tq(`UPDATE sip_gateways SET is_default_outbound = false
           WHERE tenant_id = $1 AND id != $2`, [tenantId, gatewayId]);
await tq(`UPDATE sip_gateways SET is_default_outbound = true
           WHERE id = $1`, [gatewayId]);
```

A database partial unique index on `(tenant_id) WHERE is_default_outbound = true` would make this a DB-level constraint. Preferred for Wave 2 (add as an additive migration — no existing data changes).

---

## Per-Contact Gateway Override

`emergency_contacts.gateway_id INT REFERENCES sip_gateways(id)` provides per-contact routing:

- A contact with an internal SIP extension → `gateway_id = NULL` → routes via `user/<extension>`
- A contact with a mobile on a specific PSTN trunk → `gateway_id = 5` → routes via that gateway

This covers mixed responder pools (internal extensions + external mobiles) without requiring two separate contact lists.

---

## Per-Module Gateway References

| Module | Column | Type | Resolution |
|---|---|---|---|
| ENS | `ens_configurations.sip_gateway_id` | INT FK (Wave 1) | Direct FK lookup |
| ENS | `ens_configurations.sip_gateway` | VARCHAR (legacy) | Name-based fallback |
| ERS | `ers_configurations.sip_gateway_id` | INT FK (Wave 1) | Direct FK lookup |
| Contact | `emergency_contacts.gateway_id` | INT FK | Per-contact override |
| Campaign | `campaignEngine.gatewayName` | STRING | Legacy; reads `sip_gateway` string |

After Wave 1: ENS and ERS configurations reference gateways by FK. The string `sip_gateway` column on `ens_configurations` is retained for backward compatibility but the FK takes precedence.

---

## Gateway Deployment Pipeline

Deploying a gateway writes its FreeSWITCH XML to disk and instructs FS to reload:

```
1. Validate gateway config (host reachable? username/password set if register=true?)
2. Generate FreeSWITCH gateway XML via gatewayXmlGenerator.js
3. Write XML to: {FS_AUTOLOAD_CONFIGS}/sip_profiles/external/{gateway_name}.xml
4. Issue ESL command: reloadxml
5. Issue ESL command: sofia profile external rescan
6. Verify gateway appears in: sofia status gateway {gateway_name}
7. Update sip_gateways.last_deployed_at and last_deployment_status
```

### `gatewayXmlGenerator.js`

Currently generates: `username`, `password`, `realm`, `proxy`, `register`, `caller-id-in-from`.

Wave 2 additions:
- `expire-seconds` (registration expiry)
- `retry-seconds` (re-registration retry)
- `transport` (UDP/TCP/TLS)
- `ping` (keepalive)
- `auth-user` (when different from username)

---

## `esl_connections` — Reserved for Wave 6

The `esl_connections` table (migration 001) was designed for multi-cluster support. It is **not queried by any current application code**. ESL connection parameters come from environment variables.

**Do not delete this table.** Wave 6 (multi-site) will activate it as the registry of FreeSWITCH cluster connections, one row per site. The schema will likely need revision at that time.

```sql
esl_connections (RESERVED — not currently read by application):
  id, name, host, port, password, is_active, last_heartbeat_at
```

---

## Gateway Health Monitoring _(Future)_

`sip_gateways.last_deployment_status` currently tracks deployment state. Future: add a `health_status` column updated by periodic ESL `sofia status gateway` checks. The monitoring dashboard should surface gateway registration state.

---

## Adding a New Gateway Type

To add support for a new gateway vendor (e.g., Ribbon SBC):

1. Add `'ribbon_sbc'` to the `type` CHECK constraint in a new migration
2. Add any Ribbon-specific XML elements to `gatewayXmlGenerator.js`
3. Create a new Provider in `src/providers/ribbonProvider.js` if Ribbon requires a different protocol than FreeSWITCH sofia (otherwise it's just a FreeSWITCH gateway with a different XML profile)

No business module changes. No routing layer changes.
