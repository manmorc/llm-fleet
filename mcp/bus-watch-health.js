#!/usr/bin/env node
// ПРОВЕРКА ПОСЛЕДНЕГО ЗВЕНА ЦЕПИ: «сообщение в логе → внимание агента».
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ bus-selftest. Селфтест проверяет КАНАЛ: подпись → Redis → персистер → лог.
// Он проходит зелёным, даже если сообщения читать НЕКОМУ. Ровно это и случилось 02-03.08.2026:
// канал был исправен, персистер жив, инбокс пуст (значит доставлено), — а ПЯТЬ сообщений от
// linux-prestige и mac-artyom пролежали в логе непрочитанными от 14 часов до полутора суток.
// Причина: вотчер лога был запущен с ТАЙМАУТОМ вместо режима «на всю сессию», отработал своё
// и умер. Никто не заметил, потому что смерть наблюдателя ничем себя не проявляет: лог пишется,
// сообщения приходят, тишина выглядит как «никто не писал».
//
// ГЛАВНАЯ МЫСЛЬ: наблюдатель, который умер, и отсутствие сообщений — снаружи НЕОТЛИЧИМЫ.
// Отличить их можно только независимым признаком жизни — отсюда файл-пульс, который вотчер
// обновляет сам. Нет свежего пульса → канал мог доставить что угодно, и это никто не увидел.
//
// Запуск: node mcp/bus-watch-health.js [--quiet]
// Код возврата: 0 — всё наблюдается; 1 — есть непросмотренные сообщения или вотчер мёртв.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.agent-bus');
const SELF = process.env.FLEET_NODE_ID || fromFleetEnv('FLEET_NODE_ID') || 'desktop-tt4i69c';
const LOG = path.join(DIR, `${SELF}.log`);
const HB = path.join(DIR, 'watch-heartbeat');
const STALE_MS = parseInt(process.env.WATCH_STALE_MS || String(90 * 1000), 10);  // пульс раз в 20с → 90с это 4 пропуска
const QUIET = process.argv.includes('--quiet');

function fromFleetEnv(key) {
  try {
    for (const l of fs.readFileSync(path.join(DIR, 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}
const say = (m) => { if (!QUIET) console.log(m); };

// Время последнего входящего в логе. Формат строки персистера начинается с отметки времени в ISO.
function lastIncoming() {
  let text = '';
  try { text = fs.readFileSync(LOG, 'utf8'); } catch (_) { return null; }
  const lines = text.split('\n').filter((l) => l.includes('📨'));
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const m = last.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  return { ts: m ? Date.parse(m[1]) : null, text: last.slice(0, 120), count: lines.length };
}

(async () => {
  const now = Date.now();
  let bad = [];

  // 1. ВОТЧЕР ЖИВ? Признак — свежий пульс, который он обновляет сам. Без него «тихо» неотличимо
  //    от «наблюдателя нет»: именно эта неразличимость и стоила нам полутора суток молчания.
  let hbAge = null;
  try { hbAge = now - (parseInt(fs.readFileSync(HB, 'utf8').trim(), 10) * 1000); } catch (_) {}
  if (hbAge === null || Number.isNaN(hbAge)) {
    bad.push('вотчер лога НЕ ЗАПУЩЕН (файла пульса нет) — входящие никто не увидит');
    say('  ✗ вотчер: пульса нет');
  } else if (hbAge > STALE_MS) {
    bad.push(`вотчер лога МЁРТВ: пульс ${Math.round(hbAge / 1000)}с назад (порог ${STALE_MS / 1000}с)`);
    say(`  ✗ вотчер: пульс ${Math.round(hbAge / 1000)}с назад — мёртв`);
  } else {
    say(`  ✓ вотчер: пульс ${Math.round(hbAge / 1000)}с назад`);
  }

  // 2. ПЕРСИСТЕР ПИШЕТ? Если лог не менялся дольше суток — либо тишина в эфире, либо он встал.
  //    Не считаем это провалом само по себе, но показываем: два «тихих» признака рядом — уже повод.
  try {
    const age = Math.round((now - fs.statSync(LOG).mtimeMs) / 60000);
    say(`  · лог обновлялся ${age} мин назад`);
  } catch (_) { bad.push('лога входящих нет вовсе — персистер не работал ни разу'); say('  ✗ лога нет'); }

  // 3. ЕСТЬ ЛИ СООБЩЕНИЯ, ПРИШЕДШИЕ ПОКА НИКТО НЕ СМОТРЕЛ. Самое ценное: отвечает не на вопрос
  //    «работает ли сейчас», а на «не пропустили ли уже». Именно его никто не задавал двое суток.
  const inc = lastIncoming();
  if (!inc) say('  · входящих в логе нет');
  else {
    const ageMin = inc.ts ? Math.round((now - inc.ts) / 60000) : null;
    say(`  · последнее входящее: ${ageMin !== null ? ageMin + ' мин назад' : 'без отметки времени'} (всего ${inc.count})`);
    // Сообщение новее последнего пульса = пришло, когда наблюдателя уже не было.
    if (inc.ts && hbAge !== null && !Number.isNaN(hbAge)) {
      const hbAt = now - hbAge;
      if (inc.ts > hbAt + 5000) bad.push(`входящее пришло ПОСЛЕ последнего пульса вотчера — вероятно, не увидено: ${inc.text}`);
    }
  }

  say('');
  if (bad.length) {
    console.error('✗ НАБЛЮДЕНИЕ ЗА ШИНОЙ НАРУШЕНО:');
    bad.forEach((b) => console.error('  • ' + b));
    console.error('\nПочинить: перезапустить вотчер лога в режиме «на всю сессию» (persistent), а не с таймаутом.');
    console.error('Команда вотчера: tail -F -n 0 ~/.agent-bus/<id>.log | grep --line-buffered -E "📨|ОШИБКА|APPROVAL"');
    console.error('Плюс он ОБЯЗАН обновлять ~/.agent-bus/watch-heartbeat, иначе эта проверка бесполезна.');
    process.exit(1);
  }
  console.log('✓ наблюдение за шиной исправно: вотчер жив, непросмотренных входящих нет');
})();
