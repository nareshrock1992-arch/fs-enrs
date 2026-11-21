// Reloading the page after the 15-minute access token expired must renew the
// session from the 7-day refresh cookie instead of signing the user out, with
// one renewal shared by every API call made meanwhile.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/socket.js', () => ({ authenticateSocket: vi.fn(), deauthenticateSocket: vi.fn() }));

const mem = new Map();
vi.stubGlobal('localStorage', {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
});
vi.stubGlobal('window', { location: { href: '' } });

const b64url = o => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = exp => `h.${b64url({ userId: 1, exp })}.s`;
const nowSec = () => Math.floor(Date.now() / 1000);
const USER = { id: 1, email: 'admin@example.test', role: 'SUPER_ADMIN' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The store reads localStorage when the module loads, so each case loads fresh copies.
async function boot({ token, fetchImpl }) {
  vi.resetModules();
  mem.clear();
  if (token) mem.set('enrs_token', token);
  mem.set('enrs_user', JSON.stringify(USER));
  const fetchMock = vi.fn(fetchImpl || (async () => { throw new Error('no network'); }));
  vi.stubGlobal('fetch', fetchMock);
  const store = await import('../store/authStore.js');
  const client = await import('../api/client.js');
  const socket = await import('../api/socket.js');
  return { ...store, ...client, fetchMock, socket };
}
const refreshCalls = f => f.mock.calls.filter(([url]) => url.endsWith('/auth/refresh')).length;

describe('isTokenExpired', () => {
  it('reads base64url payloads and compares exp with now; unreadable = expired', async () => {
    const { isTokenExpired } = await boot({ token: null });
    expect(isTokenExpired(jwt(nowSec() + 600))).toBe(false);
    expect(isTokenExpired(jwt(nowSec() - 1))).toBe(true);
    expect(isTokenExpired('garbage')).toBe(true);
    expect(isTokenExpired(`h.${b64url({ userId: 1 })}.s`)).toBe(true);
  });
});

describe('session on page load', () => {
  it('keeps a valid session without calling the server', async () => {
    const t = jwt(nowSec() + 600);
    const { useAuthStore, sessionRestored, fetchMock } = await boot({ token: t });
    expect(await sessionRestored).toBe('valid');
    expect(useAuthStore.getState().token).toBe(t);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renews an expired token from the refresh cookie and stays signed in', async () => {
    const fresh = jwt(nowSec() + 900);
    const { useAuthStore, sessionRestored, fetchMock, socket } = await boot({
      token: jwt(nowSec() - 60),
      fetchImpl: async () => json(200, { token: fresh }),
    });
    expect(useAuthStore.getState().user).toEqual(USER);       // not dropped on load any more
    expect(await sessionRestored).toBe('renewed');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    expect(useAuthStore.getState().token).toBe(fresh);
    expect(mem.get('enrs_token')).toBe(fresh);
    expect(socket.authenticateSocket).toHaveBeenCalledWith(fresh);
  });

  it('signs out when the server refuses the refresh (cookie expired or revoked)', async () => {
    const { useAuthStore, sessionRestored } = await boot({
      token: jwt(nowSec() - 60),
      fetchImpl: async () => json(401, { error: 'Invalid refresh token' }),
    });
    expect(await sessionRestored).toBe('signed-out');
    expect(useAuthStore.getState().token).toBeNull();
    expect(mem.has('enrs_token')).toBe(false);
    expect(mem.has('enrs_user')).toBe(false);
  });

  it('keeps the session when the backend is unreachable or failing (no sign-out on a restart)', async () => {
    const stale = jwt(nowSec() - 60);
    let r = await boot({ token: stale });
    expect(await r.sessionRestored).toBe('offline');
    expect(r.useAuthStore.getState().token).toBe(stale);
    r = await boot({ token: stale, fetchImpl: async () => json(502, {}) });
    expect(await r.sessionRestored).toBe('offline');
    expect(r.useAuthStore.getState().user).toEqual(USER);
  });
});

describe('API calls with an expired token', () => {
  it('renew once before sending, shared by parallel calls, with no 401 round trip', async () => {
    const fresh = jwt(nowSec() + 900);
    const seen = [];
    const { api, sessionRestored, fetchMock } = await boot({
      token: jwt(nowSec() - 60),
      fetchImpl: async (url, init) => {
        if (url.endsWith('/auth/refresh')) { await new Promise(r => setTimeout(r, 20)); return json(200, { token: fresh }); }
        seen.push(init.headers.Authorization);
        return json(200, { ok: true });
      },
    });
    await Promise.all([api.me(), api.dashMetrics(), api.dashActive(), sessionRestored]);
    expect(refreshCalls(fetchMock)).toBe(1);
    expect(seen).toEqual([`Bearer ${fresh}`, `Bearer ${fresh}`, `Bearer ${fresh}`]);
  });

  it('a refused renewal still sends the user to the login page', async () => {
    const { api } = await boot({
      token: jwt(nowSec() - 60),
      fetchImpl: async url => (url.endsWith('/auth/refresh') ? json(401, {}) : json(401, { error: 'Token expired' })),
    });
    await expect(api.me()).rejects.toThrow('Session expired');
    expect(window.location.href).toBe('/login');
    expect(mem.has('enrs_token')).toBe(false);
  });
});
