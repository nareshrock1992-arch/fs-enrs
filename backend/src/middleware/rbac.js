// Role-Based Access Control middleware
// Usage: router.delete('/users/:id', requireAuth, adminOnly, handler)

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

// SUPER_ADMIN: platform-level administrator; no fixed tenant.
// ADMIN: tenant-scoped administrator.
// Note: adminOrSuper means ADMIN-or-SUPERVISOR (not a platform super-admin).

export const superAdminOnly     = requireRole('SUPER_ADMIN');
// Most management endpoints are accessible to SUPER_ADMIN and tenant ADMIN.
export const superAdminOrAdmin  = requireRole('SUPER_ADMIN', 'ADMIN');
// Legacy alias kept for clarity — means ADMIN or SUPERVISOR (not platform super-admin).
export const adminOnly          = requireRole('SUPER_ADMIN', 'ADMIN');
export const adminOrSuper       = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR');
export const adminOrOp          = requireRole('SUPER_ADMIN', 'ADMIN', 'OPERATOR');
export const canTriggerEns      = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR');
export const canManageIncidents = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR');
export const canViewRecordings  = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR');
export const canExportReports   = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR');
export const anyRole            = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER');

// Internal key guard — for Lua script endpoints only
export function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
