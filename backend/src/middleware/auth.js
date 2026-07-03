import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// Attach req.user = { id, email, role, tenantId } from Bearer token
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, config.jwt.accessSecret);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({ error: msg });
  }
}

// Optional auth — populates req.user if token present, continues regardless
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, config.jwt.accessSecret); } catch {}
  }
  next();
}
