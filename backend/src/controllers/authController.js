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

  // Password first: account-state answers below must not be observable by someone
  // who does not know the password (account enumeration).
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  // Only SUPER_ADMIN is platform-wide. Any other account without a tenant is an
  // orphan (e.g. a demoted SUPER_ADMIN, or its tenant row was deleted) and must not
  // receive a token — its queries would otherwise be unscoped.
  if (user.role !== 'SUPER_ADMIN' && !user.tenant_id)
    return res.status(401).json({ error: 'Your account is not available' });

  // Tenant-scoped users cannot authenticate if their tenant is deactivated or deleted.
  // SUPER_ADMIN has tenant_id = NULL and is exempt from this check.
  if (user.tenant_id) {
    const { rows: [tenant] } = await query(
      `SELECT id FROM tenants WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
      [user.tenant_id]
    );
    if (!tenant) return res.status(401).json({ error: 'Your account is not available' });
  }

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
    user:  { id: user.id, email: user.email, fullName: user.full_name, role: user.role, tenantId: user.tenant_id ?? null },
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
  if (user.role !== 'SUPER_ADMIN' && !user.tenant_id)
    return res.status(401).json({ error: 'Your account is not available' });

  if (user.tenant_id) {
    const { rows: [tenant] } = await query(
      `SELECT id FROM tenants WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
      [user.tenant_id]
    );
    if (!tenant) return res.status(401).json({ error: 'Your account is not available' });
  }

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
     FROM users WHERE id = $1 AND deleted_at IS NULL`,
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
  // Rotate the refresh token: any other session holding the old one (e.g. on a
  // device where the password was compromised) can no longer refresh; this session
  // keeps working with the new cookie.
  const refreshToken = signRefresh(req.user.id);
  const refreshHash  = await bcrypt.hash(refreshToken, 8);
  await query(`UPDATE users SET password_hash = $1, refresh_token_hash = $2, updated_at = now() WHERE id = $3`,
    [hash, refreshHash, req.user.id]);
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure:   config.env === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});
