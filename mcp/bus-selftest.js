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
const persist = require('./agent-bus.persist'); // flatten/parseLine — те же, что пишут лог (require не поднимает BLPOP)

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
const PRESENCE = 'agents:presence:';
const PRESENCE_TTL = 120;          // должно совпадать с mcp/agent-bus.js
const PRESENCE_EVERY_MS = 10000;   // период хартбита там же
const DEADLINE_MS = Number(process.env.BUS_SELFTEST_TIMEOUT_MS) || 25000;
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

// Круг «отправил САМ СЕБЕ → принял обратно» тем же путём, что и реальная отправка.
// Потребителей у inbox может быть ДВА, и проверять надо тот, что реально работает:
//   (а) персистер под pm2 (mcp/agent-bus.persist.js) — BLPOP выгребает inbox в ~/.agent-bus/<id>.log,
//       и именно ЕГО строка (`✓` / `⚠ UNVERIFIED(...)`) — то, что увидит живая сессия;
//   (б) MCP-тул `inbox` — тогда сообщение просто лежит в списке Redis, читаем сами.
// Чужие входящие НЕ трогаем: из списка убираем ТОЧЕЧНЫМ lrem только свою запись.
// → { via:'persist', lines } | { via:'redis', raw } | null (не дождались)
async function roundTrip(rec, nonce) {
  const k = INBOX + ID;
  const payload = JSON.stringify(rec);
  const logAt = logSize();     // отметка ДО отправки: читаем только то, что дописано после неё
  await r.rpush(k, payload);
  await r.ltrim(k, -500, -1);
  await r.expire(k, 7 * 24 * 3600);
  const until = Date.now() + READ_MS;
  for (;;) {
    const lines = logTail(logAt).split(/\r?\n/).filter((l) => l.includes(nonce));
    if (lines.length) return { via: 'persist', lines };
    const mine = (await r.lrange(k, 0, -1)).filter((s) => s.includes(nonce));
    if (mine.length) {
      await r.lrem(k, 0, mine[0]).catch(() => {});      // уборка ДО любого выхода
      return { via: 'redis', raw: mine[0] };
    }
    if (Date.now() >= until) {
      await r.lrem(k, 0, payload).catch(() => {});      // за собой убираем и при провале
      return null;
    }
    await sleep(200);
  }
}

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

  // ── 3–5. Отправка ТЕМ ЖЕ путём, что реальная (rpush + ltrim + недельный TTL), и приём обратно. ──
  const SIG_HINT = 'см. mcp/keys.js: подписываются from+ts+text; расхождение = не тот ключ или подмена полей после подписи';
  const got = await roundTrip(rec, nonce);
  if (!got) {
    return fail(`сообщение не вернулось ни в лог персистера, ни в inbox за ${READ_MS}мс — канал НЕ подтверждён`,
      'проверить, что REDIS_URL/AGENT_ID совпадают с ~/.agent-bus/run-persist.sh и что персистер жив (pm2 list)');
  }
  steps.push('доставлено в inbox');
  let via;
  if (got.via === 'persist') {
    const line = got.lines[0].trim();
    if (!line.includes('✓') || line.includes('UNVERIFIED')) {
      return fail(`персистер записал сообщение как «${line.includes('UNVERIFIED') ? '⚠ UNVERIFIED' : 'без ✓'}» вместо «✓» — получатель обязан такое игнорировать`, SIG_HINT);
    }
    via = 'персистер (BLPOP → ~/.agent-bus/<id>.log)';
  } else {
    const msg = JSON.parse(got.raw);
    const v = keys.verify(msg);
    if (v !== 'ok') return fail(`получено с «⚠ ${v}» вместо «✓» — такое сообщение получатель обязан игнорировать`, SIG_HINT);
    if (msg.from !== ID || msg.text !== rec.text) return fail('вернулось не то, что отправляли (from/text не совпали)');
    via = 'inbox Redis (потребитель — MCP-тул `inbox`)';
  }
  steps.push(`прочитано обратно через ${via}`);
  steps.push('подпись проверена: ✓');

  // ── 6. МНОГОСТРОЧНОЕ СООБЩЕНИЕ END-TO-END (регресс на инцидент 02.08.2026) ──────────────────────
  // Персистер писал текст как есть → сообщение с переносами становилось НЕСКОЛЬКИМИ строками лога,
  // а строчный читатель (tail|grep, вотчер) брал первую. Дважды доезжал только заголовок, отправитель
  // видел успех. Проверяем ровно это: одно сообщение = ОДНА физическая строка, и текст восстановим
  // побайтово. Nonce стоит и в первой, и в ПОСЛЕДНЕЙ строке тела — если тело разрежут, это видно сразу.
  const nonce2 = crypto.randomUUID();
  const multi = [
    `bus-selftest multiline ${nonce2}`,
    'вторая строка · маркер ⏎ прямо в тексте · двоеточие: и (broadcast)',
    '',
    `последняя строка · хвост ${nonce2}`,
  ].join('\n');
  const rec2 = { from: ID, to: ID, text: multi, kind: 'direct', ts: Date.now() };
  rec2.sig = keys.sign(rec2);
  const got2 = await roundTrip(rec2, nonce2);
  if (!got2) return fail(`многострочное сообщение не вернулось за ${READ_MS}мс — канал НЕ подтверждён`);
  if (got2.via === 'persist') {
    if (got2.lines.length !== 1) {
      return fail(`многострочное сообщение разрезано на ${got2.lines.length} строк(и) лога — читатель возьмёт первую и потеряет тело`,
        'mcp/agent-bus.persist.js: flatten() обязан схлопывать переносы (\\n, \\r\\n, U+2028/29) в маркер ⏎');
    }
    const parsed = persist.parseLine(got2.lines[0]);
    if (!parsed) return fail('строка лога не разбирается обратно — формат персистера и читатель разъехались');
    if (!parsed.ok) return fail(`многострочное принято как «⚠ ${parsed.verify}» вместо «✓»`, SIG_HINT);
    if (parsed.text !== multi) {
      return fail('текст многострочного НЕ восстановился побайтово — тело искажено или обрезано',
        `отправили ${JSON.stringify(multi)} / получили ${JSON.stringify(parsed.text)}`);
    }
    steps.push(`многострочное (${multi.split('\n').length} строк тела): в логе ОДНА строка, текст восстановлен побайтово`);
  } else {
    const msg2 = JSON.parse(got2.raw);
    if (keys.verify(msg2) !== 'ok') return fail('многострочное принято без ✓', SIG_HINT);
    if (msg2.text !== multi) return fail('многострочное вернулось с искажённым текстом');
    // Персистера на этом узле нет → инвариант «одно сообщение = одна строка» проверяем локально
    // тем же кодом, что пишет лог: иначе баг доедет незамеченным до узла, где персистер есть.
    const line2 = persist.formatLine(msg2);
    if (line2.split(/\r\n|\r|\n|\u2028|\u2029/).length !== 1) return fail('flatten() персистера не схлопывает переносы — лог разъедется на узле с персистером');
    if (persist.parseLine(line2).text !== multi) return fail('unflatten() персистера не восстанавливает текст');
    steps.push('многострочное: текст цел (персистер не запущен — формат лога проверен локально)');
  }

  // ── 7. PRESENCE: живой агент не должен «пропадать» ─────────────────────────────────────────────
  // TTL 30с при хартбите 10с истекал на ЖИВОМ агенте (долгий tool-call блокирует event-loop) — и
  // broadcast рапортовал «0 агентов» как успех. Сейчас TTL 120с; доставка от presence больше не зависит,
  // но `who` обязан говорить правду. Смотрим запас TTL и свежесть хартбита.
  const pk = PRESENCE + ID;
  const praw = await r.get(pk);
  if (!praw) {
    steps.push('presence: ключа нет (MCP-сервер этого агента не запущен) — на доставку не влияет');
  } else {
    const ttl = await r.ttl(pk);
    let age = null;
    try { age = Math.round((Date.now() - JSON.parse(praw).ts) / 1000); } catch (_) {}
    if (ttl === -1) return fail('presence-ключ без TTL — «вечно онлайн» переживёт смерть агента, who будет врать');
    if (ttl > PRESENCE_TTL) return fail(`presence TTL ${ttl}с больше ожидаемых ${PRESENCE_TTL}с — конфиг разъехался с mcp/agent-bus.js`);
    if (age != null && age > PRESENCE_TTL) return fail(`хартбит протух: последний удар ${age}с назад при TTL ${PRESENCE_TTL}с — who показывает призрака`);
    const warn = ttl < 3 * (PRESENCE_EVERY_MS / 1000)
      ? ' ⚠ запас меньше трёх хартбитов — агент рискует «пропасть» из who под нагрузкой'
      : '';
    steps.push(`presence: TTL ${ttl}с (потолок ${PRESENCE_TTL}с), хартбит ${age == null ? '?' : age}с назад${warn}`);
  }

  console.log(`✓ bus-selftest OK — канал "${ID}" → "${ID}" рабочий, подписанный, многострочное доезжает целиком`);
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
