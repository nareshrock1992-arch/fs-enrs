import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { setSocketIO, eslStatus } from './eslService.js';

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      config.cors.origins,
      credentials: true,
    },
    path: '/socket.io',
  });

  // Inject into ESL service so it can broadcast events
  setSocketIO(io);

  io.on('connection', (socket) => {
    // Authenticate socket with JWT
    socket.on('authenticate', ({ token } = {}) => {
      if (!token) return socket.emit('auth.error', 'No token');
      try {
        const user = jwt.verify(token, config.jwt.accessSecret);
        socket.user = user;
        socket.join(`user:${user.id}`);
        socket.join(`role:${user.role}`);
        socket.emit('authenticated', { userId: user.id, role: user.role });
        socket.emit('esl.status', eslStatus());
      } catch {
        socket.emit('auth.error', 'Invalid token');
      }
    });

    socket.on('disconnect', () => {});
  });

  return io;
}
