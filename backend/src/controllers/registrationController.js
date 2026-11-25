/**
 * GET /api/v1/phone-registrations — which phones are signed in to the phone system, and the state of
 * the SIP trunks (gateways) (read-only).
 *
 * Owner decision 2026-11-25: all admins may see it. FreeSWITCH is shared by every tenant, so:
 *   SUPER_ADMIN → every registration (or one tenant with ?tenant_id=, like the other pages);
 *   ADMIN       → only extensions that belong to the tenant's own emergency contacts or departments,
 *                 and only the tenant's own trunks (sip_gateways).
 * Never changes FreeSWITCH; never returns the SIP call-id.
 */
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';
import { fetchRegistrations, fetchGateways, gatewayProblem, summarise } from '../services/registrationService.js';

/** Extension numbers owned by a tenant (contacts' internal/extension numbers, departments). */
export async function tenantExtensions(tenantId, q = query) {
  const { rows } = await q(
    `SELECT DISTINCT trim(x) AS ext FROM (
        SELECT c.internal_extension AS x FROM emergency_contacts c
          JOIN organizations o ON o.id = c.organization_id
         WHERE o.tenant_id = $1 AND c.deleted_at IS NULL AND o.deleted_at IS NULL
        UNION ALL
        SELECT c.extension_number FROM emergency_contacts c
          JOIN organizations o ON o.id = c.organization_id
         WHERE o.tenant_id = $1 AND c.deleted_at IS NULL AND o.deleted_at IS NULL
        UNION ALL
        SELECT d.extension FROM departments d
          JOIN organizations o ON o.id = d.organization_id
         WHERE o.tenant_id = $1 AND d.deleted_at IS NULL AND o.deleted_at IS NULL
     ) t WHERE x IS NOT NULL AND trim(x) <> ''`,
    [tenantId]
  );
  return new Set(rows.map((r) => r.ext));
}

/** FreeSWITCH gateway names configured by a tenant (Telephony Gateways page). */
export async function tenantGatewayNames(tenantId, q = query) {
  const { rows } = await q(
    `SELECT name FROM sip_gateways WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );
  return new Set(rows.map((r) => r.name));
}

export function makeListRegistrations({
  fetch = fetchRegistrations, fetchTrunks = fetchGateways,
  extensionsFor = tenantExtensions, gatewaysFor = tenantGatewayNames,
} = {}) {
  return asyncHandler(async (req, res) => {
    const tenantId = effectiveTenantId(req);          // throws 400/403 like every tenant-scoped page
    let rows, trunks;
    try {
      [rows, trunks] = await Promise.all([fetch(), fetchTrunks()]);
    } catch (err) {
      console.warn(`[registrations] FreeSWITCH query failed: ${err.message}`);
      return res.status(503).json({
        error: 'The phone system is not reachable right now, so registrations cannot be shown. Try again in a moment.',
        code: 'PHONE_SYSTEM_UNAVAILABLE',
      });
    }
    let scope = 'all';
    if (tenantId != null) {
      const [own, ownTrunks] = await Promise.all([extensionsFor(tenantId), gatewaysFor(tenantId)]);
      rows = rows.filter((r) => own.has(r.extension));
      trunks = trunks.filter((g) => ownTrunks.has(g.name));
      scope = 'tenant';
    }
    const { summary, registrations } = summarise(rows);
    const gateways = trunks.map((g) => ({ ...g, problem: gatewayProblem(g) }));
    res.set('Cache-Control', 'no-store');
    res.json({
      scope,
      updatedAt: new Date().toISOString(),
      summary: { ...summary, trunks: gateways.length, trunksWithProblems: gateways.filter((g) => g.problem).length },
      registrations,
      gateways,
    });
  });
}

export const listRegistrations = makeListRegistrations();
