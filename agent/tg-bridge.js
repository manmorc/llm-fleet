#!/usr/bin/env node
// Мост Telegram → локальный АГЕНТ (не просто чат): пишешь боту — отвечает агент с инструментами,
// judgment-каркасом и памятью диалога. Тот же харнес, что в терминальном чате.
//
// ПОЧЕМУ LONG POLLING, а не вебхук: машина за NAT/Tailscale, публичного HTTPS-эндпоинта нет.
// ⚠️ У бота может быть ТОЛЬКО ОДИН потребитель getUpdates. Если другая нода флота начнёт опрашивать
// того же бота — апдейты начнут воровать друг у друга. Проверено на старте: вебхука нет, опрос свободен.
// Отправка (sendMessage) конфликта не создаёт — agent/notify.js и отчёты флота работают параллельно.
//
// БЕЗОПАСНОСТЬ: отвечаем ТОЛЬКО владельцу (chat_id из ~/.tg/tg.env). Чужие сообщения игнорируем —
// иначе любой, кто найдёт бота, получит доступ к машине через агента с инструментами.
//
// Запуск: pm2 start ecosystem.config.js --only tg-bridge
const fs = require('fs');
const os = require('os');
const path = require('path');
const { converse, buildSystemPrompt } = require('./loop');
const server = require('./server');
const { escalate } = require('./escalate');   // ошибки → шина → живая сессия Claude

const POLL_TIMEOUT = 50;                     // сек, long polling (Telegram держит соединение)
const MAX_MSG = 3900;                        // лимит Telegram 4096 — режем с запасом
const log = (m) => console.log(`${new Date().toISOString()} [tg-bridge] ${m}`);

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
  return { token, chat: String(chat || '').trim() };
}

const { token: TOKEN, chat: OWNER } = creds();
if (!TOKEN || !OWNER) { console.error('нет TG_TOKEN/TG_CHAT (~/.tg/tg.env)'); process.exit(1); }
const api = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

async function tg(method, body, timeoutMs = 60000) {
  const r = await fetch(api(method), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body),
  });
  return r.json();
}

const send = (text) => tg('sendMessage', { chat_id: OWNER, text: String(text).slice(0, MAX_MSG) }).catch(() => {});
const typing = () => tg('sendChatAction', { chat_id: OWNER, action: 'typing' }, 10000).catch(() => {});

// История диалога живёт в процессе (как в терминальном чате). /reset — сбросить.
let history = [{ role: 'system', content: buildSystemPrompt() }];

async function handle(text) {
  if (text === '/reset') { history = [{ role: 'system', content: buildSystemPrompt() }]; return '🔄 История сброшена.'; }
  if (text === '/help' || text === '/start') {
    return ['Я — локальный агент на твоей GPU-машине (gpt-oss-20b).',
      'Умею: читать файлы, считать точно, искать по RAG-архиву флота, grep, JSON-запросы, HTTP к localhost/tailnet.',
      'Запись файлов и команды — заблокированы (режим deny).',
      '',
      '/reset — сбросить историю диалога',
      '/status — состояние ноды'].join('\n');
  }
  if (text === '/status') {
    const up = await server.probe(4000);
    return `модель: ${up ? '🟢 загружена' : '💤 выгружена (поднимется на запрос ~10с)'}\nмашина: ${os.hostname()}`;
  }

  // Держим «печатает…» пока агент думает — иначе на холодном старте (~10с) кажется, что бот умер.
  const keepTyping = setInterval(typing, 4000);
  try {
    typing();
    const r = await converse(history, text, {
      onEvent: (e) => { if (e.type === 'call') log(`  → ${e.name}(${JSON.stringify(e.args).slice(0, 80)})`); },
    });
    history = r.history;
    // Обрезаем историю, чтобы не разрасталась бесконечно (контекст 16k).
    if (history.length > 40) history = [history[0], ...history.slice(-30)];
    return r.answer || '(пустой ответ)';
  } finally { clearInterval(keepTyping); }
}

(async () => {
  log(`старт · бот принимает только chat_id=${OWNER} · модель поднимается по требованию`);
  // Пропускаем накопившийся бэклог: если машина спала, не хотим отвечать на всё разом.
  let offset = 0;
  try {
    const init = await tg('getUpdates', { limit: 100, timeout: 0 }, 15000);
    if (init.ok && init.result.length) {
      offset = init.result[init.result.length - 1].update_id + 1;
      log(`пропущено ${init.result.length} старых апдейтов (бэклог за время сна)`);
    }
  } catch (_) {}

  for (;;) {
    try {
      const up = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] },
        (POLL_TIMEOUT + 15) * 1000);
      if (!up.ok) { log(`getUpdates: ${up.description}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
      for (const u of up.result) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        const from = String(msg.chat.id);
        if (from !== OWNER) { log(`игнор чужого chat_id=${from}`); continue; }   // только владелец
        log(`📥 ${msg.text.slice(0, 80)}`);
        try {
          const answer = await handle(msg.text.trim());
          await send(answer);
          log(`✔ ответ отправлен (${String(answer).length} симв)`);
        } catch (e) {
          log(`✖ ошибка: ${e.message}`);
          await send(`⚠ ошибка: ${e.message}`);
          escalate('tg-bridge', e.message).catch(() => {});
        }
      }
    } catch (e) {
      log(`loop err: ${e.message}`);
      escalate('tg-bridge/poll', e.message).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
