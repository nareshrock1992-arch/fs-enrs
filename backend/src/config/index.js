import 'dotenv/config';
import { fsConfig } from './fsConfig.js';

// All configuration read from environment variables.
// Never hardcode secrets — change them in .env only.
export { fsConfig };

export const config = {
  env:  process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4100,

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    name:     process.env.DB_NAME     || 'fs_enrs',
    user:     process.env.DB_USER     || 'fs_enrs',
    password: process.env.DB_PASSWORD || 'changeme',
    ssl:      process.env.DB_SSL === 'true',
  },

  jwt: {
    accessSecret:  process.env.JWT_ACCESS_SECRET  || 'CHANGE_ME_access_secret_32plus',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'CHANGE_ME_refresh_secret_32plus',
    accessExpiry:  process.env.JWT_ACCESS_EXPIRY  || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  esl: {
    host:        process.env.ESL_HOST        || '127.0.0.1',
    port:        Number(process.env.ESL_PORT) || 8021,
    password:    process.env.ESL_PASSWORD    || 'ClueCon',
    reconnectMs: Number(process.env.ESL_RECONNECT_MS) || 3000,
  },

  cors: {
    // Comma-separated list of allowed origins
    origins: (process.env.CORS_ORIGIN || 'http://localhost:8100')
      .split(',').map(o => o.trim()),
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxSizeMb: Number(process.env.UPLOAD_MAX_MB) || 50,
  },

  fs: fsConfig,
};
