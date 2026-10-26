import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { setSocketIO, eslStatus } from './eslService.js';
import { hasTenantContext } from '../middleware/tenantScope.js';

let _io = null;

// Emit an event to connected dashboard clients.
// Pass tenantId to scope the emission to a single tenant's sockets (+ SUPER_ADMINs).
// Without tenantId the event goes to AUTHENTICATED sockets only — never to a socket
// that has not presented a valid token. (Several ERS/ENS/campaign callers still omit
// tenantId; scoping those per tenant is tracked in docs/MEDIA_REPORTING_MISSION.md.)
export const AUTHENTICATED_ROOM = 'authenticated';
export function emitInternal(event, data, tenantId) {
  if (!_io) return;
  if (tenantId) {
    _io.to(`tenant:${tenantId}`).to('role:SUPER_ADMIN').emit(event, data);
  } else {
    _io.to(AUTHENTICATED_ROOM).emit(event, data);
  }
}

// Exported for tests. Joins the user/role/tenant rooms only for a valid identity.
export function authenticateSocket(socket, token) {
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
    // Immediately send ESL status to every new connection so the UI header
    // pill shows the correct connected/disconnected state before authenticate.
    socket.emit('esl.status', eslStatus());

    // Authenticate socket with JWT
    socket.on('authenticate', ({ token } = {}) => authenticateSocket(socket, token));

    socket.on('disconnect', () => {});
  });

  return io;
}
