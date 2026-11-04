import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { notify } from '../components/ui/Toast.jsx';
import { confirmAction } from '../components/ui/ConfirmDialog.jsx';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p);
  return /\.jsx?$/.test(n) ? [p] : [];
});

describe('notices', () => {
  it('notify never throws, even for odd values', () => {
    expect(() => { notify(new Error('x')); notify(undefined); notify('ok', 'success'); }).not.toThrow();
  });
  it('no page blocks the screen with alert(): a live monitor must stay usable', () => {
    const hits = walk(SRC).filter((f) => /(^|[^.\w-])alert\(/m.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
  it('no page blocks the screen with confirm(): confirmations use the shared dialog', () => {
    const hits = walk(SRC).filter((f) => /(^|[^.\w-])(window\.)?confirm\(/m.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
  it('a newer confirmation question resolves the unanswered one as cancelled', async () => {
    const first = confirmAction({ title: 'One' });
    confirmAction({ title: 'Two' });
    await expect(first).resolves.toBe(false);
  });
});

describe('socket identity follows the session', () => {
  it('login authenticates the socket and logout drops it', async () => {
    vi.resetModules();
    const socketMock = { authenticateSocket: vi.fn(), deauthenticateSocket: vi.fn() };
    vi.doMock('../api/socket.js', () => socketMock);
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) });
    const { useAuthStore } = await import('../store/authStore.js');
    useAuthStore.getState().login('tok-1', { role: 'ADMIN' });
    expect(socketMock.authenticateSocket).toHaveBeenCalledWith('tok-1');
    useAuthStore.getState().logout();
    expect(socketMock.deauthenticateSocket).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.doUnmock('../api/socket.js');
  });
});
