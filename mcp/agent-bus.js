#!/usr/bin/env node
// agent-bus — MCP-сервер: связь между запущенными агентами (напр. инстансами Claude Code)
// на разных машинах через общую Redis-шину (тот же координатор, что и llm-fleet).
//
// Транспорт MCP: stdio, newline-delimited JSON-RPC 2.0. STDOUT — ТОЛЬКО протокол
// (никаких console.log в stdout; логи — в stderr).
//
// Модель сообщений: MCP не пушит в сессию → входящие кладём в durable-mailbox
// (Redis list agents:inbox:<id>), агент забирает их тулзой `inbox`. Presence — ключ с TTL,
// обновляется, пока сервер жив (= агент онлайн).
//
// ENV: REDIS_URL (обяз.) · AGENT_ID (по умолчанию hostname) · AGENT_LABEL (опис., опц.)
const os = require('os');
const IORedis = require('ioredis');
const keys = require('./keys'); // Ed25519 подпись/проверка отправителя

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const AGENT_ID = (process.env.AGENT_ID || os.hostname()).trim();
const AGENT_LABEL = process.env.AGENT_LABEL || '';
const PRESENCE = 'agents:presence:';
const INBOX = 'agents:inbox:';
const PRESENCE_TTL = 30;            // сек
const PRESENCE_EVERY = 10000;      // мс
const MAILBOX_MAX = 500;           // подрезаем список, чтобы не рос бесконечно

const log = (...a) => process.stderr.write('[agent-bus] ' + a.join(' ') + '\n');
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
redis.on('error', (e) => log('redis error:', e.message));

// ---- presence ----
async function beat() {
  try {
    await redis.set(PRESENCE + AGENT_ID,
      JSON.stringify({ id: AGENT_ID, label: AGENT_LABEL, host: os.hostname(), ts: Date.now() }),
      'EX', PRESENCE_TTL);
  } catch (e) { log('beat fail:', e.message); }
}
async function online() {
  const keys = await redis.keys(PRESENCE + '*');
  const out = [];
  for (const k of keys) {
    const v = await redis.get(k); if (!v) continue;
    try { out.push(JSON.parse(v)); } catch (_) {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
async function deliver(to, rec) {
  const k = INBOX + to;
  await redis.rpush(k, JSON.stringify(rec));
  await redis.ltrim(k, -MAILBOX_MAX, -1);
  await redis.expire(k, 7 * 24 * 3600); // недельный TTL на непрочитанное
}

// ---- инструменты ----
const TOOLS = [
  { name: 'who', description: 'Список онлайн-агентов (presence). Кто сейчас подключён к шине.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'send', description: 'Отправить сообщение конкретному агенту (в его inbox).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'AGENT_ID получателя (см. who)' },
      text: { type: 'string', description: 'Текст сообщения' } }, required: ['to', 'text'], additionalProperties: false } },
  { name: 'broadcast', description: 'Отправить сообщение всем онлайн-агентам (кроме себя).',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Текст сообщения' } }, required: ['text'], additionalProperties: false } },
  { name: 'inbox', description: 'Забрать (и очистить) входящие сообщения этого агента. peek=true — прочитать без очистки.',
    inputSchema: { type: 'object', properties: {
      peek: { type: 'boolean', description: 'Не очищать после чтения (по умолчанию false)' } }, additionalProperties: false } },
];

async function callTool(name, args) {
  args = args || {};
  await beat();
  if (name === 'who') {
    const list = await online();
    return `Онлайн (${list.length}): ` + list.map(a => a.id + (a.label ? ` (${a.label})` : '') + (a.id === AGENT_ID ? ' ← ты' : '')).join(', ');
  }
  if (name === 'send') {
    if (!args.to || !args.text) throw new Error('нужны to и text');
    const rec = { from: AGENT_ID, to: args.to, text: String(args.text), kind: 'direct', ts: Date.now() };
    rec.sig = keys.sign(rec); // подпись отправителя (canon = from|ts|text)
    await deliver(args.to, rec);
    return `Отправлено → ${args.to}: "${rec.text}"${rec.sig ? '' : ' [⚠ без подписи — нет приватного ключа]'}`;
  }
  if (name === 'broadcast') {
    if (!args.text) throw new Error('нужен text');
    // ── ФИКС 01.08.2026: broadcast доставлял ТОЛЬКО присутствующим и молча терял сообщения ──────────
    // Симптом: директива владельца ушла «→ 0 агент(ов): (никого)», хотя агенты были живы — presence это
    // ключ с TTL 30с при heartbeat раз в 10с, и он ПРОПАДАЕТ, стоит event-loop'у агента заблокироваться
    // (долгий tool-call, тяжёлый прогон, своп). Через минуту `who` показал тех же агентов онлайн.
    // Классический «тихий сбой»: отправитель видел успешный ответ, получатели не получали ничего.
    // Presence годится ДЛЯ ПОКАЗА, но НЕ как список доставки.
    // Теперь адресаты = РЕЕСТР ИЗВЕСТНЫХ АГЕНТОВ (agent-keys.json — тот же, по которому проверяем подписи,
    // ведёт владелец). Inbox durable (недельный TTL) → спящий агент заберёт своё при следующем `inbox`.
    // Присутствие показываем справочно, чтобы было видно, кто прочитает не сразу.
    const reg = (() => { try { return Object.keys(keys.registry() || {}).filter(k => !k.startsWith('//')); } catch (_) { return []; } })();
    const live = new Set((await online()).map(a => a.id));
    const targets = (reg.length ? reg : [...live]).filter(id => id !== AGENT_ID);
    const rec = { from: AGENT_ID, text: String(args.text), kind: 'broadcast', ts: Date.now() };
    rec.sig = keys.sign(rec); // canon не включает to → одна подпись валидна для всех получателей
    for (const id of targets) await deliver(id, { ...rec, to: id });
    const shown = targets.map(id => id + (live.has(id) ? '' : ' (спит — заберёт из inbox)')).join(', ');
    return `Broadcast → ${targets.length} агент(ов): ${shown || '(реестр пуст)'} : "${rec.text}"`;
  }
  if (name === 'inbox') {
    const k = INBOX + AGENT_ID;
    const raw = await redis.lrange(k, 0, -1);
    if (!args.peek) await redis.del(k);
    if (!raw.length) return '(пусто) — новых сообщений нет';
    const msgs = raw.map(s => { try { return JSON.parse(s); } catch { return { text: s }; } });
    const mark = (m) => { const v = keys.verify(m); return v === 'ok' ? '✓' : `⚠${v}`; };
    return `Входящих: ${msgs.length}\n` + msgs.map((m, i) =>
      `  ${i + 1}. ${mark(m)} [${new Date(m.ts).toLocaleTimeString()}] ${m.from}${m.kind === 'broadcast' ? ' (broadcast)' : ''}: ${m.text}`).join('\n');
  }
  throw new Error('неизвестный инструмент: ' + name);
}

// ---- минимальный MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-bus', version: '0.1.0' },
      instructions: `Ты агент "${AGENT_ID}" на шине agent-bus. who — кто онлайн; send/broadcast — отправить; inbox — забрать входящие. Проверяй inbox периодически: входящие не приходят сами, их надо забирать.`,
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // без ответа
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await callTool(params && params.name, params && params.arguments);
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'Ошибка: ' + e.message }], isError: true });
    }
  }
  if (id !== undefined) return replyErr(id, -32601, 'method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log('bad json line'); continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handle error:', e.message));
  }
});
process.stdin.on('end', () => process.exit(0));

beat();
const hbTimer = setInterval(beat, PRESENCE_EVERY);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  clearInterval(hbTimer);
  try { await redis.del(PRESENCE + AGENT_ID); await redis.quit(); } catch (_) {}
  process.exit(0);
});
log(`up — agent="${AGENT_ID}" redis=${REDIS_URL.replace(/:[^:@/]*@/, ':***@')}`);
