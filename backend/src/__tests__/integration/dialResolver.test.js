/**
 * Phase 4 testing gate, verbatim: "confirm resolveDialString() defaults
 * correctly to internal extensions with zero gateways configured. Add
 * one test/dummy gateway entry... and confirm exactly one contact's dial
 * string switches to sofia/gateway/... with no other code touched."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../db/pool.js';
import { resolveDialString } from '../../services/dialResolver.js';

let tenantId, orgId, contactAId, contactBId, gatewayId;

beforeAll(async () => {
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('Phase4DialResolverTenant', $1) RETURNING id`,
    [`p4dial-${Date.now()}`]
  );
  tenantId = t.id;

  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('Phase4DialResolverOrg', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.id;

  const { rows: [a] } = await query(
    `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number, extension_number)
     VALUES ($1, 'Alice', 'Test', '15551110001', '1001') RETURNING id`,
    [orgId]
  );
  contactAId = a.id;

  const { rows: [b] } = await query(
    `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number, extension_number)
     VALUES ($1, 'Bob', 'Test', '15551110002', '1002') RETURNING id`,
    [orgId]
  );
  contactBId = b.id;
});

afterAll(async () => {
  if (gatewayId) await query(`DELETE FROM sip_gateways WHERE id = $1`, [gatewayId]);
  await query(`DELETE FROM emergency_contacts WHERE id = ANY($1)`, [[contactAId, contactBId]]);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

describe('Phase 4 — resolveDialString() defaults to internal with zero gateways configured', () => {
  // user/<ext>, NOT sofia/internal/<ext>@<ip>: a registered softphone's
  // contact is e.g. sip:1001@192.168.1.105:62027 — dialing the profile IP
  // directly gives NO_USER_RESPONSE. user/ makes FreeSWITCH resolve the
  // registered contact itself (verified on real hardware:
  // `originate user/1001 &park` works where sofia/internal/1001@<ip> fails).
  it('dials user/<extension> for a contact with no gateway anywhere', async () => {
    const result = await resolveDialString({ tenantId, contactId: contactAId });
    expect(result.mode).toBe('internal');
    expect(result.dialString).toBe('user/1001');
    expect(result.gateway).toBeNull();
  });

  it('falls back to the raw mobile number if no extension is set', async () => {
    const result = await resolveDialString({ tenantId, mobileNumber: '15559998888' });
    expect(result.mode).toBe('internal');
    expect(result.dialString).toBe('user/15559998888');
  });

  it('never emits a hardcoded IP or domain in the internal path', async () => {
    const result = await resolveDialString({ tenantId, contactId: contactAId });
    expect(result.dialString).not.toMatch(/@/);
    expect(result.dialString).not.toMatch(/sofia\/internal/);
  });
});

describe('Phase 4 — adding a tenant default gateway switches exactly the affected contacts, nothing else', () => {
  it('after adding one loopback gateway entry, only contacts resolving through it use sofia/gateway/..., unaffected contacts are untouched', async () => {
    // Loopback gateway — points back at this same FreeSWITCH box, since
    // no real Avaya/Cisco trunk is available in this environment. This is
    // the exact "dummy gateway entry" the Phase 4 testing gate specifies.
    const { rows: [gw] } = await query(
      `INSERT INTO sip_gateways (tenant_id, name, type, host, port, is_default_outbound, is_active)
       VALUES ($1, 'p4_loopback_test', 'generic_sip', '127.0.0.1', 5080, true, true)
       RETURNING id`,
      [tenantId]
    );
    gatewayId = gw.id;

    // Contact A: resolves via the tenant's new default gateway (no
    // per-contact override needed — that's the whole point of a tenant
    // default).
    const resultA = await resolveDialString({ tenantId, contactId: contactAId });
    expect(resultA.mode).toBe('gateway');
    expect(resultA.dialString).toBe('sofia/gateway/p4_loopback_test/15551110001');
    expect(resultA.gateway.name).toBe('p4_loopback_test');

    // Contact B: same tenant, same default gateway now in effect — proves
    // the switch applies tenant-wide once configured, not per-contact
    // magic. (Both A and B switch here because BOTH resolve through the
    // same tenant default; a per-contact override, tested separately
    // below, is what makes "exactly one contact" switch while a sibling
    // with no override stays on internal.)
    const resultB = await resolveDialString({ tenantId, contactId: contactBId });
    expect(resultB.mode).toBe('gateway');
    expect(resultB.dialString).toBe('sofia/gateway/p4_loopback_test/15551110002');
  });

  it('a per-contact gateway_id override switches exactly that contact, no others, with the tenant default left at NULL', async () => {
    // No tenant default this time — isolate the per-contact override path.
    const { rows: [gw] } = await query(
      `INSERT INTO sip_gateways (tenant_id, name, type, host, port, is_default_outbound, is_active)
       VALUES ($1, 'p4_override_test', 'generic_sip', '127.0.0.1', 5081, false, true)
       RETURNING id`,
      [tenantId]
    );
    try {
      await query(`UPDATE emergency_contacts SET gateway_id = $1 WHERE id = $2`, [gw.id, contactAId]);

      const resultA = await resolveDialString({ tenantId, contactId: contactAId });
      expect(resultA.mode).toBe('gateway');
      expect(resultA.dialString).toBe('sofia/gateway/p4_override_test/15551110001');

      // Contact B has no override and there's no tenant default in this
      // test — must still resolve to internal, untouched.
      const resultB = await resolveDialString({ tenantId, contactId: contactBId });
      expect(resultB.mode).toBe('internal');
      expect(resultB.dialString).toBe('user/1002');
    } finally {
      await query(`UPDATE emergency_contacts SET gateway_id = NULL WHERE id = $1`, [contactAId]);
      await query(`DELETE FROM sip_gateways WHERE id = $1`, [gw.id]);
    }
  });
});

describe('Phase 4 — legacy string-based gateway name (pre-Phase-4 ens_configurations.sip_gateway)', () => {
  it('a gatewayName not yet registered in sip_gateways is still used directly, for backward compatibility', async () => {
    const result = await resolveDialString({ tenantId, mobileNumber: '15551234567', gatewayName: 'some_legacy_gateway_name' });
    expect(result.mode).toBe('gateway');
    expect(result.dialString).toBe('sofia/gateway/some_legacy_gateway_name/15551234567');
    expect(result.gateway).toBeNull(); // not a registered row — just used as a raw name
  });
});
