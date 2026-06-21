// pm2-конфиг: держит воркер живым (autorestart), отсюда же работает self-update (`pm2 restart`).
module.exports = {
  apps: [{
    name: process.env.PM2_NAME || 'llm-fleet',
    script: 'src/worker.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 3000,
    env: { NODE_ENV: 'production' },
  }],
};
