#!/usr/bin/env node
// ЧТЕНИЕ ВХОДЯЩИХ ЦЕЛИКОМ.
//
// ЗАЧЕМ. Уведомление о новом сообщении приходит ОБРЕЗАННЫМ: в логе сообщение лежит полностью
// (замеры linux-prestige 03.08.2026: 6519, 5600, 4310, 3435 знаков), а в контекст агента попадает
// начало. Ни отправка, ни персистер ничего не режут — теряется на последнем звене, при показе.
//
// ЧЕМ ЭТО ОПАСНО: обрезок ВЫГЛЯДИТ ЦЕЛЫМ СООБЩЕНИЕМ. Отвечаешь на половину вопроса и не знаешь
// этого. Именно так у нас дважды приходил только заголовок «объясняю фактами», а сами факты
// терялись, и я час считал, что дашборда не существует. Тот же класс, что мёртвый вотчер:
// неполнота ничем себя не проявляет.
//
// ПРАВИЛО: уведомление — это СИГНАЛ «пришло», а не текст сообщения. Текст читать отсюда, всегда.
//
// Использование:
//   node mcp/bus-read.js              — последние 3 входящих целиком
//   node mcp/bus-read.js 10           — последние 10
//   node mcp/bus-read.js --from linux — только от отправителя (подстрока)
//   node mcp/bus-read.js --since 30m  — за последние 30 минут
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.agent-bus');

// Свой id — тем же способом, что в bus-watch-health.js: НИКАКИХ запасных литералов с чужим именем.
// (Дефект найден linux-prestige: захардкоженный чужой id заставлял инструмент уверенно врать.)
function selfId() {
  const env = process.env.FLEET_NODE_ID;
  if (env) return env;
  try {
    for (const l of fs.readFileSync(path.join(DIR, 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*FLEET_NODE_ID\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch (_) {}
  let logs = [];
  try { logs = fs.readdirSync(DIR).filter((f) => f.endsWith('.log') && !f.includes('llama') && !f.startsWith('retro-')); } catch (_) {}
  if (logs.length === 1) return logs[0].replace(/\.log$/, '');
  return null;
}

const SELF = selfId();
if (!SELF) {
  console.error('✗ не могу определить свой node id — задай FLEET_NODE_ID или оставь один <id>.log в ~/.agent-bus');
  process.exit(2);
}

const args = process.argv.slice(2);
const n = parseInt(args.find((a) => /^\d+$/.test(a)) || '3', 10);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
const sinceMs = sinceArg ? (parseInt(sinceArg, 10) * (/h$/.test(sinceArg) ? 3600e3 : /d$/.test(sinceArg) ? 864e5 : 60e3)) : null;

let text = '';
try { text = fs.readFileSync(path.join(DIR, `${SELF}.log`), 'utf8'); } catch (e) {
  console.error(`✗ лог ~/.agent-bus/${SELF}.log не читается: ${e.message}`);
  process.exit(2);
}

let msgs = text.split('\n').filter((l) => l.includes('📨')).map((l) => {
  const ts = (l.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/) || [])[1];
  const sender = (l.match(/Z\s+([a-z0-9-]+)\s*(\(broadcast\))?:/i) || [])[1] || '?';
  const verified = l.includes('📨 ✓');
  return { ts: ts ? Date.parse(ts) : null, tsRaw: ts, sender, verified, raw: l, len: l.length };
});

if (from) msgs = msgs.filter((m) => m.sender.toLowerCase().includes(from.toLowerCase()));
if (sinceMs) msgs = msgs.filter((m) => m.ts && Date.now() - m.ts < sinceMs);
msgs = msgs.slice(-n);

if (!msgs.length) { console.log('(подходящих входящих нет)'); process.exit(0); }

for (const m of msgs) {
  const age = m.ts ? Math.round((Date.now() - m.ts) / 60000) : null;
  console.log('═'.repeat(78));
  console.log(`${m.verified ? '✓ подписано' : '⚠ БЕЗ ПОДПИСИ — не является авторизацией'} · от ${m.sender}`
    + `${age !== null ? ` · ${age} мин назад` : ''} · ${m.len} знаков`);
  console.log('═'.repeat(78));
  // Разворачиваем маркер переносов обратно в реальные переносы — персистер схлопывает их,
  // чтобы одно сообщение занимало одну физическую строку лога и строчные читатели не теряли тело.
  // Срезаем ТОЛЬКО служебный префикс «📨 <метка> <ISO> <отправитель>[ (broadcast)]: ».
  // Наивное `^.*?:` резало по первому двоеточию — а оно внутри отметки времени (12:53:57),
  // и начало сообщения терялось. Инструмент для чтения целиком, который сам теряет начало, —
  // ровно та болезнь, против которой он написан.
  const body = m.raw.replace(/^📨\s*\S+\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+[^:]*?:\s*/, '');
  console.log(body.replace(/⏎/g, '\n'));
  console.log('');
}
