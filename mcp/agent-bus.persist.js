#!/usr/bin/env node
// Durable agent-bus inbox-персистер: BLPOP inbox → дописывает строку в лог-файл (+ stdout для pm2-логов).
// Запускается под pm2 (always-on, переживает Claude-сессии и рестарты). Живая Claude-сессия
// НЕ читает Redis напрямую, а tail'ит этот лог через Monitor → real-time в сессии + ничего не теряется офлайн.
// ВАЖНО: единственный потребитель Redis-inbox = этот персистер. Не запускай параллельно BLPOP-watcher/MCP `inbox`.
// ENV: REDIS_URL (обяз.) · AGENT_ID (по умолч. hostname) · AGENT_BUS_LOG (по умолч. ~/.agent-bus/<id>.log)
const os = require('os'), fs = require('fs'), path = require('path');
const IORedis = require('ioredis');
const keys = require('./keys'); // проверка подписи отправителя

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = (process.env.AGENT_ID || os.hostname()).trim();
const KEY = 'agents:inbox:' + ID;
const LOG = process.env.AGENT_BUS_LOG || path.join(os.homedir(), '.agent-bus', ID + '.log');

// ── ОДНО СООБЩЕНИЕ = ОДНА ФИЗИЧЕСКАЯ СТРОКА (фикс 02.08.2026) ─────────────────────────────────────
// Раньше текст писался как есть: сообщение с переносами превращалось в НЕСКОЛЬКО строк лога, и любой
// строчный читатель (tail|grep, вотчер, парсер агента) брал только первую — тело терялось молча.
// Цена уже заплачена дважды: mac-artyom прислал 6 критериев, до меня дошёл заголовок; я дважды слал
// desktop-tt4i69c объяснение, до него дошло «объясняю фактами» без фактов, владелец ждал за машиной.
// Отправитель при этом видел успех — классический тихий сбой в самом канале.
// Переносы экранируем видимым маркером: строка остаётся одной, человек читает без потерь.
//
// ДОРАБОТКА (тот же день, найдено регресс-тестами mcp/persist.test.js):
//  1) резались не только \n и \r\n: JS-читатели считают переносом ещё U+2028/U+2029 (`^`/`$` при /m,
//     да и редакторы ломают строку на них) — теперь экранируем и их;
//  2) текст, где маркер ⏎ встречался САМ ПО СЕБЕ, при обратном разборе превращался в перенос, которого
//     не было. Лечение: литеральный ⏎ в тексте удваивается (⏎⏎), перенос = ⏎+пробел. Разбор слева
//     направо однозначен, и unflatten(flatten(x)) === x для любого текста.
// Нормализация переносов сознательная: \r\n, \r, U+2028/29 восстанавливаются как \n (канал текстовый,
// а не побайтовый транспорт CRLF); всё остальное восстанавливается точь-в-точь.
const NLM = '⏎';            // видимый маркер (U+23CE)
const NL = NLM + ' ';       // перенос строки в логе = маркер + пробел
const flatten = (t) => String(t == null ? '' : t)
  .replace(/⏎/g, NLM + NLM)                        // сначала экранируем сам маркер (удвоением)
  .replace(/\r\n|\r|\n|\u2028|\u2029/g, NL);       // потом — все переносы строк (вкл. JS-овые U+2028/29)

// Обратное преобразование: восстановить текст из одной физической строки лога.
function unflatten(s) {
  s = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== NLM) { out += s[i]; continue; }
    if (s[i + 1] === NLM) { out += NLM; i++; }        // ⏎⏎ → литеральный ⏎
    else if (s[i + 1] === ' ') { out += '\n'; i++; }  // ⏎_  → перенос строки
    else out += NLM;                                  // одинокий ⏎ (старый лог/рука) — как есть
  }
  return out;
}

// Формат строки лога. Вынесен из цикла, чтобы регресс-тест проверял РОВНО то, что пишется в бою.
function formatLine(m, now = new Date()) {
  const tag = m && m.kind === 'broadcast' ? ' (broadcast)' : '';
  const v = keys.verify(m);
  const mark = v === 'ok' ? '✓' : `⚠ UNVERIFIED(${v})`;
  return `📨 ${mark} ${now.toISOString()} ${(m && m.from) || '?'}${tag}: ${flatten(m && m.text)}`;
}

// Разбор строки лога обратно в сообщение (нужен читателям и селфтесту: «дошло ли ЦЕЛИКОМ»).
const LINE_RE = /^📨 (✓|⚠ UNVERIFIED\(([^)]*)\)) (\S+) ([^\s:]+)( \(broadcast\))?: ([\s\S]*)$/;
function parseLine(line) {
  const m = LINE_RE.exec(String(line == null ? '' : line));
  if (!m) return null;
  return {
    ok: m[1] === '✓',
    verify: m[1] === '✓' ? 'ok' : m[2],
    ts: m[3],
    from: m[4],
    kind: m[5] ? 'broadcast' : 'direct',
    text: unflatten(m[6]),
    flat: m[6],
  };
}

function main() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const br = new IORedis(URL, { maxRetriesPerRequest: null });
  br.on('error', (e) => process.stderr.write('[persist] redis: ' + e.message + '\n'));
  const emit = (line) => { process.stdout.write(line + '\n'); try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {} };
  emit(`▶ persist up — ${KEY} → ${LOG}`);
  (async () => {
    for (;;) {
      try {
        const res = await br.blpop(KEY, 5); // [key,value] | null
        if (!res) continue;
        let m; try { m = JSON.parse(res[1]); } catch (_) { m = { text: res[1] }; }
        emit(formatLine(m));
      } catch (e) {
        process.stderr.write('[persist] ' + e.message + '\n');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
}

// Подключение модулем (тесты, селфтест) НЕ должно поднимать BLPOP-цикл и коннект к Redis.
if (require.main === module) main();
module.exports = { flatten, unflatten, formatLine, parseLine, NLM, NL, LOG, KEY };
