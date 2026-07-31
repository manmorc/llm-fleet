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
//
// ── ВТОРАЯ ПОЛОВИНА ФИКСА (desktop-tt4i69c): таймауты лечат СИМПТОМ, а корень — ИСТОЧНИК КОНФИГА.
// Даже с таймаутами скрипт уходил на localhost:6379 (когда REDIS_URL нет в окружении) и подписывался
// от hostname в верхнем регистре. То есть переставал висеть, но сообщение всё равно не доезжало.
// Оба значения теперь читаются из ~/.agent-bus/fleet.env — см. fromFleetEnv ниже.
const fs = require('fs');
const path = require('path');
const os = require('os');
const IORedis = require('ioredis');
const keys = require('./keys');

// REDIS_URL берём из env, ИНАЧЕ из ~/.agent-bus/fleet.env (там же, откуда его читает ecosystem.config.js).
// Зачем: pm2-сервисы получают URL из ecosystem, а вот задачи планировщика и ручные запуски — нет,
// и скрипт молча уходил на localhost:6379, где Redis нет. С maxRetriesPerRequest:null это давало
// ВЕЧНЫЙ ретрай вместо ошибки. На этом тихо терялась половина эскалаций (шина; копия в ТГ доходила):
// падение ретро 31.07 02:17 в лог шины так и не попало. Фолбэк на localhost убран сознательно —
// лучше явная ошибка, чем отправка «в никуда».
function fromFleetEnv(key) {
  try {
    const env = fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'fleet.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}
const URL = process.env.REDIS_URL || fromFleetEnv('REDIS_URL');
if (!URL) { console.error('ERR нет REDIS_URL: ни в окружении, ни в ~/.agent-bus/fleet.env'); process.exit(1); }
// ID — тоже из fleet.env, и ТОЛЬКО потом hostname. Фолбэк на hostname давал 'DESKTOP-TT4I69C'
// (верхний регистр), под который нет ключа подписи → сообщение уходило UNVERIFIED(unknown-key)
// и от чужого ID. По модели доверия флота такое отбрасывается — то есть эскалация «доставлялась»
// в форме, которую получатель обязан игнорировать. Классический тихий сбой.
const ID = (process.env.AGENT_ID || fromFleetEnv('FLEET_NODE_ID') || os.hostname()).trim();
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
// Ошибку НЕ обрабатываем здесь и НЕ выходим из хендлера: пусть её поймает catch ниже, который
// закроет соединение и снимет сторожа. Иначе выход прямо из обработчика оставлял бы сокет открытым.
r.on('error', () => {});        // без хендлера ioredis сыплет в stderr

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
    // ТОТ ЖЕ ФИКС, что linux-prestige сделал в mcp/agent-bus.js (0eb0b6a) — здесь он был пропущен.
    // Presence — ключ с TTL 30с; он пропадает, стоит event-loop'у агента залипнуть на долгом вызове.
    // Рассылка по присутствию уходила «→ 0 агентов: (никого)» и молча терялась, хотя агенты живы.
    // Адресаты = РЕЕСТР известных агентов (agent-keys.json, ведёт владелец), inbox durable на неделю:
    // спящий агент заберёт при пробуждении. Присутствие показываем справочно — кто прочтёт сразу.
    const reg = (() => { try { return Object.keys(keys.registry() || {}).filter((k) => !k.startsWith('//')); } catch (_) { return []; } })();
    const live = new Set(await online());
    const list = (reg.length ? reg : [...live]).filter((x) => x !== ID);
    for (const d of list) await deliver(d, { ...base, to: d });
    const seen = list.filter((x) => live.has(x)).length;
    console.log(`broadcast → ${list.length} (онлайн сейчас ${seen}): ${list.join(', ') || '(никого)'} ${base.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  } else {
    const rec = { from: ID, to, text, kind: 'direct', ts }; rec.sig = keys.sign(rec);
    await deliver(to, rec);
    console.log(`→ ${to}: отправлено ${rec.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  }
})()
  .then(() => { clearTimeout(watchdog); return r.quit().catch(() => r.disconnect()); })
  .then(() => process.exit(0))
  .catch(async (e) => {
    // ЧЕСТНЫЙ ПРОВАЛ: ненулевой код + причина. Раньше .catch() не закрывал соединение — процесс жил
    // с открытым сокетом, а вызывающий не мог отличить «не доставлено» от «ок» (молчание = успех).
    clearTimeout(watchdog);
    console.error('ERR', (e && e.message) || e, '— сообщение НЕ доставлено');
    try { await r.quit(); } catch (_) { try { r.disconnect(); } catch (__) {} }
    process.exit(1);
  });
