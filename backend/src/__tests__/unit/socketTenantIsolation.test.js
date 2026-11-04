/**
 * Socket.IO identity, room membership and event delivery.
 * REAL socketService and eventTenant with REAL signed tokens; the socket is a fake that
 * records rooms, so the assertions are about what a client could actually receive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { readFileSync, readdirSync } from 'fs';
import { URL } from 'url';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pool.js', () => ({ query: db.query, withTransaction: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../services/eslService.js', () => ({ setSocketIO: vi.fn(), eslStatus: () => ({ host: 'esl.internal', port: 8021 }) }));

const { config } = await import('../../config/index.js');
const { authenticateSocket, clearSocketAuth, emitInternal, initSocket } = await import('../../services/socketService.js');
const { campaignTenant, ersIncidentTenant } = await import('../../services/eventTenant.js');

const tok = (c, opts = {}) => jwt.sign(c, config.jwt.accessSecret, { expiresIn: '15m', ...opts });
const A10 = tok({ id: 3, role: 'ADMIN', tenantId: 10 });
const A20 = tok({ id: 5, role: 'ADMIN', tenantId: 20 });
const SA = tok({ id: 1, role: 'SUPER_ADMIN', tenantId: null });

function fakeSocket() {
  const s = {
    id: 'sock1', rooms: new Set(['sock1']), handlers: {}, sent: [],
    join: (r) => s.rooms.add(r), leave: (r) => s.rooms.delete(r),
    emit: (e, d) => s.sent.push([e, d]), on: (e, h) => { s.handlers[e] = h; },
  };
  return s;
}
const joined = (s) => [...s.rooms].filter(r => r !== s.id).sort();
const errors = (s) => s.sent.filter(([e]) => e === 'auth.error').map(([, d]) => d);

describe('identity comes only from a verified token', () => {
  it.each([
    ['wrong secret', jwt.sign({ id: 3, role: 'SUPER_ADMIN', tenantId: null }, 'attacker')],
    ['refresh secret', jwt.sign({ id: 3, role: 'SUPER_ADMIN' }, config.jwt.refreshSecret)],
    ['alg none', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"id":3,"role":"SUPER_ADMIN"}').toString('base64url')}.`],
    ['expired', tok({ id: 3, role: 'ADMIN', tenantId: 10 }, { expiresIn: -10 })],
    ['not a string', { role: 'SUPER_ADMIN' }],
  ])('%s → no rooms', (_, token) => {
    const s = fakeSocket();
    authenticateSocket(s, token);
    expect(joined(s)).toEqual([]);
    expect(errors(s)).toEqual(['Invalid token']);
  });
  it('a tenant claim beside the token is ignored: the rooms come from the token', () => {
    const io = initSocket(http.createServer());
    const s = fakeSocket();
    io.sockets.listeners('connection')[0](s);
    s.handlers.authenticate({ token: A10, tenantId: 20, role: 'SUPER_ADMIN', room: 'tenant:20' });
    expect(joined(s)).toEqual(['authenticated', 'role:ADMIN', 'tenant:10', 'user:3']);
    io.close();
  });
});

describe('a client cannot subscribe itself', () => {
  let io, s;
  beforeEach(() => { io = initSocket(http.createServer()); s = fakeSocket(); io.sockets.listeners('connection')[0](s); });
  afterEach(() => io.close());

  it('the only client events are authenticate, deauthenticate and disconnect', () => {
    expect(Object.keys(s.handlers).sort()).toEqual(['authenticate', 'deauthenticate', 'disconnect']);
  });
  it('nothing is sent before authentication (esl.status names the ESL host)', () => {
    expect(s.sent).toEqual([]);
    expect(joined(s)).toEqual([]);
  });
  // socket.io runs listeners outside try/catch and server.js exits on uncaughtException,
  // so a throwing handler let any unauthenticated client stop the backend.
  it.each([[null], ['a string'], [42], [[1, 2]], [{ token: null }], [{ token: 7 }]])('authenticate(%j) does not throw and joins nothing', (payload) => {
    expect(() => s.handlers.authenticate(payload)).not.toThrow();
    expect(joined(s)).toEqual([]);
  });
  it('deauthenticate and disconnect drop every room', () => {
    s.handlers.authenticate({ token: A10 });
    s.handlers.deauthenticate();
    expect(joined(s)).toEqual([]);
    s.handlers.authenticate({ token: SA });
    s.handlers.disconnect();
    expect(joined(s)).toEqual([]);
  });
});

describe('re-authentication and expiry', () => {
  it('switching user keeps none of the earlier user\'s rooms', () => {
    const s = fakeSocket();
    authenticateSocket(s, SA);
    authenticateSocket(s, A20);
    expect(joined(s)).toEqual(['authenticated', 'role:ADMIN', 'tenant:20', 'user:5']);
    clearSocketAuth(s);
  });
  it('a failed re-authentication loses access; it does not keep the old rooms', () => {
    const s = fakeSocket();
    authenticateSocket(s, A10);
    authenticateSocket(s, 'garbage');
    expect(joined(s)).toEqual([]);
    expect(s.user).toBeNull();
  });
  it('a reconnect joins again only with a valid token', () => {
    const s = fakeSocket();
    authenticateSocket(s, A10);
    s.handlers = {};
    clearSocketAuth(s);                           // what disconnect does
    authenticateSocket(s, tok({ id: 3, role: 'ADMIN', tenantId: 10 }, { expiresIn: -1 }));
    expect(joined(s)).toEqual([]);
    authenticateSocket(s, A10);
    expect(joined(s)).toContain('tenant:10');
    clearSocketAuth(s);
  });
  it('rooms are dropped the moment the token expires, and the client is told', () => {
    vi.useFakeTimers();
    try {
      const s = fakeSocket();
      authenticateSocket(s, tok({ id: 3, role: 'ADMIN', tenantId: 10 }, { expiresIn: 60 }));
      vi.advanceTimersByTime(59_000);
      expect(joined(s)).toContain('tenant:10');
      vi.advanceTimersByTime(2_000);
      expect(joined(s)).toEqual([]);
      expect(errors(s)).toEqual(['Invalid token']);
    } finally { vi.useRealTimers(); }
  });
});

describe('event delivery', () => {
  let io, sent;
  beforeEach(() => {
    db.query.mockReset();
    io = initSocket(http.createServer());
    sent = [];
    const chain = (rooms) => ({ to: (r) => chain([...rooms, r]), emit: (event) => sent.push({ event, rooms }) });
    vi.spyOn(io, 'to').mockImplementation((r) => chain([r]));
    vi.spyOn(io, 'emit');
  });
  afterEach(() => io.close());
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('tenant event → that tenant + SUPER_ADMIN only', () => {
    emitInternal('e', {}, 10);
    expect(sent).toEqual([{ event: 'e', rooms: ['tenant:10', 'role:SUPER_ADMIN'] }]);
  });
  it('no tenant, a null lookup, or a failed lookup → SUPER_ADMIN only, never everyone', async () => {
    emitInternal('a', {});
    emitInternal('b', {}, Promise.resolve(null));
    emitInternal('c', {}, Promise.reject(new Error('db down')));
    await settle();
    expect(sent.map(s => s.rooms)).toEqual([['role:SUPER_ADMIN'], ['role:SUPER_ADMIN'], ['role:SUPER_ADMIN']]);
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('the tenant comes from the record, and a repeated record needs one lookup', async () => {
    db.query.mockResolvedValue({ rows: [{ tenant_id: 42 }] });
    emitInternal('x', {}, campaignTenant('c-1'));
    emitInternal('y', {}, campaignTenant('c-1'));
    await settle();
    expect(sent.map(s => s.rooms[0])).toEqual(['tenant:42', 'tenant:42']);
    expect(sent.map(s => s.event)).toEqual(['x', 'y']);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('a lookup failure is not cached, and never rejects into the call path', async () => {
    db.query.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ rows: [{ tenant_id: 7 }] });
    await expect(ersIncidentTenant('u-1')).resolves.toBeNull();
    await expect(ersIncidentTenant('u-1')).resolves.toBe(7);
  });
});

describe('source scan: every live event names its audience', () => {
  const src = new URL('../../', import.meta.url);
  const files = ['controllers/internal/ensInternalController.js', 'controllers/internal/ersInternalController.js',
    'controllers/ersController.js', 'services/campaignEngine.js', 'services/ersRingService.js'];

  it.each(files)('%s: each emitInternal has a tenant argument', (f) => {
    const s = readFileSync(new URL(f, src), 'utf8');
    const re = /emitInternal\('[^']+',\s*\{/g;
    let m, n = 0;
    while ((m = re.exec(s))) {
      let i = m.index + m[0].length, depth = 1;
      while (depth) { const c = s[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
      expect(s.slice(i).trimStart()[0], s.slice(m.index, m.index + 60)).toBe(',');
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
  it('no source uses a global Socket.IO broadcast', () => {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const url = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(url);
      return e.name.endsWith('.js') ? [url] : [];
    });
    const hits = walk(src).filter((u) => /\b_?io\??\.emit\(/.test(readFileSync(u, 'utf8').replace(/^\s*\/\/.*$/gm, '')));
    expect(hits).toEqual([]);
  });
});
