import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import { z }  from 'zod';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

function signAccess(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );
}

function signRefresh(userId) {
  return jwt.sign({ userId }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry });
}

// POST /api/v1/auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, password } = LoginSchema.parse(req.body);

  const { rows } = await query(
    `SELECT id, email, password_hash, full_name, role, tenant_id, is_active
     FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email.toLowerCase()]
  );

  const user = rows[0];
  if (!user || !user.is_active)
    return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const accessToken  = signAccess(user);
  const refreshToken = signRefresh(user.id);
  const refreshHash  = await bcrypt.hash(refreshToken, 8);

  await query(
    `UPDATE users SET refresh_token_hash = $1, last_login_at = now() WHERE id = $2`,
    [refreshHash, user.id]
  );

  // Refresh token in httpOnly cookie — secure against XSS
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure:   config.env === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
  });

  res.json({
    token: accessToken,
    user:  { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
  });
});

// POST /api/v1/auth/refresh
export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  const { rows } = await query(
    `SELECT id, email, role, tenant_id, refresh_token_hash, is_active
     FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [decoded.userId]
  );
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(refreshToken, user.refresh_token_hash || '');
  if (!valid) return res.status(401).json({ error: 'Refresh token mismatch' });

  const accessToken = signAccess(user);
  res.json({ token: accessToken });
});

// POST /api/v1/auth/logout
export const logout = asyncHandler(async (req, res) => {
  if (req.user) {
    await query(`UPDATE users SET refresh_token_hash = NULL WHERE id = $1`, [req.user.id]);
  }
  res.clearCookie('refresh_token');
  res.json({ ok: true });
});

// GET /api/v1/auth/me
export const me = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, full_name, role, tenant_id, last_login_at, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// POST /api/v1/auth/change-password
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string().min(1),
    newPassword:     z.string().min(8),
  }).parse(req.body);

  const { rows } = await query(
    `SELECT password_hash FROM users WHERE id = $1`, [req.user.id]
  );
  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  await query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, req.user.id]);
  res.json({ ok: true });
});
