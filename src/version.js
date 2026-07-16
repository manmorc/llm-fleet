const { execSync } = require('child_process');
const cfg = require('./config');

// Текущая версия кода = короткий git-хэш. Уходит в heartbeat → видно, кто на какой версии.
// ВАЖНО: КЭШируем. Раньше git-вызов шёл на КАЖДЫЙ heartbeat (10с) — на Windows каждый execSync
// спавнит консольное окно → окно мигало поверх всех приложений каждые 10 секунд. Хэш меняется
// только при pull+restart (модуль перезагрузится) → кэш корректен. windowsHide — на всякий случай.
let cached = null;

function version(force = false) {
  if (cached && !force) return cached;
  try {
    cached = execSync('git rev-parse --short HEAD', {
      cwd: cfg.repoDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch (_) { cached = 'unknown'; }
  return cached;
}

module.exports = { version };
