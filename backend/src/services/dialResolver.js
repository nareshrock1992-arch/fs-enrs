/**
 * Gateway-agnostic dial string resolution — Phase 4.
 *
 * The ONE place a FreeSWITCH dial string (`user/...` or
 * `sofia/gateway/.../...`) gets constructed. Every call-origination path
 * in this codebase (ERS ring-all, ENS campaign engine, ad-hoc test
 * originate) must go through resolveDialString() — never inline
 * "user/" or "sofia/gateway/" anywhere else.
 *
 * All testing today happens on local internal SIP extensions — no
 * external trunk is available. Production customers front real phones
 * through a real Avaya Aura or Cisco UC SIP trunk (a row in
 * sip_gateways). With zero gateways configured, every call below
 * defaults to user/<extension> automatically (FreeSWITCH resolves the
 * registered contact) — the full local acceptance suite runs with no
 * admin setup. Connecting a real PBX later is a config change (add a
 * sip_gateways row, optionally override individual contacts) — see
 * docs/CONNECTING_A_PBX.md — never a code change.
 */

import { query } from '../db/pool.js';

/**
 * @param {object} opts
 * @param {number} [opts.tenantId]        — used to look up the tenant's default gateway
 * @param {number} [opts.contactId]       — emergency_contacts.id; resolves extension/mobile/gateway override from it
 * @param {string} [opts.extension]       — explicit internal extension (overrides contact lookup)
 * @param {string} [opts.mobileNumber]    — explicit external number (overrides contact lookup)
 * @param {number} [opts.gatewayId]       — explicit gateway override by ID (highest priority)
 * @param {string} [opts.gatewayName]     — explicit gateway override by name (e.g. a legacy
 *                                          ens_configurations.sip_gateway string column) — looked
 *                                          up in sip_gateways for this tenant if possible, else
 *                                          used as a raw FreeSWITCH gateway name directly for
 *                                          backward compatibility with pre-Phase-4 configs
 * @param {string} [opts.domain]          — DEPRECATED, ignored: local users are dialed via
 *                                          user/<ext> (FreeSWITCH resolves the registered
 *                                          contact), so no domain is needed. Accepted so
 *                                          existing callers don't break.
 * @returns {Promise<{ dialString: string, mode: 'internal'|'gateway', gateway: object|null }>}
 */
export async function resolveDialString({
  tenantId,
  contactId,
  extension,
  mobileNumber,
  gatewayId,
  gatewayName,
  domain: _domain, // deprecated, ignored — see docblock
} = {}) {
  let ext = extension || null;
  let mobile = mobileNumber || null;
  let resolvedGatewayId = gatewayId ?? null;

  if (contactId) {
    const { rows: [contact] } = await query(
      `SELECT extension_number, mobile_number, gateway_id
       FROM emergency_contacts WHERE id = $1 AND deleted_at IS NULL`,
      [contactId]
    );
    if (contact) {
      ext    = ext    ?? contact.extension_number;
      mobile = mobile ?? contact.mobile_number;
      resolvedGatewayId = resolvedGatewayId ?? contact.gateway_id;
    }
  }

  let gateway = null;
  let rawGatewayName = null;

  if (resolvedGatewayId) {
    const { rows: [g] } = await query(
      `SELECT * FROM sip_gateways WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
      [resolvedGatewayId]
    );
    gateway = g || null;
  } else if (gatewayName) {
    const { rows: [g] } = await query(
      `SELECT * FROM sip_gateways
       WHERE name = $1 AND is_active = true AND deleted_at IS NULL
         AND ($2::int IS NULL OR tenant_id = $2)
       LIMIT 1`,
      [gatewayName, tenantId ?? null]
    );
    // Not every gateway is registered in sip_gateways yet (pre-Phase-4
    // configs stored a raw FreeSWITCH gateway name as a plain string) —
    // fall back to using the name directly rather than treating an
    // unregistered name as "no gateway."
    gateway = g || null;
    if (!gateway) rawGatewayName = gatewayName;
  } else if (tenantId) {
    const { rows: [g] } = await query(
      `SELECT * FROM sip_gateways
       WHERE tenant_id = $1 AND is_default_outbound = true AND is_active = true AND deleted_at IS NULL
       LIMIT 1`,
      [tenantId]
    );
    gateway = g || null;
  }

  if (gateway || rawGatewayName) {
    const number = mobile || ext;
    if (!number) {
      throw new Error('resolveDialString: a gateway is configured but no destination number is available (need mobile_number or extension)');
    }
    const name = gateway ? gateway.name : rawGatewayName;
    return { dialString: `sofia/gateway/${name}/${number}`, mode: 'gateway', gateway };
  }

  // Default — zero gateways configured, dial the locally registered
  // FreeSWITCH user.
  //
  // user/<extension>, NOT sofia/internal/<ext>@<domain>: a registered
  // softphone's real contact is something like
  // sip:1001@192.168.1.105:62027;ob — dialing the profile IP directly
  // returns NO_USER_RESPONSE because nothing is listening at
  // <ext>@<profile-ip>. `user/` makes FreeSWITCH resolve the registered
  // contact itself (equivalent to sofia_contact lookup), which is the
  // correct mechanism for local users and needs no IP/domain at all.
  // This branch is ONLY reached when no gateway resolves — production
  // Avaya/Cisco/trunk routing (the gateway branch above) is untouched.
  const dest = ext || mobile;
  if (!dest) {
    throw new Error('resolveDialString: no extension or mobile number available to dial');
  }
  return { dialString: `user/${dest}`, mode: 'internal', gateway: null };
}
