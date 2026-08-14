/**
 * Tenant scope resolution — single point of truth for deriving tenant_id.
 *
 * SUPER_ADMIN:
 *   No fixed tenant. May pass ?tenant_id= (reads) or body.tenant_id (writes).
 *   Omitting it means "all tenants" — the SQL uses ($N::int IS NULL OR col = $N).
 *
 * All other roles:
 *   Always bound to req.user.tenantId from their JWT.
 *   Body/query tenant_id is NEVER trusted.
 *   If tenantId is null (orphaned account), the request is rejected by
 *   requireTenantScope() with 403.
 */

export function effectiveTenantId(req) {
  if (req.user?.role === 'SUPER_ADMIN') {
    const q = req.query?.tenant_id ? Number(req.query.tenant_id) : null;
    const b = req.body?.tenant_id  ? Number(req.body.tenant_id)  : null;
    return q || b || null;
  }
  return req.user?.tenantId ?? null;
}

// Middleware: blocks non-SUPER_ADMIN users whose JWT has no tenantId.
// Must run after requireAuth.
export function requireTenantScope(req, res, next) {
  if (req.user?.role === 'SUPER_ADMIN') return next();
  if (!req.user?.tenantId) {
    return res.status(403).json({
      error: 'Tenant context required. Your account has no tenant assigned.',
    });
  }
  next();
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
