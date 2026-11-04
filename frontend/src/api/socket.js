import { io } from 'socket.io-client';

export const socket = io('/', {
  path: import.meta.env.VITE_SOCKET_PATH || '/socket.io',
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: Infinity,
  // Delay initial connection slightly so the token is available
  // (token is written to localStorage during login, which happens before
  // any page that imports this module is visited)
});

export function authenticateSocket(token) {
  if (token && socket.connected) {
    socket.emit('authenticate', { token });
  }
}

// Sign-out: the server drops this socket's rooms at once.
export function deauthenticateSocket() {
  if (socket.connected) socket.emit('deauthenticate');
}

// Re-authenticate on every (re)connect with whatever token is current.
// This handles: initial connect, reconnect after network drop, token refresh.
socket.on('connect', () => {
  const token = localStorage.getItem('enrs_token');
  if (token) socket.emit('authenticate', { token });
});

// Live events reach authenticated sockets only, and the server ends a socket's access
// when its token expires. Refresh and retry, at most once until authentication succeeds,
// so a token the server keeps refusing cannot start a loop.
let refreshing = false;
let retried = false;
socket.on('authenticated', () => { retried = false; });
socket.on('auth.error', async (reason) => {
  if (reason !== 'Invalid token' || refreshing || retried) return;
  if (!localStorage.getItem('enrs_token')) return;        // signed out: nothing to renew
  refreshing = true;
  retried = true;
  try {
    const base = import.meta.env.VITE_API_URL || '/api/v1';
    const res = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const { token } = await res.json();
      if (localStorage.getItem('enrs_token')) {           // not if the user signed out meanwhile
        localStorage.setItem('enrs_token', token);
        authenticateSocket(token);
      }
    } else {
      console.warn('[socket] session could not be refreshed; live updates are paused until the next sign-in');
    }
  } catch (err) {
    console.warn('[socket] refresh failed:', err.message);
  } finally {
    refreshing = false;
  }
});
