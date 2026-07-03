// Role-Based Access Control middleware
// Usage: router.delete('/users/:id', requireAuth, requireRole('ADMIN'), handler)

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`
      });
    }
    next();
  };
}

// Shorthand for common role combinations
export const adminOnly     = requireRole('ADMIN');
export const adminOrOp     = requireRole('ADMIN', 'OPERATOR');
export const anyRole       = requireRole('ADMIN', 'OPERATOR', 'VIEWER');
