const { execSync } = require('child_process');
const cfg = require('./config');

// Текущая версия кода = короткий git-хэш. Уходит в heartbeat → видно, кто на какой версии.
function version() {
  try { return execSync('git rev-parse --short HEAD', { cwd: cfg.repoDir }).toString().trim(); }
  catch (_) { return 'unknown'; }
}

module.exports = { version };
