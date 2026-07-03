import { io } from 'socket.io-client';

export const socket = io('/', {
  path: '/socket.io',
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: Infinity,
});

export function authenticateSocket(token) {
  if (token) socket.emit('authenticate', { token });
}

// Re-authenticate after reconnect
socket.on('connect', () => {
  const token = localStorage.getItem('enrs_token');
  if (token) socket.emit('authenticate', { token });
});
