// ЭСКАЛАЦИЯ ОШИБОК В ЖИВУЮ СЕССИЮ. Требование владельца: «ошибки напрямую дёргают твою сессию,
// чтобы ты оперативно разбирался/чинил».
//
// КАК ЭТО РАБОТАЕТ (переиспользуем то, что уже есть, а не строим новое):
//   ошибка → подписанное сообщение самому себе в agent-bus (inbox desktop-tt4i69c)
//         → pm2-персистер durable-пишет его в ~/.agent-bus/desktop-tt4i69c.log
//         → Monitor живой сессии (tail -f лога) СРАЗУ будит Claude уведомлением
// Плюс копия в Telegram (masterbot3000) — чтобы владелец видел, даже если сессии нет.
//
// ДЕДУП: одна и та же ошибка не должна долбить сессию каждую минуту. Ключ = источник+текст,
// окно молчания COOLDOWN_MS. Иначе падающий в цикле сервис превратит уведомления в шум,
// и настоящую аварию будет не видно (на этом уже обжигались с суточным отчётом).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const COOLDOWN_MS = parseInt(process.env.ESCALATE_COOLDOWN_MS || String(15 * 60 * 1000), 10);
const STATE = path.join(os.homedir(), '.agent-bus', 'escalate.state.json');
const SELF = process.env.FLEET_NODE_ID || 'desktop-tt4i69c';

function seen() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; } }
function remember(map) { try { fs.writeFileSync(STATE, JSON.stringify(map)); } catch (_) {} }

/**
 * Сообщить об ошибке в живую сессию (через шину) + владельцу (ТГ).
 * Никогда не бросает — эскалация не должна ронять то, что и так упало.
 * @param {string} source  кто упал: 'tg-bridge' | 'llm-worker' | 'bus-agent' | ...
 * @param {string} message суть ошибки
 * @param {object} [opts]  {fatal:boolean} — fatal шлём даже в cooldown
 * @returns {Promise<boolean>} эскалировали или подавили дедупом
 */
async function escalate(source, message, { fatal = false } = {}) {
  try {
    const key = `${source}::${String(message).slice(0, 120)}`;
    const now = Date.now();
    const map = seen();
    if (!fatal && map[key] && now - map[key] < COOLDOWN_MS) return false;   // дедуп
    map[key] = now;
    // чистим старьё, чтобы файл не рос
    for (const k of Object.keys(map)) if (now - map[k] > 24 * 3600 * 1000) delete map[k];
    remember(map);

    const text = `🔴 ОШИБКА [${source}] на ${SELF}: ${String(message).slice(0, 600)}`;

    // 1) в шину самому себе → персистер запишет в лог → Monitor живой сессии сработает
    try {
      execSync(`node "${path.join(__dirname, '..', 'mcp', 'bus-send.js')}" ${SELF} ${JSON.stringify(text)}`,
        { encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: path.join(__dirname, '..'), stdio: 'ignore' });
    } catch (_) {}

    // 2) копия в Telegram — на случай, если живой сессии сейчас нет
    try {
      const { notify } = require('./notify');
      await notify({ topic: `сбой ${source}`, result: String(message).slice(0, 80), ok: false });
    } catch (_) {}

    return true;
  } catch (_) { return false; }
}

module.exports = { escalate };
