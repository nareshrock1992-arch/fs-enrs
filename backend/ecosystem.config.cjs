module.exports = {
  apps: [
    {
      name: 'fs-enrs-backend',
      script: 'server.js',
      cwd: '/opt/freeswitch-ui/fs-enrs/backend',
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
