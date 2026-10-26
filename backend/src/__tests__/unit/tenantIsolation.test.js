/**
 * Tenant isolation — fail-closed identity handling (Phase 1 of docs/MEDIA_REPORTING_MISSION.md).
 *
 * Uses the REAL auth middleware, tenantScope, rbac and users router with REAL signed
 * JWTs. Only the database is replaced, by a small in-memory emulator of the `users`
 * and `tenants` tables that applies a tenant or role restriction ONLY if the SQL the
 * route sends actually contains it — so these tests prove the queries, not a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// ── in-memory users / tenants ────────────────────────────────────────────────
let users, tenants, calls;
const seed = () => {
  tenants = [{ id: 10, active: true }, { id: 20, active: true }, { id: 30, active: false }];
  users = [
    { id: 1, email: 'sa1@x.test', role: 'SUPER_ADMIN', tenant_id: null, is_active: true, password_hash: 'P1', refresh_token_hash: 'R1' },
    { id: 2, email: 'sa2@x.test', role: 'SUPER_ADMIN', tenant_id: null, is_active: true, password_hash: 'P2', refresh_token_hash: 'R2' },
    { id: 3, email: 'a10@x.test', role: 'ADMIN',       tenant_id: 10,   is_active: true, password_hash: 'P3', refresh_token_hash: 'R3' },
    { id: 4, email: 'o10@x.test', role: 'OPERATOR',    tenant_id: 10,   is_active: true, password_hash: 'P4', refresh_token_hash: 'R4' },
    { id: 5, email: 'a20@x.test', role: 'ADMIN',       tenant_id: 20,   is_active: true, password_hash: 'P5', refresh_token_hash: 'R5' },
    // data drift: a SUPER_ADMIN row that carries tenant 10 — tenant admins must still never reach it
    { id: 6, email: 'sa6@x.test', role: 'SUPER_ADMIN', tenant_id: 10,   is_active: true, password_hash: 'P6', refresh_token_hash: 'R6' },
    // orphan: non-SUPER_ADMIN without a tenant
    { id: 7, email: 'orph@x.test', role: 'ADMIN',      tenant_id: null, is_active: true, password_hash: 'P7', refresh_token_hash: 'R7' },
  ].map(u => ({ deleted_at: null, full_name: u.email, ...u }));
  calls = [];
};
const live = () => users.filter(u => !u.deleted_at);
const scoped = (sql, rows, tenantParam, saParamUsed) => rows
  // tenant filter only if the SQL actually contains it (removing the clause must fail tests)
  .filter(u => !/tenant_id = \$2/.test(sql) || tenantParam == null || u.tenant_id === tenantParam)
  .filter(u => !(saParamUsed && /role <> 'SUPER_ADMIN'/.test(sql)) || u.role !== 'SUPER_ADMIN');

function emulate(sql, p = []) {
  calls.push({ sql, p });
  const s = sql.replace(/\s+/g, ' ');
  if (/FROM tenants WHERE id = \$1/.test(s)) return { rows: tenants.filter(t => t.id === Number(p[0]) && t.active).map(t => ({ id: t.id })) };
  if (/^SELECT id, role, tenant_id, is_active FROM users WHERE id = \$1/.test(s.trim())) return { rows: live().filter(u => u.id === Number(p[0])) };
  if (/^UPDATE users SET deleted_at/.test(s.trim())) {
    const hit = scoped(s, live().filter(u => u.id === Number(p[0])), p[1], p[1] != null);
    hit.forEach(u => { u.deleted_at = new Date(); });
    return { rowCount: hit.length, rows: [] };
  }
  if (/^UPDATE users SET email/.test(s.trim())) {
    const [id, tenantId, email, fullName, role, isActive, hash, promote, assign] = p;
    const hit = scoped(s, live().filter(u => u.id === Number(id)), tenantId, tenantId != null);
    for (const u of hit) {
      if (email != null) u.email = email;
      if (fullName != null) u.full_name = fullName;
      if (role != null) u.role = role;
      if (isActive != null) u.is_active = isActive;
      if (hash != null) u.password_hash = hash;
      u.tenant_id = promote ? null : assign != null ? assign : u.tenant_id;
      if (/refresh_token_hash = CASE WHEN \$7::text IS NOT NULL THEN NULL/.test(s) && hash != null) u.refresh_token_hash = null;
    }
    return { rows: hit.map(u => ({ id: u.id, email: u.email, role: u.role, is_active: u.is_active, tenant_id: u.tenant_id })) };
  }
  if (/WHERE u\.id = \$1/.test(s)) return { rows: scoped(s, live().filter(u => u.id === Number(p[0])), p[1], p[1] != null) };
  if (/COUNT\(\*\)::INT AS total FROM users/.test(s)) {
    const rows = live().filter(u => (!/tenant_id = \$1/.test(s) || p[0] == null || u.tenant_id === p[0]) && (!/role <> .SUPER_ADMIN./.test(s) || p[3] == null || u.role !== "SUPER_ADMIN"));
    return { rows: [{ total: rows.length }] };
  }
  if (/ORDER BY u\.full_name/.test(s)) {
    return { rows: live().filter(u => (!/tenant_id = \$1/.test(s) || p[0] == null || u.tenant_id === p[0]) && (!/role <> .SUPER_ADMIN./.test(s) || p[5] == null || u.role !== "SUPER_ADMIN")) };
  }
  if (/FROM users WHERE email = \$1/.test(s)) return { rows: live().filter(u => u.email === p[0]) };
  if (/FROM users WHERE id = \$1/.test(s)) return { rows: live().filter(u => u.id === Number(p[0])) };
  if (/^UPDATE users SET/.test(s.trim())) return { rows: [], rowCount: 1 };
  throw new Error(`unexpected SQL in test: ${s.slice(0, 90)}`);
}
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, p) => emulate(sql, p)),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));
vi.mock('../../services/eslService.js', () => ({ setSocketIO: vi.fn(), eslStatus: () => ({ connected: false }) }));

const { config } = await import('../../config/index.js');
const tenantScope = await import('../../middleware/tenantScope.js');
const { requireAuth, requireAuthOrToken, requireAuthSelf } = await import('../../middleware/auth.js');
const { signMediaAccess, requireMediaAccess } = await import('../../middleware/mediaAccess.js');
const { errorHandler } = await import('../../middleware/asyncHandler.js');
const usersRouter = (await import('../../routes/v1/users.js')).default;
const authRouter = (await import('../../routes/v1/auth.js')).default;
const { authenticateSocket, initSocket, emitInternal } = await import('../../services/socketService.js');

const tok = (claims) => jwt.sign(claims, config.jwt.accessSecret, { expiresIn: '15m' });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const ORPHAN = tok({ id: 7, role: 'ADMIN', tenantId: null });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/users', usersRouter);
app.use('/auth', authRouter);
const ok = (req, res) => res.json({ user: req.user });
app.get('/probe/auth', requireAuth, ok);
app.get('/probe/token', requireAuthOrToken, ok);
app.get('/probe/self', requireAuthSelf, ok);
app.get('/probe/media/:id/stream', requireMediaAccess('media', 'stream'), ok);
app.use(errorHandler);

const as = (t) => ({ Authorization: `Bearer ${t}` });
const updates = () => calls.filter(c => /^\s*UPDATE users/.test(c.sql));

beforeEach(() => { seed(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('tenantScope rules', () => {
  it('isValidTenantId: positive integers only', () => {
    expect([1, 10, 999].every(tenantScope.isValidTenantId)).toBe(true);
    expect([0, -1, 1.5, '3', '', null, undefined, NaN, {}].some(tenantScope.isValidTenantId)).toBe(false);
  });
  it('effectiveTenantId: tenant users are bound to their token; no tenant → 403', () => {
    expect(tenantScope.effectiveTenantId({ user: { role: 'ADMIN', tenantId: 10 }, query: { tenant_id: '20' } })).toBe(10);
    for (const tenantId of [null, undefined, '', 0, -1, 1.5, '10', 'abc']) {
      expect(() => tenantScope.effectiveTenantId({ user: { role: 'OPERATOR', tenantId }, query: {} }))
        .toThrow(expect.objectContaining({ status: 403, httpBody: tenantScope.TENANT_CONTEXT_REQUIRED }));
    }
  });
  it('effectiveTenantId: SUPER_ADMIN — absent → all (null), valid → that tenant, malformed → 400', () => {
    const sa = (query, body) => ({ user: { role: 'SUPER_ADMIN', tenantId: null }, query, body });
    expect(tenantScope.effectiveTenantId(sa({}))).toBeNull();
    expect(tenantScope.effectiveTenantId(sa({ tenant_id: '' }))).toBeNull();
    expect(tenantScope.effectiveTenantId(sa({ tenant_id: '20' }))).toBe(20);
    expect(tenantScope.effectiveTenantId(sa({}, { tenant_id: 30 }))).toBe(30);
    for (const bad of ['abc', '0', '-1', '1.5', '1e3', ' ', [1, 2]]) {
      expect(() => tenantScope.effectiveTenantId(sa({ tenant_id: bad }))).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it('requireTenantForWrite: SUPER_ADMIN needs a valid tenant; others use their token tenant or 403', () => {
    expect(() => tenantScope.requireTenantForWrite({ user: { role: 'SUPER_ADMIN' }, body: {}, query: {} })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => tenantScope.requireTenantForWrite({ user: { role: 'SUPER_ADMIN' }, body: { tenant_id: 'x' }, query: {} })).toThrow(expect.objectContaining({ status: 400 }));
    expect(tenantScope.requireTenantForWrite({ user: { role: 'SUPER_ADMIN' }, body: { tenant_id: '20' }, query: {} })).toBe(20);
    expect(tenantScope.requireTenantForWrite({ user: { role: 'ADMIN', tenantId: 10 }, body: { tenant_id: 20 }, query: {} })).toBe(10);
    expect(() => tenantScope.requireTenantForWrite({ user: { role: 'ADMIN', tenantId: null }, body: { tenant_id: 20 }, query: {} })).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('authentication middleware fails closed for identities without a tenant', () => {
  it('no credentials → 401 everywhere', async () => {
    for (const p of ['/probe/auth', '/probe/token', '/probe/self', '/users']) expect((await request(app).get(p)).status).toBe(401);
  });
  it('tenant user and SUPER_ADMIN pass; tenant-less / malformed tenant identities get 403 TENANT_CONTEXT_REQUIRED', async () => {
    expect((await request(app).get('/probe/auth').set(as(A10))).status).toBe(200);
    expect((await request(app).get('/probe/auth').set(as(SA))).status).toBe(200);
    for (const tenantId of [null, undefined, '', 0, -1, 1.5, '10']) {
      const t = tok({ id: 9, role: 'OPERATOR', tenantId });
      const r = await request(app).get('/probe/auth').set(as(t));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('TENANT_CONTEXT_REQUIRED');
      expect((await request(app).get(`/probe/token?token=${t}`)).status).toBe(403);   // legacy ?token= too
    }
  });
  it('logout stays available to a tenant-less account (requireAuthSelf); /me and change-password do not', async () => {
    expect((await request(app).get('/probe/self').set(as(ORPHAN))).status).toBe(200);
    expect((await request(app).post('/auth/logout').set(as(ORPHAN))).status).toBe(200);
    expect((await request(app).get('/auth/me').set(as(ORPHAN))).status).toBe(403);
    expect((await request(app).post('/auth/change-password').set(as(ORPHAN)).send({ currentPassword: 'x', newPassword: 'Aa1!aaaaaa' })).status).toBe(403);
  });
  it('a signed media link issued for a tenant-less identity is refused (403)', async () => {
    const sig = signMediaAccess({ user: { id: 7, role: 'ADMIN', tenantId: null }, resource: 'media', id: '5', purpose: 'stream' });
    expect((await request(app).get(`/probe/media/5/stream?sig=${sig}`)).status).toBe(403);
    const good = signMediaAccess({ user: { id: 3, role: 'ADMIN', tenantId: 10 }, resource: 'media', id: '5', purpose: 'stream' });
    expect((await request(app).get(`/probe/media/5/stream?sig=${good}`)).status).toBe(200);
  });
});

describe('users API — tenant-less account cannot do anything', () => {
  it('list / read / update / delete → 403 and no UPDATE reaches the database', async () => {
    expect((await request(app).get('/users').set(as(ORPHAN))).status).toBe(403);
    expect((await request(app).get('/users/1').set(as(ORPHAN))).status).toBe(403);
    expect((await request(app).put('/users/1').set(as(ORPHAN)).send({ password: 'Taken0ver!x' })).status).toBe(403);
    expect((await request(app).delete('/users/2').set(as(ORPHAN))).status).toBe(403);
    expect(updates()).toHaveLength(0);
    expect(users.find(u => u.id === 1).password_hash).toBe('P1');
  });
});

describe('users API — tenant admins never reach SUPER_ADMINs or other tenants', () => {
  it('cannot read, reset the password of, or delete a SUPER_ADMIN (404, row untouched)', async () => {
    expect((await request(app).get('/users/1').set(as(A10))).status).toBe(404);
    expect((await request(app).put('/users/1').set(as(A10)).send({ password: 'Taken0ver!x' })).status).toBe(404);
    expect((await request(app).delete('/users/1').set(as(A10))).status).toBe(404);
    expect(users.find(u => u.id === 1)).toMatchObject({ password_hash: 'P1', deleted_at: null });
  });
  it('even a SUPER_ADMIN row that carries their tenant id (data drift) is out of reach', async () => {
    expect((await request(app).get('/users/6').set(as(A10))).status).toBe(404);
    expect((await request(app).put('/users/6').set(as(A10)).send({ password: 'Taken0ver!x' })).status).toBe(404);
    expect((await request(app).delete('/users/6').set(as(A10))).status).toBe(404);
    expect(users.find(u => u.id === 6)).toMatchObject({ password_hash: 'P6', deleted_at: null });
  });
  it('cannot read or change another tenant\'s user (404)', async () => {
    expect((await request(app).get('/users/5').set(as(A10))).status).toBe(404);
    expect((await request(app).put('/users/5').set(as(A10)).send({ full_name: 'pwned' })).status).toBe(404);
    expect(users.find(u => u.id === 5).full_name).toBe('a20@x.test');
  });
  it('the list shows only their own tenant, without SUPER_ADMINs; a forged ?tenant_id is ignored', async () => {
    const r = await request(app).get('/users?tenant_id=20').set(as(A10));
    expect(r.status).toBe(200);
    expect(r.body.users.map(u => u.id).sort()).toEqual([3, 4]);
    expect(r.body.total).toBe(2);
  });
  it('cannot assign SUPER_ADMIN, and a body tenant_id cannot move a user to another tenant', async () => {
    expect((await request(app).put('/users/4').set(as(A10)).send({ role: 'SUPER_ADMIN' })).status).toBe(403);
    const r = await request(app).put('/users/4').set(as(A10)).send({ tenant_id: 20, full_name: 'Op Ten' });
    expect(r.status).toBe(200);
    expect(users.find(u => u.id === 4)).toMatchObject({ tenant_id: 10, full_name: 'Op Ten' });
  });
  it('legitimate same-tenant work still succeeds; a password reset revokes the user\'s refresh session', async () => {
    expect((await request(app).get('/users/4').set(as(A10))).status).toBe(200);
    const r = await request(app).put('/users/4').set(as(A10)).send({ password: 'NewPass1!x' });
    expect(r.status).toBe(200);
    expect(users.find(u => u.id === 4).refresh_token_hash).toBeNull();
    expect((await request(app).delete('/users/4').set(as(A10))).status).toBe(204);
  });
});

describe('users API — explicit SUPER_ADMIN administration', () => {
  it('sees all users, or one valid tenant; a malformed ?tenant_id is 400 (not "all tenants")', async () => {
    expect((await request(app).get('/users').set(as(SA))).body.total).toBe(7);
    expect((await request(app).get('/users?tenant_id=20').set(as(SA))).body.users.map(u => u.id)).toEqual([5]);
    for (const bad of ['abc', '0', '-2', '1.5']) expect((await request(app).get(`/users?tenant_id=${bad}`).set(as(SA))).status).toBe(400);
  });
  it('demoting a SUPER_ADMIN without a tenant is refused; with a valid tenant it is assigned', async () => {
    const no = await request(app).put('/users/2').set(as(SA)).send({ role: 'ADMIN' });
    expect(no.status).toBe(400);
    expect(no.body.code).toBe('TENANT_REQUIRED');
    expect(users.find(u => u.id === 2)).toMatchObject({ role: 'SUPER_ADMIN', tenant_id: null });
    const yes = await request(app).put('/users/2').set(as(SA)).send({ role: 'ADMIN', tenant_id: 20 });
    expect(yes.status).toBe(200);
    expect(users.find(u => u.id === 2)).toMatchObject({ role: 'ADMIN', tenant_id: 20 });
  });
  it('a tenant-less account can be repaired (tenant assigned) or deactivated, but not kept active without a tenant', async () => {
    expect((await request(app).put('/users/7').set(as(SA)).send({ full_name: 'still orphan' })).status).toBe(400);
    expect((await request(app).put('/users/7').set(as(SA)).send({ is_active: false })).status).toBe(200);
    expect((await request(app).put('/users/7').set(as(SA)).send({ tenant_id: 10, is_active: true })).status).toBe(200);
    expect(users.find(u => u.id === 7)).toMatchObject({ tenant_id: 10, is_active: true });
  });
  it('tenant assignment is validated: inactive tenant → 400; a SUPER_ADMIN cannot be given a tenant', async () => {
    expect((await request(app).put('/users/4').set(as(SA)).send({ tenant_id: 30 })).status).toBe(400);
    expect((await request(app).put('/users/1').set(as(SA)).send({ tenant_id: 10 })).status).toBe(400);
  });
  it('promoting to SUPER_ADMIN clears the tenant (unchanged behaviour)', async () => {
    expect((await request(app).put('/users/4').set(as(SA)).send({ role: 'SUPER_ADMIN' })).status).toBe(200);
    expect(users.find(u => u.id === 4)).toMatchObject({ role: 'SUPER_ADMIN', tenant_id: null });
  });
});

describe('login / refresh / change-password', () => {
  const setPw = async (id, pw) => { users.find(u => u.id === id).password_hash = await bcrypt.hash(pw, 4); };
  it('a tenant-less non-SUPER_ADMIN cannot log in; SUPER_ADMIN and tenant users can', async () => {
    await setPw(7, 'Orphan1!x'); await setPw(1, 'SuperA1!x'); await setPw(3, 'AdminT1!x');
    const orphan = await request(app).post('/auth/login').send({ email: 'orph@x.test', password: 'Orphan1!x' });
    expect(orphan.status).toBe(401);
    expect(orphan.body.token).toBeUndefined();
    expect((await request(app).post('/auth/login').send({ email: 'sa1@x.test', password: 'SuperA1!x' })).status).toBe(200);
    expect((await request(app).post('/auth/login').send({ email: 'a10@x.test', password: 'AdminT1!x' })).status).toBe(200);
  });
  it('refresh is refused for a tenant-less non-SUPER_ADMIN even with a valid refresh token', async () => {
    const rt = jwt.sign({ userId: 7 }, config.jwt.refreshSecret, { expiresIn: '1h' });
    users.find(u => u.id === 7).refresh_token_hash = await bcrypt.hash(rt, 4);
    const r = await request(app).post('/auth/refresh').set('Cookie', `refresh_token=${rt}`);
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });
  it('changing your password rotates the refresh token (old sessions can no longer refresh)', async () => {
    await setPw(3, 'AdminT1!x');
    const r = await request(app).post('/auth/change-password').set(as(A10)).send({ currentPassword: 'AdminT1!x', newPassword: 'AdminT2!x' });
    expect(r.status).toBe(200);
    const upd = updates().find(c => /password_hash = \$1, refresh_token_hash = \$2/.test(c.sql));
    expect(upd).toBeTruthy();
    expect(upd.p[1]).not.toBe('R3');                                    // a new refresh hash, not the old one
    expect(String(r.headers['set-cookie'] || '')).toMatch(/refresh_token=/);
  });
  it('account state is not revealed without the password (no enumeration of orphan accounts)', async () => {
    await setPw(7, 'Orphan1!x');
    const wrong = await request(app).post('/auth/login').send({ email: 'orph@x.test', password: 'nope' });
    const unknown = await request(app).post('/auth/login').send({ email: 'nobody@x.test', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);                           // identical to an unknown account
    const right = await request(app).post('/auth/login').send({ email: 'orph@x.test', password: 'Orphan1!x' });
    expect(right.body.error).toBe('Your account is not available');
  });
});

describe('Socket.IO authentication', () => {
  const fakeSocket = () => ({ emit: vi.fn(), join: vi.fn() });
  it('tenant-less identity joins no rooms and gets auth.error', () => {
    const s = fakeSocket();
    authenticateSocket(s, ORPHAN);
    expect(s.join).not.toHaveBeenCalled();
    expect(s.emit).toHaveBeenCalledWith('auth.error', 'Tenant context required');
  });
  it('tenant user joins exactly their own tenant room; SUPER_ADMIN joins no tenant room', () => {
    const s = fakeSocket(); authenticateSocket(s, A10);
    expect(s.join.mock.calls.map(c => c[0])).toEqual(['authenticated', 'user:3', 'role:ADMIN', 'tenant:10']);
    const a = fakeSocket(); authenticateSocket(a, SA);
    expect(a.join.mock.calls.map(c => c[0])).toEqual(['authenticated', 'user:1', 'role:SUPER_ADMIN']);
  });
  it('missing or invalid token → auth.error, no rooms', () => {
    const s = fakeSocket(); authenticateSocket(s, undefined); authenticateSocket(s, 'not-a-jwt');
    expect(s.join).not.toHaveBeenCalled();
    expect(s.emit.mock.calls.map(c => c[1])).toEqual(['No token', 'Invalid token']);
  });
  it('emitInternal never broadcasts globally: tenant room + SUPER_ADMIN, or authenticated sockets only', async () => {
    const http = await import('http');
    const io = initSocket(http.createServer());
    const targets = [];
    const op = { to: (r) => { targets.at(-1).push(r); return op; }, emit: vi.fn() };
    vi.spyOn(io, 'to').mockImplementation((r) => { targets.push([r]); return op; });
    const globalEmit = vi.spyOn(io, 'emit');
    emitInternal('x.evt', { a: 1 }, 10);
    emitInternal('y.evt', { b: 2 });
    expect(targets).toEqual([['tenant:10', 'role:SUPER_ADMIN'], ['authenticated']]);
    expect(globalEmit).not.toHaveBeenCalled();
    io.close();
  });
});

describe('error logs never contain query-string credentials', () => {
  it('?token= and ?sig= values are redacted in the UNHANDLED ERROR block', async () => {
    const a = express();
    a.get('/boom', () => { throw new Error('boom'); });
    a.use(errorHandler);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(a).get('/boom?token=SECRET.JWT.VALUE&x=1&sig=SIGNATURE123');
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/SECRET\.JWT\.VALUE|SIGNATURE123/);
    expect(logged).toMatch(/token=<redacted>&x=1&sig=<redacted>/);
  });
  it('a percent-encoded parameter name (?%74oken=) and bcrypt hashes in SQL params are redacted too', async () => {
    const a = express();
    a.get('/boom', () => { const e = new Error('db'); e._sql = 'UPDATE users SET password_hash = $1'; e._params = ['$2a$12$abcdefghijklmnopqrstuuHASHVALUE', 7]; throw e; });
    a.use(errorHandler);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(a).get('/boom?%74oken=ENCODED.SECRET&%73ig=ENCSIG');
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/ENCODED\.SECRET|ENCSIG|HASHVALUE/);
    expect(logged).toMatch(/<redacted-hash>/);
    spy.mockRestore();
  });
});
