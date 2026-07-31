#!/usr/bin/env node
// Подписанная отправка в agent-bus БЕЗ MCP-тула (для сессий со старым MCP, скриптов, cron).
// Подписывает приватным ключом (~/.agent-bus/agent.key) → получатель проверит (✓).
//   AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-send.js <to|all> <текст…>
//
// ── ФИКС 01.08.2026: скрипт ВИС и умирал по внешнему таймауту, ТЕРЯЯ сообщения ─────────────────────
// Симптом (desktop-tt4i69c → linux-prestige): «bus-send висит и убивается по таймауту»; часть ответов и
// АВАРИЙНЫХ эскалаций (agent/escalate.js, таймаут 15с) молча не доезжала. Отправитель ошибки не видел и
// считал, что доставил, — получатель не получал ничего. Классический «тихий сбой».
// Три причины разом:
//   1) `maxRetriesPerRequest: null` — ioredis ретраит команду БЕСКОНЕЧНО: при недоступном/медленном Redis
//      одноразовый скрипт не падает и не завершается, а ждёт вечно;
//   2) не было connectTimeout — установка соединения тоже могла висеть;
//   3) `.catch()` не закрывал соединение (quit был только в happy-path) → процесс жил с открытым сокетом.
// Лечение: конечные ретраи + таймауты + сторожевой таймер на весь процесс + НЕНУЛЕВОЙ exit-код,
// чтобы вызывающий отличал «не доставлено» от «ок» (молчание больше не считается успехом).
const os = require('os');
const IORedis = require('ioredis');
const keys = require('./keys');

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = (process.env.AGENT_ID || os.hostname()).trim();
const to = process.argv[2];
const text = process.argv.slice(3).join(' ');
// --who: список онлайн-агентов (нужен инструменту bus_who локального агента — чтобы он не слал в пустоту).
const WHO = to === '--who';
if (!WHO && (!to || !text)) { console.error('usage: AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-send.js <to|all> <текст>   |   node mcp/bus-send.js --who'); process.exit(1); }

// Общий бюджет на отправку. МЕНЬШЕ таймаута вызывающего (escalate.js = 15с), чтобы МЫ успели сказать
// «не смог» с причиной, а не были убиты снаружи без диагностики.
const DEADLINE_MS = Number(process.env.BUS_SEND_TIMEOUT_MS) || 10000;

const PRESENCE = 'agents:presence:', INBOX = 'agents:inbox:';
const r = new IORedis(URL, {
  maxRetriesPerRequest: 2,      // НЕ null: одноразовой отправке нужен конечный отказ, а не вечное ожидание
  connectTimeout: 5000,
  commandTimeout: 5000,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1000)), // null = прекратить реконнект
});
r.on('error', () => {});        // ошибку отдаём в catch ниже; без хендлера ioredis сыплет в stderr

// СТОРОЖ: если всё же зависли — выходим САМИ, с кодом 1 и внятной причиной.
const watchdog = setTimeout(() => {
  console.error(`ERR таймаут отправки ${DEADLINE_MS}мс (redis недоступен?) — сообщение НЕ доставлено`);
  try { r.disconnect(); } catch (_) {}
  process.exit(1);
}, DEADLINE_MS);
watchdog.unref?.();
async function online() { const out = []; for (const k of await r.keys(PRESENCE + '*')) { const v = await r.get(k); if (v) try { out.push(JSON.parse(v).id); } catch (_) {} } return out; }
async function deliver(dst, rec) { const k = INBOX + dst; await r.rpush(k, JSON.stringify(rec)); await r.ltrim(k, -500, -1); await r.expire(k, 7 * 24 * 3600); }

(async () => {
  const ts = Date.now();
  if (WHO) {
    const list = await online();
    console.log(list.length ? list.join(', ') : '(никого онлайн)');
    await r.quit(); process.exit(0);
  }
  if (to === 'all') {
    const base = { from: ID, text, kind: 'broadcast', ts }; base.sig = keys.sign(base);
    const list = (await online()).filter((x) => x !== ID);
    for (const d of list) await deliver(d, { ...base, to: d });
    console.log(`broadcast → ${list.length}: ${list.join(', ') || '(никого)'} ${base.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  } else {
    const rec = { from: ID, to, text, kind: 'direct', ts }; rec.sig = keys.sign(rec);
    await deliver(to, rec);
    console.log(`→ ${to}: отправлено ${rec.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  }
})()
  .then(() => { clearTimeout(watchdog); return r.quit().catch(() => r.disconnect()); })
  .then(() => process.exit(0))
  .catch(async (e) => {
    // ЧЕСТНЫЙ ПРОВАЛ: ненулевой код + причина. Вызывающий обязан отличить «не доставлено» от «ок».
    clearTimeout(watchdog);
    console.error('ERR', (e && e.message) || e, '— сообщение НЕ доставлено');
    try { await r.quit(); } catch (_) { try { r.disconnect(); } catch (__) {} }
    process.exit(1);
  });
