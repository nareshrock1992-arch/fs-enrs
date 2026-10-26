// ── Scoped, short-lived media access signatures ──────────────────────────────
//
// Browsers cannot set an Authorization header on <audio src> or <a download>,
// so the UI used to put the full session JWT in the URL (?token=), where it
// ends up in access logs, browser history and Referer headers and grants the
// whole API for its lifetime.
//
// A media access signature instead authorises ONE purpose (stream | download)
// on ONE resource (media | recording) id, for MEDIA_ACCESS_TTL_SEC. It is signed
// with a key DERIVED from the access secret, so it can never be accepted by
// requireAuth as an API bearer token, and an access JWT is never accepted as a
// signature.
//
// The documented `?token=` form (docs/03_API_REFERENCE.md) is still accepted
// for backwards compatibility, via requireAuthOrToken — deprecated; the UI no
// longer uses it.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { effectiveTenantId } from './tenantScope.js';
import { requireAuthOrToken } from './auth.js';

export const MEDIA_ACCESS_TTL_SEC = 3600;          // long enough to seek through a long recording
export const MEDIA_ACCESS_PURPOSES = ['stream', 'download'];
const ISSUER = 'fs-enrs-media-access';

const RESOURCES = {
  media:     { table: 'media_files' },
  recording: { table: 'recordings' },
};

function signingKey() {
  return crypto.createHmac('sha256', String(config.jwt.accessSecret)).update('fs-enrs:media-access:v1').digest();
}
const audience = (resource, id, purpose) => `${resource}:${id}:${purpose}`;

/** Sign access to one purpose on one resource for `user` ({ id, role, tenantId }). */
export function signMediaAccess({ user, resource, id, purpose }) {
  if (!RESOURCES[resource]) throw new Error(`unknown media resource: ${resource}`);
  if (!MEDIA_ACCESS_PURPOSES.includes(purpose)) throw new Error(`unknown media purpose: ${purpose}`);
  return jwt.sign(
    { typ: 'media-access', sub: String(user.id ?? ''), role: user.role, tid: user.tenantId ?? null },
    signingKey(),
    { audience: audience(resource, id, purpose), issuer: ISSUER, expiresIn: MEDIA_ACCESS_TTL_SEC },
  );
}

/**
 * Route guard: accepts a valid `?sig=` scoped to this resource/id/purpose, else
 * falls back to the existing Bearer / legacy ?token= check.
 */
export function requireMediaAccess(resource, purpose) {
  return (req, res, next) => {
    const sig = req.query?.sig;
    if (!sig) return requireAuthOrToken(req, res, next);
    try {
      const p = jwt.verify(String(sig), signingKey(), {
        audience: audience(resource, req.params.id, purpose), issuer: ISSUER,
      });
      if (p.typ !== 'media-access') throw new Error('wrong token type');
      req.user = { id: p.sub ? Number(p.sub) || p.sub : null, role: p.role, tenantId: p.tid ?? null, viaMediaSignature: true };
      return next();
    } catch (err) {
      return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Media link expired' : 'Invalid media link' });
    }
  };
}

/**
 * GET /:id/access?purpose=stream|download  (requireAuth first)
 * Issues a signature only for a record the caller can see in their tenant scope.
 */
export function issueMediaAccess(resource) {
  const { table } = RESOURCES[resource];
  return async (req, res, next) => {
    try {
      const purpose = String(req.query?.purpose || 'stream');
      if (!MEDIA_ACCESS_PURPOSES.includes(purpose)) {
        return res.status(400).json({ error: `purpose must be one of: ${MEDIA_ACCESS_PURPOSES.join(', ')}` });
      }
      const { rows: [row] } = await query(
        `SELECT id FROM ${table} WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR tenant_id = $2)`,
        [req.params.id, effectiveTenantId(req)],
      );
      if (!row) return res.status(404).json({ error: 'Not found' });
      const sig = signMediaAccess({ user: req.user, resource, id: String(row.id), purpose });
      res.set('Cache-Control', 'no-store');
      return res.json({ sig, purpose, expires_in: MEDIA_ACCESS_TTL_SEC });
    } catch (err) { return next(err); }
  };
}
