import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { hasTenantContext, TENANT_CONTEXT_REQUIRED } from './tenantScope.js';

function bearerOf(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function verifyInto(req, res, token, { requireTenant }) {
  try {
    req.user = jwt.verify(token, config.jwt.accessSecret);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({ error: msg });
  }
  // Fail closed: a non-SUPER_ADMIN identity without a valid tenant must never
  // reach tenant-scoped handlers (their SQL would otherwise read "no tenant" as
  // "all tenants").
  if (requireTenant && !hasTenantContext(req.user)) return res.status(403).json(TENANT_CONTEXT_REQUIRED);
  return null;
}

// Attach req.user = { id, email, role, tenantId } from Bearer token
export function requireAuth(req, res, next) {
  const token = bearerOf(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (verifyInto(req, res, token, { requireTenant: true }) === null) next();
}

// Self-service routes that touch only the caller's own session (logout): signature
// check only, so an account without a tenant can still sign out.
export function requireAuthSelf(req, res, next) {
  const token = bearerOf(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (verifyInto(req, res, token, { requireTenant: false }) === null) next();
}

// Media streaming auth — accepts Bearer header OR ?token= query param.
// Used for audio stream/download endpoints so <audio src> and <a download>
// work without client-side fetch (browsers can't set Authorization headers).
// ?token= is DEPRECATED (docs/media-rbac.md); the UI uses scoped ?sig= links.
export function requireAuthOrToken(req, res, next) {
  const token = bearerOf(req) || req.query.token || null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (verifyInto(req, res, token, { requireTenant: true }) === null) next();
}

// Optional auth — populates req.user if token present, continues regardless
export function optionalAuth(req, res, next) {
  const token = bearerOf(req);
  if (token) {
    try { req.user = jwt.verify(token, config.jwt.accessSecret); } catch {}
  }
  next();
}
