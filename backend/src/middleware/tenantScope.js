/**
 * Tenant scope resolution — single point of truth for deriving tenant_id.
 *
 * SUPER_ADMIN:
 *   No fixed tenant. May pass ?tenant_id= (reads) or body.tenant_id (writes).
 *   Omitting it means "all tenants" — the SQL uses ($N::int IS NULL OR col = $N).
 *   A tenant_id that is PRESENT but not a positive integer is rejected with 400 —
 *   a malformed value must never silently widen the scope to all tenants.
 *
 * All other roles:
 *   Always bound to req.user.tenantId from their JWT.
 *   Body/query tenant_id is NEVER trusted.
 *   No valid tenantId (orphaned account, malformed token) → 403. They never fall
 *   through to the "all tenants" branch of the SQL.
 */

export const TENANT_CONTEXT_REQUIRED = {
  error: 'Tenant context required. Your account has no tenant assigned.',
  code:  'TENANT_CONTEXT_REQUIRED',
};

/** A real tenant id: a positive integer (tokens carry users.tenant_id, an INT). */
export function isValidTenantId(v) {
  return Number.isInteger(v) && v >= 1;
}

/** May this identity reach tenant-scoped data at all? */
export function hasTenantContext(user) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return isValidTenantId(user.tenantId);
}

const httpError = (status, body) => Object.assign(new Error(body.error), { status, httpBody: body });
export const tenantContextError = () => httpError(403, TENANT_CONTEXT_REQUIRED);

/**
 * A SUPER_ADMIN-supplied tenant_id: absent/empty → undefined; a positive integer
 * (number or digit string) → that number; anything else → 400.
 */
export function parseTenantParam(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (isValidTenantId(n)) return n;
  }
  throw httpError(400, { error: 'tenant_id must be a positive integer', code: 'INVALID_TENANT_ID' });
}

/** Tenant id of a non-SUPER_ADMIN caller, or throw 403. */
function callerTenantId(req) {
  const t = req.user?.tenantId;
  if (!isValidTenantId(t)) throw tenantContextError();
  return t;
}

export function effectiveTenantId(req) {
  if (req.user?.role === 'SUPER_ADMIN') {
    const q = parseTenantParam(req.query?.tenant_id);
    const b = parseTenantParam(req.body?.tenant_id);
    return q ?? b ?? null;
  }
  return callerTenantId(req);
}

// Middleware: blocks identities without a valid tenant context (SUPER_ADMIN exempt).
// requireAuth / requireAuthOrToken already enforce this; kept for explicit use.
export function requireTenantScope(req, res, next) {
  if (!hasTenantContext(req.user)) return res.status(403).json(TENANT_CONTEXT_REQUIRED);
  next();
}

// For write operations that create tenant-owned resources (INSERT with tenant_id).
// Normal users: always JWT tenantId (never from body).
// SUPER_ADMIN: must supply a valid tenant_id in body or query — 400 if missing/malformed.
// This enforces §5 of the multi-tenant spec: SUPER_ADMIN must select a tenant
// for writes; resources must never receive tenant_id = NULL.
export function requireTenantForWrite(req) {
  if (req.user?.role === 'SUPER_ADMIN') {
    const tid = parseTenantParam(req.body?.tenant_id) ?? parseTenantParam(req.query?.tenant_id);
    if (!tid) {
      throw Object.assign(
        new Error('SUPER_ADMIN must select a target tenant (tenant_id) when creating tenant-owned resources'),
        { status: 400 }
      );
    }
    return tid;
  }
  return callerTenantId(req);
}

// Validate that a tenant_id from an explicit SUPER_ADMIN request exists and is active.
// Returns the tenant row or throws a 400-class error.
export async function validateTargetTenant(queryFn, tenantId) {
  const { rows: [t] } = await queryFn(
    `SELECT id FROM tenants WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
    [tenantId]
  );
  if (!t) throw Object.assign(new Error('Tenant not found or inactive'), { status: 400 });
  return t;
}
