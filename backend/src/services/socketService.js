import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { setSocketIO, eslStatus } from './eslService.js';
import { hasTenantContext } from '../middleware/tenantScope.js';

let _io = null;

// Send an event to the dashboard clients allowed to see it.
//   tenantId (or a promise of it): that tenant's sockets + SUPER_ADMINs.
//   no tenant: SUPER_ADMINs only. Every event here describes tenant data, so an event
//   whose tenant is unknown must not reach another tenant (fail closed).
// Rooms are joined only by authenticateSocket from a verified token; no client event
// joins a room, so a tenant cannot subscribe to another tenant by guessing its name.
export const AUTHENTICATED_ROOM = 'authenticated';
const SUPER_ADMIN_ROOM = 'role:SUPER_ADMIN';

function deliver(event, data, tenantId) {
  if (!_io) return;
  if (tenantId) {
    _io.to(`tenant:${tenantId}`).to(SUPER_ADMIN_ROOM).emit(event, data);
  } else {
    _io.to(SUPER_ADMIN_ROOM).emit(event, data);
  }
}

export function emitInternal(event, data, tenantId) {
  if (typeof tenantId?.then === 'function') {
    tenantId.then((id) => deliver(event, data, id), () => deliver(event, data, null));
    return;
  }
  deliver(event, data, tenantId);
}

// Forget everything a socket was given: rooms, identity, expiry timer.
export function clearSocketAuth(socket) {
  clearTimeout(socket.authTimer);
  socket.authTimer = null;
  socket.user = null;
  for (const room of [...(socket.rooms ?? [])]) {
    if (room !== socket.id) socket.leave(room);
  }
}

// Exported for tests. Joins the user/role/tenant rooms only for a valid identity.
// Any previous identity is dropped first, so switching user in a tab, or a failed
// re-authentication, can never keep the earlier user's rooms.
export function authenticateSocket(socket, token) {
  clearSocketAuth(socket);
  if (!token) return socket.emit('auth.error', 'No token');
  let user;
  try {
    user = jwt.verify(token, config.jwt.accessSecret);
  } catch {
    return socket.emit('auth.error', 'Invalid token');
  }
  // Same rule as requireAuth: a non-SUPER_ADMIN identity without a valid tenant
  // joins no rooms and receives no tenant data.
  if (!hasTenantContext(user)) return socket.emit('auth.error', 'Tenant context required');
  socket.user = user;
  // A socket has no per-event token check, so its access ends when the token does.
  // The client refreshes and authenticates again; a revoked session cannot.
  if (user.exp) {
    socket.authTimer = setTimeout(() => {
      clearSocketAuth(socket);
      socket.emit('auth.error', 'Invalid token');
    }, Math.max(0, user.exp * 1000 - Date.now()));
    socket.authTimer.unref?.();
  }
  socket.join(AUTHENTICATED_ROOM);
  socket.join(`user:${user.id}`);
  socket.join(`role:${user.role}`);
  if (user.tenantId) socket.join(`tenant:${user.tenantId}`);
  socket.emit('authenticated', { userId: user.id, role: user.role });
  // Re-send ESL status now that we know the user — also seeds their
  // initial state with the current esl host/port which the UI displays.
  socket.emit('esl.status', eslStatus());
}

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      config.cors.origins,
      credentials: true,
    },
    path: process.env.SOCKET_PATH || '/socket.io',
  });

  // Inject into ESL service so it can broadcast events
  _io = io;
  setSocketIO(io);

  io.on('connection', (socket) => {
    // Nothing is sent before authentication: esl.status carries the ESL host and port.
    // The payload is whatever an unauthenticated client sends. Destructuring it
    // (`({ token } = {})`) threw on null, and socket.io runs listeners outside any
    // try/catch, so one message reached uncaughtException and exited the process.
    socket.on('authenticate', (payload) => {
      try {
        authenticateSocket(socket, payload && typeof payload === 'object' ? payload.token : undefined);
      } catch {
        clearSocketAuth(socket);
        socket.emit('auth.error', 'Invalid token');
      }
    });
    socket.on('deauthenticate', () => clearSocketAuth(socket));

    socket.on('disconnect', () => clearSocketAuth(socket));
  });

  return io;
}
