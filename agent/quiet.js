#!/usr/bin/env node
// ТИХИЙ РЕЖИМ — освободить видеопамять под игры.
//
// Проблема: локальная модель занимает 11.2 ГБ из 12.3 ГБ VRAM. Пока она загружена, играть нельзя,
// а джобы (ТГ-мост, веб-чат, задачи с шины, ежедневное ретро) поднимают её ПО ТРЕБОВАНИЮ — то есть
// посреди игры кто-то может дёрнуть модель, и игра упадёт по нехватке памяти.
//
// Решение: файл-флаг ~/.agent-bus/quiet-mode.
//   • флаг проверяется в server.ensure() на КАЖДЫЙ подъём → включение действует немедленно;
//   • файл, а не переменная окружения: видят все процессы сразу, перезапуск не нужен;
//   • при включении модель ВЫГРУЖАЕТСЯ сразу, а не «когда-нибудь по простою».
// Джобы при этом не падают молча: ensure() бросает понятную ошибку с инструкцией, как выключить.
//
// Использование:  node agent/quiet.js on | off | status
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.agent-bus', 'quiet-mode');
const cmd = (process.argv[2] || 'status').toLowerCase();

const { execFileSync } = require('child_process');

// Занято/всего в МБ, или null если карту не опросить. Число, а не строка: результат надо СУДИТЬ,
// а не только печатать. Раньше здесь возвращалась готовая строка, и никто не проверял, упало ли
// потребление на самом деле — печатали цифру рядом со словом «выгружена» и расходились.
function vramUsed() {
  try {
    const o = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    const [u, t] = o.trim().split(/\s*,\s*/).map((x) => parseInt(x, 10));
    return Number.isFinite(u) && Number.isFinite(t) ? { used: u, total: t } : null;
  } catch (_) { return null; }
}
const vramLine = (v) => (v ? `${v.used} / ${v.total} МБ занято (свободно ${v.total - v.used} МБ)` : 'nvidia-smi недоступен');

// КТО именно держит видеопамять. Нужно, когда модель выгружена, а память всё равно занята:
// на этой машине есть и другие едоки (LM Studio, браузер, игра). Без имён владелец видит только
// «не выгрузилась» и винит выгрузку, хотя держит уже кто-то другой.
function vramHolders() {
  try {
    const o = execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_gpu_memory,process_name', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    return o.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [pid, mb, ...rest] = l.split(/\s*,\s*/);
      return { pid: Number(pid), mb: Number(mb), name: (rest.join(',') || '?').split(/[\\/]/).pop() };
    }).filter((h) => Number.isFinite(h.mb)).sort((a, b) => b.mb - a.mb);
  } catch (_) { return []; }
}

(async () => {
  if (cmd === 'on') {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `включено ${new Date().toISOString()}\n`);
    console.log('🔇 ТИХИЙ РЕЖИМ ВКЛЮЧЁН — модель больше не поднимается по запросам.');
    // Выгружаем НЕМЕДЛЕННО: смысл режима в свободной видеопамяти прямо сейчас, а не через 10 минут
    // простоя. Без этого владелец включил бы режим, запустил игру и всё равно упёрся в занятые 11 ГБ.
    //
    // ОТЧИТЫВАЕМСЯ ПО ФАКТУ, А НЕ ПО НАМЕРЕНИЮ. Здесь стояло `await server.stop()` без проверки
    // результата и печаталось «выгружена, видеопамять освобождена» — безусловно. Если taskkill не
    // срабатывал или процесс ещё умирал, владелец читал «освобождена», шёл в игру и упирался в
    // занятые 11 ГБ. Теперь: ждём подтверждённой смерти процесса, СРАВНИВАЕМ видеопамять до и
    // после и, если она не освободилась, называем виновника поимённо.
    const before = vramUsed();
    try {
      const server = require('./server');
      const r = await server.stop();
      if (!r.wasLoaded) console.log('   модель и так не была загружена.');
      else if (r.ok) console.log(`   модель выгружена — процесс ${r.killed.join(', ')} завершён за ${(r.waitedMs / 1000).toFixed(1)} с.`);
      else {
        console.log(`   ❌ ВЫГРУЗИТЬ НЕ УДАЛОСЬ: ${r.why}`);
        console.log('      Видеопамять НЕ освобождена — играть пока нельзя.');
        console.log(`      Убить вручную: taskkill /F /PID ${(r.left || []).join(' /PID ') || '<pid>'}`);
      }
    } catch (e) { console.log(`   ❌ выгрузить не удалось: ${e.message}`); }

    // КОНТРОЛЬ ВОЗВРАТА. Выгрузить мало — надо, чтобы модель не поднялась обратно через секунду.
    // Гейт живёт в ensure(), но в :8081 можно постучаться и мимо него (встроенный веб-чат llama.cpp,
    // любой прямой клиент, чужой скрипт). Тогда владелец видит ровно то, на что жаловался: ярлык
    // нажат, а память занята. Проверяем фактом, а не верой в гейт.
    const server2 = require('./server');
    await new Promise((s) => setTimeout(s, 3000));
    const back = (() => { try { return server2.llamaPids(); } catch (_) { return []; } })();
    if (back.length) {
      console.log(`   ❌ МОДЕЛЬ ПОДНЯЛАСЬ ОБРАТНО за 3 с (pid ${back.join(', ')}) — кто-то грузит её мимо тихого режима.`);
      console.log('      Смотреть: pm2 logs --lines 30, и ~/.agent-bus/llama-server.err.log');
    }

    const after = vramUsed();
    console.log(`   VRAM: ${vramLine(after)}`);
    // Память могла остаться занятой и БЕЗ нашей вины — держит другой процесс. Разница принципиальна:
    // в первом случае чинить выгрузку, во втором закрывать чужое приложение. Не заставляем гадать.
    if (after && after.used > 1500) {
      const holders = vramHolders().filter((h) => h.mb > 200);
      if (holders.length) {
        console.log('   ⚠ видеопамять всё ещё занята, держат:');
        for (const h of holders.slice(0, 5)) console.log(`      ${h.name} (pid ${h.pid}) — ${h.mb} МБ`);
      } else if (before && after.used >= before.used - 200) {
        console.log('   ⚠ видеопамять не освободилась, но и процессов-едоков не видно —');
        console.log('      возможно, драйвер ещё отдаёт память. Проверьте через несколько секунд:');
        console.log('      node agent/quiet.js status');
      }
    }
    console.log('   Обратно: ярлык «Модель ВКЛ» или node agent/quiet.js off');
    return;
  }

  if (cmd === 'off') {
    try { fs.unlinkSync(FILE); } catch (_) {}
    console.log('🔊 Тихий режим выключен.');
    // И СРАЗУ ПОДНИМАЕМ МОДЕЛЬ. Раньше здесь только снимался запрет, а модель ждала первого
    // обращения — но ярлык называется «Модель ВКЛ», и владелец справедливо ожидал, что после
    // нажатия она РАБОТАЕТ, а не «сможет заработать, когда кто-нибудь попросит».
    // Имя не должно обещать больше, чем механизм делает: тот же класс, что поле «отправлено»
    // вместо «доставлено» и зелёный тест, ничего не проверивший.
    try {
      const server = require('./server');
      if (await server.probe(3000)) { console.log('   модель уже была загружена.'); }
      else {
        process.stdout.write('   поднимаю модель, ~10 с… ');
        const t0 = Date.now();
        await server.ensure();
        console.log(`готово за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
      }
    } catch (e) { console.log(`   ⚠ поднять не удалось: ${e.message}`); }
    console.log(`   VRAM: ${vramLine(vramUsed())}`);
    return;
  }

  const on = fs.existsSync(FILE);
  const server = require('./server');
  let loaded = false;
  try { loaded = await server.probe(3000); } catch (_) {}
  // «Выгружена» показываем по ПРОЦЕССАМ, а не только по порту: сокет замолкает раньше, чем
  // процесс умирает и драйвер отдаёт память, и статус успевал соврать в самый нужный момент.
  let pids = [];
  try { pids = server.llamaPids(); } catch (_) {}
  console.log(`режим: ${on ? '🔇 ТИХИЙ (модель заблокирована)' : '🔊 обычный (модель поднимается по запросу)'}`);
  console.log(`модель сейчас: ${pids.length ? `🟢 в памяти (pid ${pids.join(', ')}${loaded ? '' : ', порт молчит — умирает или грузится'})` : '💤 выгружена'}`);
  const v = vramUsed();
  console.log(`VRAM: ${vramLine(v)}`);
  if (v && v.used > 1500) {
    for (const h of vramHolders().filter((x) => x.mb > 200).slice(0, 5)) console.log(`  держит: ${h.name} (pid ${h.pid}) — ${h.mb} МБ`);
  }
  if (on) { try { console.log(`включено: ${fs.readFileSync(FILE, 'utf8').trim()}`); } catch (_) {} }
})();
