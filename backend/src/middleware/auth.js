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

// Media streaming auth — accepts Bearer header OR ?token= query param.
// Used for audio stream/download endpoints so <audio src> and <a download>
// work without client-side fetch (browsers can't set Authorization headers).
export function requireAuthOrToken(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token  = bearer || req.query.token || null;
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
