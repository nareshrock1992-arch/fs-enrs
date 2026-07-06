import { timingSafeEqual, createHash } from 'crypto';
import rateLimit from 'express-rate-limit';

// Timing-safe key comparison — prevents brute-force timing attacks
function keysMatch(a, b) {
  try {
    // Pad both to same length via SHA-256 before comparison
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

// Rate limiter specifically for internal routes (separate bucket from public API)
export const internalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: 'Internal rate limit exceeded' },
  skip: () => process.env.NODE_ENV === 'test',
});

// X-Internal-Key middleware — rejects any request without correct shared secret
export function internalAuth(req, res, next) {
  const key = req.headers['x-internal-key'];
  const expected = process.env.INTERNAL_API_KEY;

  if (!expected) {
    console.error('[internal] INTERNAL_API_KEY env var is not set — rejecting all internal requests');
    return res.status(503).json({ error: 'Internal API not configured' });
  }

  if (!key || !keysMatch(key, expected)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
