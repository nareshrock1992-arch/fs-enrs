import { io } from 'socket.io-client';

export const socket = io('/', {
  path: '/socket.io',
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

// Re-authenticate on every (re)connect with whatever token is current.
// This handles: initial connect, reconnect after network drop, token refresh.
socket.on('connect', () => {
  const token = localStorage.getItem('enrs_token');
  if (token) socket.emit('authenticate', { token });
});
