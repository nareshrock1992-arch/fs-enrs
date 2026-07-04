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

// B-fix: named guards — SUPERVISOR added throughout (B1 / Phase 5)
export const adminOnly          = requireRole('ADMIN');
export const adminOrSuper       = requireRole('ADMIN', 'SUPERVISOR');
export const adminOrOp          = requireRole('ADMIN', 'OPERATOR');
export const canTriggerEns      = requireRole('ADMIN', 'SUPERVISOR', 'OPERATOR');
export const canManageIncidents = requireRole('ADMIN', 'SUPERVISOR');
export const canViewRecordings  = requireRole('ADMIN', 'SUPERVISOR');
export const canExportReports   = requireRole('ADMIN', 'SUPERVISOR', 'OPERATOR');
export const anyRole            = requireRole('ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER');

// Internal key guard — for Lua script endpoints only
export function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
