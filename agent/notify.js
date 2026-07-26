// Telegram-отчёт о работе локального агента — В ТОМ ЖЕ ФОРМАТЕ, что и у остальных агентов флота
// (см. tools/claude-stop-notify.sh, формат «как у isolated-laptop»):
//
//   🤖 АГЕНТ · <кто> · <машина> · 🟢 готово        (или · 🔴 ошибка)
//   🗂 <тема, ≤6 слов>
//   📝 <результат, ≤6 слов>
//
// СЕКРЕТЫ: токен/чат берём ЛОКАЛЬНО из ~/.tg/tg.env (или env TG_TOKEN/TG_CHAT). В репо их нет,
// по шине не передаём (канон README §Безопасность: inbox durable-логируется в файлы → утечка).
// Нет кред → тихо не отправляем (present-but-inactive), работу агента это не ломает.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MACHINE = process.env.CLAUDE_MACHINE || process.env.FLEET_NODE_ID || os.hostname();

function creds() {
  let token = process.env.TG_TOKEN, chat = process.env.TG_CHAT;
  if (!token || !chat) {
    try {
      const env = fs.readFileSync(path.join(os.homedir(), '.tg', 'tg.env'), 'utf8');
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^\s*(TG_TOKEN|TG_CHAT)\s*=\s*(.+?)\s*$/);
        if (m) { if (m[1] === 'TG_TOKEN') token = token || m[2]; else chat = chat || m[2]; }
      }
    } catch (_) {}
  }
  return { token, chat };
}

const configured = () => { const c = creds(); return !!(c.token && c.chat); };

// Обрезка до N слов — формат флота требует коротких строк (≤6 слов), иначе сообщение расползается.
function clipWords(s, n = 6) {
  const w = String(s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return w.slice(0, n).join(' ') + (w.length > n ? '…' : '');
}

/**
 * Отправить отчёт в ТГ. Никогда не бросает — уведомление не должно ронять работу агента.
 * @param {object} o
 * @param {string} o.topic   тема (≤6 слов)
 * @param {string} o.result  результат (≤6 слов)
 * @param {boolean} o.ok     true=🟢 готово, false=🔴 ошибка
 * @param {string} o.who     кто отчитывается (по умолчанию desktop-local)
 * @returns {Promise<boolean>} отправлено ли
 */
async function notify({ topic, result, ok = true, who = 'desktop-local' } = {}) {
  const { token, chat } = creds();
  if (!token || !chat) return false;      // кредов нет — тихо выходим, это не ошибка
  const text = [
    `🤖 АГЕНТ · ${who} · ${MACHINE} · ${ok ? '🟢 готово' : '🔴 ошибка'}`,
    `🗂 ${clipWords(topic)}`,
    `📝 ${clipWords(result)}`,
  ].join('\n');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: chat, text, disable_notification: false }),
    });
    return res.ok;
  } catch (_) { return false; }
}

module.exports = { notify, configured, MACHINE };
