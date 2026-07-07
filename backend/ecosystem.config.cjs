module.exports = {
  apps: [
    {
      name: 'fs-enrs-backend',
      script: 'server.js',
      // cwd is resolved from the directory where pm2 start is invoked.
      // Set CWD to the absolute path of your backend directory, or cd to it
      // before running: cd /path/to/fs-enrs/backend && pm2 start ecosystem.config.cjs
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 4100
      }
    }
  ]
};
