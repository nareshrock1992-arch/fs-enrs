import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8100,
    proxy: {
      '/api':       { target: 'http://localhost:4100', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4100', changeOrigin: true, ws: true },
      '/uploads':   { target: 'http://localhost:4100', changeOrigin: true },
    },
  },
});
