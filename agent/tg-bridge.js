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

// ОТДЕЛЬНЫЙ бот для чата с агентом (~/.tg/tg-agent.env). Зачем отдельный: у бота может быть только
// ОДИН потребитель getUpdates, а masterbot3000 занят отчётами флота — если опрашивать его же,
// ноды начнут воровать апдейты друг у друга. Разные боты = разные очереди, конфликта нет.
// Фолбэк на общий ~/.tg/tg.env — чтобы мост работал и до появления отдельных кред.
function creds() {
  let token = process.env.TG_AGENT_TOKEN || process.env.TG_TOKEN;
  let chat  = process.env.TG_AGENT_CHAT  || process.env.TG_CHAT;
  const files = [path.join(os.homedir(), '.tg', 'tg-agent.env'), path.join(os.homedir(), '.tg', 'tg.env')];
  for (const f of files) {
    if (token && chat) break;
    try {
      const env = fs.readFileSync(f, 'utf8');
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
    return ['Я — локальный агент на твоей GPU-машине (gpt-oss-20b, контекст 128k).',
      'Читаю: файлы, RAG-архив флота, grep, JSON, HTTP к localhost/tailnet и белому списку доменов.',
      'Считаю точно (арифметика через инструмент, не «в уме»).',
      'Пишу: заметки в RAG-архив, сообщения другим машинам флота.',
      'Правка файлов и команды — только через надзор: заявка уходит на согласование, я жду решения.',
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
    // Обрезку по КОЛИЧЕСТВУ сообщений убрал: она была подобрана под контекст 16k и считала
    // сообщения, а не токены — одно чтение файла это 4-5 тысяч токенов и ровно одно «сообщение».
    // Историю теперь ведёт budget.compactAsync внутри converse: считает токены точно (через
    // /tokenize самой модели), выбрасывает сначала объёмные результаты инструментов и сохраняет
    // разговор. Две обрезки подряд только мешали бы друг другу.
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

  let pollFails = 0;   // подряд идущих обрывов опроса; сбрасывается любым успешным ответом
  for (;;) {
    try {
      const up = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] },
        (POLL_TIMEOUT + 15) * 1000);
      if (!up.ok) { log(`getUpdates: ${up.description}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
      pollFails = 0;   // опрос прошёл — прежние обрывы были транзиентными
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
      // ЭСКАЛИРУЕМ ТОЛЬКО УСТОЙЧИВЫЙ СБОЙ, а не каждый обрыв. Длинный опрос Телеграма рвётся сам
      // по себе 2-3 раза в сутки (таймаут, fetch failed) и восстанавливается следующей итерацией —
      // будить живую сессию на такое значит приучить её игнорировать аварийные уведомления, а это
      // ровно класс «ложная тревога» из RETRO STANDARD. Тревога, на которую нечего делать, хуже
      // отсутствия тревоги: она обесценивает настоящие.
      // Порог: 3 подряд ≈ минута безуспешных попыток — тогда мост действительно не работает.
      pollFails++;
      log(`loop err (${pollFails} подряд): ${e.message}`);
      if (pollFails >= 3) escalate('tg-bridge/poll', `${pollFails} обрывов опроса подряд, последний: ${e.message}`).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
