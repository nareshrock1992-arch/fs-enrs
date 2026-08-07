import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Where the backend runs during local development.
  // Override with VITE_BACKEND_DEV_URL=http://localhost:4100 in frontend/.env
  const backendTarget = env.VITE_BACKEND_DEV_URL || 'http://localhost:4100';

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_DEV_PORT) || 8100,

      // Dev proxy: mirrors what nginx does in production, but for the dev server
      // the frontend is at root (/), so paths are /api/*, /socket.io/*, /uploads/*.
      // In production (Docker) the browser sends /enrs/api/*, /enrs/socket.io/* —
      // those prefixes are set by VITE_API_URL and VITE_SOCKET_PATH baked at build time.
      proxy: {
        '/api': {
          target:       backendTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target:       backendTarget,
          changeOrigin: true,
          ws:           true,
        },
        '/uploads': {
          target:       backendTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
