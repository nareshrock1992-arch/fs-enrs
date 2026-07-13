/**
 * PM2 ecosystem config — fs-enrs backend
 *
 * Always start PM2 from this file's directory:
 *   cd /path/to/fs-enrs/backend
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Or use the absolute path with --cwd:
 *   pm2 start /path/to/fs-enrs/backend/ecosystem.config.cjs
 *
 * PM2 docs: https://pm2.keymetrics.io/docs/usage/application-declaration/
 */
'use strict';

const path = require('path');

module.exports = {
  apps: [
    {
      name:      'fs-enrs-backend',
      script:    'server.js',

      // cwd is the MOST IMPORTANT setting: dotenv reads .env from here.
      // Without this, PM2 looks for .env in the daemon's working directory
      // (often /) which silently fails, leaving all env vars at their
      // hardcoded defaults (ESL_HOST=127.0.0.1, wrong DB creds, etc.).
      cwd: __dirname,

      // env_file: PM2 v5.3+ natively merges this file into the process env
      // before startup — a belt-and-suspenders backup for dotenv.
      env_file: path.join(__dirname, '.env'),

      instances:   1,
      exec_mode:   'fork',   // MUST be fork for ESM — cluster mode breaks ESM
      autorestart: true,
      watch:       false,    // never watch in production (causes restart loops)
      max_memory_restart: '512M',

      // Minimum app uptime (ms) before PM2 considers a start successful.
      // Prevents exponential-backoff restart storms on a permanent crash.
      min_uptime: '5s',
      max_restarts: 10,

      env: {
        NODE_ENV: 'production',
        // Do NOT put secrets here — they live in .env only.
        // Only add vars that CANNOT go in .env (e.g. deploy-time toggles).
      },

      env_development: {
        NODE_ENV: 'development',
      },

      // Write stdout/stderr to separate files so issues are easy to find.
      // Use pm2 logs fs-enrs-backend to tail both together.
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
