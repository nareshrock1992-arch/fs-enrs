import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { setSocketIO, eslStatus } from './eslService.js';

let _io = null;

// Emit an event from internal API controllers to all connected dashboard clients
export function emitInternal(event, data) {
  if (_io) _io.emit(event, data);
}

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      config.cors.origins,
      credentials: true,
    },
    path: '/socket.io',
  });

  // Inject into ESL service so it can broadcast events
  _io = io;
  setSocketIO(io);

  io.on('connection', (socket) => {
    // Immediately send ESL status to every new connection so the UI header
    // pill shows the correct connected/disconnected state before authenticate.
    socket.emit('esl.status', eslStatus());

    // Authenticate socket with JWT
    socket.on('authenticate', ({ token } = {}) => {
      if (!token) return socket.emit('auth.error', 'No token');
      try {
        const user = jwt.verify(token, config.jwt.accessSecret);
        socket.user = user;
        socket.join(`user:${user.id}`);
        socket.join(`role:${user.role}`);
        socket.emit('authenticated', { userId: user.id, role: user.role });
        // Re-send ESL status now that we know the user — also seeds their
        // initial state with the current esl host/port which the UI displays.
        socket.emit('esl.status', eslStatus());
      } catch {
        socket.emit('auth.error', 'Invalid token');
      }
    });

    socket.on('disconnect', () => {});
  });

  return io;
}
