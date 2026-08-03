#!/usr/bin/env node
// РЕГРЕСС-ТЕСТ проверки наблюдения за шиной (mcp/bus-watch-health.js).
//
// ЗАЧЕМ ИМЕННО ТАК: проверка, не проверенная на ЗАВЕДОМО СЛОМАННОМ случае, — это вера, а не тест.
// За 01-03.08.2026 у нас трижды «зелёный» результат оказывался ложным: метрика считала порчей саму
// правку, эталон был вписан руками неверно, канал молчал и это читалось как успех. Поэтому здесь
// каждый сценарий с ИЗВЕСТНЫМ ответом: три поломки обязаны быть пойманы, исправное состояние —
// пропущено. Если тест начнёт проходить при сломанной проверке, он бесполезен.
//
// Изоляция: подменяем домашнюю папку (HOME/USERPROFILE) на временную, чтобы не трогать боевой
// вотчер и лог. Проверка сама берёт пути от os.homedir().
//
// Запуск: node mcp/bus-watch-health.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CHECK = path.join(__dirname, 'bus-watch-health.js');
const TMP = path.join(os.tmpdir(), 'bus-watch-test-' + process.pid);
const BUS = path.join(TMP, '.agent-bus');

let pass = 0, fail = 0;

// Готовим искусственное окружение: лог входящих + пульс вотчера с заданным возрастом.
function setup({ hbAgeSec, incomingAgeMin, noHeartbeat, noLog }) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(BUS, { recursive: true });
  fs.writeFileSync(path.join(BUS, 'fleet.env'), 'FLEET_NODE_ID=testnode\n');
  if (!noLog) {
    const ts = new Date(Date.now() - (incomingAgeMin || 0) * 60000).toISOString();
    fs.writeFileSync(path.join(BUS, 'testnode.log'), `📨 ✓ ${ts} peer: тестовое сообщение\n`);
  }
  if (!noHeartbeat) {
    fs.writeFileSync(path.join(BUS, 'watch-heartbeat'), String(Math.floor((Date.now() - (hbAgeSec || 0) * 1000) / 1000)));
  }
}

function run() {
  const env = { ...process.env, HOME: TMP, USERPROFILE: TMP, FLEET_NODE_ID: 'testnode' };
  try {
    execFileSync(process.execPath, [CHECK, '--quiet'], { env, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stderr || '') };
  }
}

function check(name, opts, wantCode, wantSubstr) {
  setup(opts);
  const r = run();
  const ok = r.code === wantCode && (!wantSubstr || r.out.includes(wantSubstr));
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`      ожидался код ${wantCode}${wantSubstr ? ` и текст «${wantSubstr}»` : ''}, получен ${r.code}`);
    if (r.out) console.log(`      вывод: ${r.out.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

console.log('РЕГРЕСС: проверка наблюдения за шиной\n');

// ── ИСПРАВНОЕ СОСТОЯНИЕ: пульс свежий, сообщение пришло ДО него. Проверка обязана молчать.
check('исправно: свежий пульс, старое сообщение', { hbAgeSec: 5, incomingAgeMin: 30 }, 0);

// ── ПОЛОМКА 1: вотчер не запущен вовсе. Ровно это и было 02-03.08: пять сообщений в пустоту.
check('ловит: вотчера нет (пульса не существует)', { noHeartbeat: true, incomingAgeMin: 30 }, 1, 'НЕ ЗАПУЩЕН');

// ── ПОЛОМКА 2: вотчер умер (пульс протух). Снаружи неотличимо от тишины в эфире — в этом вся суть.
check('ловит: вотчер умер (пульс 10 мин назад)', { hbAgeSec: 600, incomingAgeMin: 30 }, 1, 'МЁРТВ');

// ── ПОЛОМКА 3: сообщение пришло ПОЗЖЕ последнего пульса → почти наверняка не увидено.
//    Самый ценный случай: отвечает на «не пропустили ли УЖЕ», а не «работает ли сейчас».
check('ловит: входящее новее последнего пульса', { hbAgeSec: 600, incomingAgeMin: 1 }, 1, 'ПОСЛЕ последнего пульса');

// ── Граница: пульс на пороге (90с) — не должен считаться мёртвым при 60с.
check('не ложно-срабатывает: пульс 60с при пороге 90с', { hbAgeSec: 60, incomingAgeMin: 30 }, 0);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nИТОГ: ${pass} прошло, ${fail} провалено`);
process.exit(fail ? 1 : 0);
