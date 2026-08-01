#!/usr/bin/env node
// bus-selftest — проверка КАНАЛА шины «от начала до конца»: отправляем сообщение САМИ СЕБЕ тем же
// путём, что и реальная отправка (подпись → agents:inbox:<id> в Redis), забираем из своего inbox и
// проверяем, что оно (а) доехало и (б) прошло проверку подписи как `✓`, а не `⚠ UNVERIFIED`.
//
//   AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-selftest.js
//
// ЗАЧЕМ (01.08.2026): за сутки канал сломался в трёх местах подряд, и каждый раз «молчание читалось как
// успех» — bus-send висел на Redis без таймаутов, broadcast рассылал только «присутствующим» и вернул
// «0 агентов» как успех, а директива флоту ушла НЕПОДПИСАННОЙ (получатель обязан такую игнорировать —
// то есть «доставлено» в форме, которую никто не должен исполнять). Отправитель во всех трёх случаях
// был уверен, что всё хорошо. Селфтест делает это состояние наблюдаемым ДО отправки чего-то важного.
//
// ЗАПУСКАТЬ: при старте сессии и ПЕРЕД любой директивой/эскалацией по шине.
// Провал → НЕНУЛЕВОЙ exit-код + внятная причина (никакого «тихо ок»).
//
// Соединение настроено как в bus-send.js: КОНЕЧНЫЕ ретраи + таймауты + сторож на весь процесс.
// Повторять старый баг с `maxRetriesPerRequest: null` (бесконечное ожидание вместо отказа) нельзя.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const IORedis = require('ioredis');
const keys = require('./keys');

// Источник конфига — тот же, что у bus-send.js: env, иначе ~/.agent-bus/fleet.env. Фолбэка на
// localhost:6379 нет СОЗНАТЕЛЬНО: лучше явная ошибка, чем «успешная» проверка не той шины.
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
if (!URL) { fail('нет REDIS_URL: ни в окружении, ни в ~/.agent-bus/fleet.env'); }
const ID = (process.env.AGENT_ID || fromFleetEnv('FLEET_NODE_ID') || os.hostname()).trim();

const INBOX = 'agents:inbox:';
const DEADLINE_MS = Number(process.env.BUS_SELFTEST_TIMEOUT_MS) || 15000;
const READ_MS = Number(process.env.BUS_SELFTEST_READ_MS) || 6000;   // сколько ждём приёма (< DEADLINE_MS)

// Лог персистера — это и есть «входящие» живой сессии на этой машине (см. mcp/agent-bus.persist.js).
const LOG = process.env.AGENT_BUS_LOG || path.join(os.homedir(), '.agent-bus', ID + '.log');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function logSize() { try { return fs.statSync(LOG).size; } catch (_) { return 0; } }
function logTail(from) {
  try {
    const fd = fs.openSync(LOG, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.max(0, size - from);
    const buf = Buffer.alloc(len);
    if (len) fs.readSync(fd, buf, 0, len, from);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// URL шины НЕ печатаем никогда (в нём пароль/хост) — только сам факт результата.
function fail(reason, hint) {
  console.error(`✗ bus-selftest ПРОВАЛ: ${reason}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

const r = new IORedis(URL, {
  maxRetriesPerRequest: 2,      // НЕ null: одноразовой проверке нужен конечный отказ, а не вечное ожидание
  connectTimeout: 5000,
  commandTimeout: 5000,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1000)),
});
r.on('error', () => {});        // ошибку ловит catch ниже — он же закрывает сокет

const watchdog = setTimeout(() => {
  console.error(`✗ bus-selftest ПРОВАЛ: таймаут ${DEADLINE_MS}мс — шина не ответила, канал НЕ подтверждён`);
  try { r.disconnect(); } catch (_) {}
  process.exit(1);
}, DEADLINE_MS);
watchdog.unref?.();

(async () => {
  const steps = [];

  // ── 1. Ключ подписи. Именно его отсутствие рождает «⚠ unsigned» у получателя. ──
  const nonce = crypto.randomUUID();
  const rec = { from: ID, to: ID, text: `bus-selftest ${nonce}`, kind: 'direct', ts: Date.now() };
  rec.sig = keys.sign(rec);
  if (!rec.sig) {
    return fail(`нет приватного ключа — сообщения уходят НЕПОДПИСАННЫМИ (⚠ unsigned), получатель обязан их игнорировать`,
      `создать ключ: node mcp/keygen.js (файл ${keys.PRIV_FILE}), публичный — владельцу в mcp/agent-keys.json`);
  }
  steps.push('подпись поставлена');

  // ── 2. Свой pubkey в реестре: без него получатель увидит ⚠ unknown-key, а не ✓. ──
  const reg = keys.registry() || {};
  if (!reg[ID]) {
    return fail(`агента "${ID}" нет в реестре ключей — у получателей будет «⚠ unknown-key», а не «✓»`,
      `свой публичный ключ: node -e "console.log(require('./mcp/keys').myPub())" → в mcp/agent-keys.json (ревью владельца)`);
  }
  if (keys.myPub() !== reg[ID]) {
    return fail(`публичный ключ в реестре НЕ соответствует локальному приватному для "${ID}" — подпись будет «⚠ BAD»`,
      `сверить mcp/agent-keys.json с node -e "console.log(require('./mcp/keys').myPub())"`);
  }
  steps.push('ключ есть в реестре и совпадает с локальным');

  // ── 3. Отправка ТЕМ ЖЕ путём, что реальная (rpush в свой inbox + ltrim + недельный TTL). ──
  const k = INBOX + ID;
  const payload = JSON.stringify(rec);
  const logAt = logSize();     // отметка ДО отправки: читаем только то, что дописано после неё
  await r.rpush(k, payload);
  await r.ltrim(k, -500, -1);
  await r.expire(k, 7 * 24 * 3600);
  steps.push('доставлено в inbox');

  // ── 4–5. Приём. Потребителей у inbox может быть ДВА, и проверять надо тот, что реально работает:
  //   (а) персистер под pm2 (mcp/agent-bus.persist.js) — BLPOP выгребает inbox в ~/.agent-bus/<id>.log,
  //       и именно ЕГО пометка (`✓` / `⚠ UNVERIFIED(...)`) — то, что увидит живая сессия;
  //   (б) MCP-тул `inbox` — тогда сообщение просто лежит в списке Redis, читаем сами.
  // Ждём появления в любом из двух, но не молча: не дождались = провал с причиной.
  const until = Date.now() + READ_MS;
  let via = null;
  for (;;) {
    // (а) лог персистера
    const line = (logTail(logAt).split(/\r?\n/).find((l) => l.includes(nonce)) || '').trim();
    if (line) {
      if (!line.includes('✓') || line.includes('UNVERIFIED')) {
        return fail(`персистер записал сообщение как «${line.includes('UNVERIFIED') ? '⚠ UNVERIFIED' : 'без ✓'}» вместо «✓» — получатель обязан такое игнорировать`,
          'см. mcp/keys.js: подписываются from+ts+text; расхождение = не тот ключ или подмена полей после подписи');
      }
      via = 'персистер (BLPOP → ~/.agent-bus/<id>.log)';
      break;
    }
    // (б) список Redis (потребитель — MCP-тул `inbox`). Читаем НЕразрушающе: чужие входящие
    //     съедать нельзя, свою запись потом уберём точечным lrem.
    const mine = (await r.lrange(k, 0, -1)).filter((s) => s.includes(nonce));
    if (mine.length) {
      const msg = JSON.parse(mine[0]);
      const v = keys.verify(msg);
      await r.lrem(k, 0, mine[0]).catch(() => {});      // уборка ДО любого выхода
      if (v !== 'ok') {
        return fail(`получено с «⚠ ${v}» вместо «✓» — такое сообщение получатель обязан игнорировать`,
          'см. mcp/keys.js: подписываются from+ts+text; расхождение = не тот ключ или подмена полей после подписи');
      }
      if (msg.from !== ID || msg.text !== rec.text) return fail('вернулось не то, что отправляли (from/text не совпали)');
      via = 'inbox Redis (потребитель — MCP-тул `inbox`)';
      break;
    }
    if (Date.now() >= until) {
      await r.lrem(k, 0, payload).catch(() => {});
      return fail(`сообщение не вернулось ни в лог персистера, ни в inbox за ${READ_MS}мс — канал НЕ подтверждён`,
        'проверить, что REDIS_URL/AGENT_ID совпадают с ~/.agent-bus/run-persist.sh и что персистер жив (pm2 list)');
    }
    await sleep(200);
  }
  steps.push(`прочитано обратно через ${via}`);
  steps.push('подпись проверена: ✓');

  console.log(`✓ bus-selftest OK — канал "${ID}" → "${ID}" рабочий и подписанный`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
})()
  .then(() => { clearTimeout(watchdog); return r.quit().catch(() => r.disconnect()); })
  .then(() => process.exit(0))
  .catch(async (e) => {
    // ЧЕСТНЫЙ ПРОВАЛ: причина + ненулевой код. Молчание успехом не считается.
    clearTimeout(watchdog);
    console.error('✗ bus-selftest ПРОВАЛ:', (e && e.message) || e, '— канал НЕ подтверждён');
    try { await r.quit(); } catch (_) { try { r.disconnect(); } catch (__) {} }
    process.exit(1);
  });
