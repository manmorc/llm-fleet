#!/usr/bin/env node
// Подписанная отправка в agent-bus БЕЗ MCP-тула (для сессий со старым MCP, скриптов, cron).
// Подписывает приватным ключом (~/.agent-bus/agent.key) → получатель проверит (✓).
//   AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-send.js <to|all> <текст…>
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

const PRESENCE = 'agents:presence:', INBOX = 'agents:inbox:';
// Отказывать БЫСТРО, а не висеть: это одноразовый CLI, его зовут из эскалации с таймаутом 15с.
// maxRetriesPerRequest:null (вечный ретрай) уместен для долгоживущего сервиса, но для скрипта
// означает «висеть до убийства по таймауту», а вызывающий проглотит это как непонятный сбой.
const r = new IORedis(URL, {
  maxRetriesPerRequest: 2,
  connectTimeout: 5000,
  commandTimeout: 5000,          // от linux-prestige (ec78dc3): висеть могла и уже установленная команда
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1000)),
});
r.on('error', (e) => { console.error('ERR redis:', e.message); process.exit(1); });

// СТОРОЖ НА ВЕСЬ ПРОЦЕСС — от linux-prestige. Бюджет МЕНЬШЕ таймаута вызывающего (escalate.js = 15с),
// чтобы МЫ успели сказать «не доставлено» с причиной, а не были убиты снаружи без диагностики.
// Дополняет поштучные таймауты: они закрывают известные точки зависания, сторож — все остальные.
const DEADLINE_MS = Number(process.env.BUS_SEND_TIMEOUT_MS) || 10000;
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
    // ЧЕСТНЫЙ ПРОВАЛ (от linux-prestige): ненулевой код + причина. Раньше .catch() не закрывал
    // соединение — процесс жил с открытым сокетом, и вызывающий не мог отличить «не доставлено» от «ок».
    clearTimeout(watchdog);
    console.error('ERR', (e && e.message) || e, '— сообщение НЕ доставлено');
    try { await r.quit(); } catch (_) { try { r.disconnect(); } catch (__) {} }
    process.exit(1);
  });
