// ТЕСТЫ ТИХОГО РЕЖИМА: выгрузка модели из видеопамяти.
//
// ПОВОД. Владелец 04.08.2026: «ярлыки не выключают локальную LLM и не выгружают её из памяти».
// Причина оказалась не в ярлыках — они указывали верно, — а в том, что выгрузка ОБЪЯВЛЯЛА успех,
// не проверив его:
//   • server.stop() возвращал true сразу после отправки `taskkill`, не дожидаясь смерти процесса.
//     Под нагрузкой отдать 11.6 ГБ занимает секунды: сообщение «выгружена» опережало реальность.
//   • quiet.js вообще ИГНОРИРОВАЛ возвращаемое значение и печатал «видеопамять освобождена»
//     безусловно — даже когда taskkill падал по правам и не убивал ничего.
// То есть отчёт был честен относительно НАМЕРЕНИЯ и молчал о РЕЗУЛЬТАТЕ.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Главный тест — №2: выгрузка не сработала, процесс жив. На старом коде он
// БЫЛ БЫ ЗЕЛЁНЫМ (stop() возвращал true), поэтому он и написан первым по важности: это мутация,
// воспроизводящая жалобу владельца.
//
// Рядом обязательные ПОЛОЖИТЕЛЬНЫЕ БЛИЗНЕЦЫ (№1, №5). Один отрицательный тест не доказывает
// ничего: «отказ есть» одинаково верно и при работающей защите, и при полностью сломанном модуле.
// Различает только пара.
//
// Запуск:
//   node agent/quiet.test.js              — быстрые тесты с подменой, GPU не нужен
//   QUIET_LIVE=1 node agent/quiet.test.js — плюс ЖИВОЙ прогон: реально гасит и поднимает модель
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const results = [];
const check = (name, ok, why) => results.push({ name, ok, why });

// Изолированный дом: флаг тихого режима и служебные файлы адресуются от homedir.
// USERPROFILE обязателен НАРЯДУ с HOME — на Windows os.homedir() читает именно его, и тест,
// подменивший только HOME, молча работал бы с настоящим профилем владельца.
// ФУНКЦИЯ ОБЯЗАНА БЫТЬ async И ДЕЛАТЬ await fn(dir).
// С `try { return fn(dir) } finally {…}` блок finally выполняется в момент ВОЗВРАТА ПРОМИСА, а не
// его завершения: временный дом удалялся, а переменные окружения восстанавливались ПОСРЕДИ теста.
// Тесты с подменой при этом оставались зелёными (им дом не нужен) — то есть харнесс ломал ровно
// тот тест, который единственный работал с настоящей файловой системой. Поймано при первом же
// запуске: ENOENT на удалении флага, который секунду назад записали.
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-test-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  fs.mkdirSync(path.join(dir, '.agent-bus'), { recursive: true });
  try { return await fn(dir); } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function freshServer() {
  try { delete require.cache[require.resolve('./server')]; } catch (_) {}
  return require('./server');
}

(async () => {
  // ── 1. ПОЛОЖИТЕЛЬНЫЙ: процесс умирает не мгновенно — обязаны ДОЖДАТЬСЯ и подтвердить.
  await withTempHome(async () => {
    const server = freshServer();
    let polls = 0;
    const r = await server.stop({
      deps: {
        kill: () => {},                                  // «команда отправлена»
        pids: () => (++polls <= 3 ? [4242] : []),        // умирает лишь к четвёртому опросу
        sleep: () => Promise.resolve(),                  // без реальных пауз
      },
    });
    check('дожидается фактической смерти процесса',
      r.ok === true && r.wasLoaded === true && r.killed.includes(4242) && polls > 1,
      r.ok ? `подтверждено после ${polls} опросов` : `вернул ok=${r.ok}: ${r.why}`);
  });

  // ── 2. ГЛАВНЫЙ. МУТАЦИЯ: taskkill «прошёл», но процесс жив. Жалоба владельца дословно.
  //      На старом коде stop() вернул бы true, и quiet.js напечатал бы «видеопамять освобождена».
  await withTempHome(async () => {
    const server = freshServer();
    const r = await server.stop({
      timeoutMs: 50,
      deps: { kill: () => {}, pids: () => [4242], sleep: () => Promise.resolve() },
    });
    check('процесс выжил → это ПРОВАЛ, а не успех',
      r.ok === false && Array.isArray(r.left) && r.left.includes(4242) && /не умер|taskkill/i.test(r.why || ''),
      r.ok === false ? `честно сообщил: ${r.why}` : 'ВЕРНУЛ УСПЕХ ПРИ ЖИВОМ ПРОЦЕССЕ — та самая регрессия');
  });

  // ── 3. taskkill упал (нет прав / чужая сессия). Причина обязана быть НАЗВАНА, а не проглочена.
  await withTempHome(async () => {
    const server = freshServer();
    const r = await server.stop({
      timeoutMs: 50,
      deps: {
        kill: () => { throw new Error('Access is denied'); },
        pids: () => [777],
        sleep: () => Promise.resolve(),
      },
    });
    check('отказ taskkill назван причиной, а не проглочен',
      r.ok === false && /taskkill/i.test(r.why || '') && /denied/i.test(r.why || ''),
      r.why || 'причина не названа');
  });

  // ── 4. Гасить нечего — это успех, но БЕЗ ложного «выгрузил».
  //      Различие важно: «уже свободно» и «я освободил» — разные утверждения.
  await withTempHome(async () => {
    const server = freshServer();
    let killed = false;
    const r = await server.stop({ deps: { kill: () => { killed = true; }, pids: () => [], sleep: () => Promise.resolve() } });
    check('процесса не было → успех без ложного «выгрузил»',
      r.ok === true && r.wasLoaded === false && !killed,
      r.wasLoaded === false ? (killed ? 'но зря звал taskkill' : 'wasLoaded=false, taskkill не звался') : 'соврал про выгрузку');
  });

  // ── 5. ГЕЙТ + ЕГО ПОЛОЖИТЕЛЬНЫЙ БЛИЗНЕЦ.
  //      Отдельно отказ ничего не значит: он был бы зелёным и если бы ensure() падал ВСЕГДА.
  //      Поэтому проверяем ОБА состояния флага на одном и том же коде.
  await withTempHome(async (dir) => {
    const server = freshServer();
    const flag = path.join(dir, '.agent-bus', 'quiet-mode');

    fs.writeFileSync(flag, 'on');
    let blocked = null;
    try { await server.ensure(); blocked = 'НЕ отказал'; }
    catch (e) { blocked = /ТИХИЙ РЕЖИМ/.test(e.message) ? null : `отказал не по делу: ${e.message.slice(0, 80)}`; }
    check('флаг включён → подъём модели заблокирован', blocked === null, blocked || 'отказ с верной причиной');

    // Близнец: без флага гейт молчит. Модель тут не поднимаем (AUTOSTART=0) — важно лишь то,
    // что отказ ИМЕННО про тихий режим больше не приходит.
    fs.unlinkSync(flag);
    const savedAuto = process.env.LLAMA_AUTOSTART;
    process.env.LLAMA_AUTOSTART = '0';
    const server2 = freshServer();
    let twin = null;
    try { await server2.ensure(); }
    catch (e) { if (/ТИХИЙ РЕЖИМ/.test(e.message)) twin = 'гейт срабатывает БЕЗ флага — отказ безусловный'; }
    if (savedAuto === undefined) delete process.env.LLAMA_AUTOSTART; else process.env.LLAMA_AUTOSTART = savedAuto;
    check('флаг снят → гейт молчит (близнец)', twin === null, twin || 'отказа про тихий режим нет');
  });

  // ── 6. ЖИВОЙ ПРОГОН, по требованию. Гоняем НЕ функцию, а тот самый .cmd, который кликает
  //      владелец: между кнопкой и логикой лежат ярлык, cmd и PATH, и сломаться может любой.
  if (process.env.QUIET_LIVE === '1') {
    const CMD_ON = path.join(os.homedir(), '.local', 'bin', 'quiet-on.cmd');
    const CMD_OFF = path.join(os.homedir(), '.local', 'bin', 'quiet-off.cmd');
    const used = () => {
      try {
        return parseInt(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim(), 10);
      } catch (_) { return NaN; }
    };
    const runCmd = (f) => { try { execFileSync('cmd', ['/c', f, '<', 'nul'], { encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {} };
    // ОБЯЗАТЕЛЬНО свежий модуль: тест-близнец выше грузил server.js с LLAMA_AUTOSTART=0, и этот
    // модуль остался в кэше require. Живой прогон получал бы «модель не отвечает и AUTOSTART=0» —
    // падение не по делу, ровно тот же класс, что pm2 со старым кодом в памяти.
    delete process.env.LLAMA_AUTOSTART;
    const server = freshServer();

    // Предусловие: модель ДОЛЖНА быть загружена, иначе «выгрузка» пройдёт вхолостую и тест
    // окажется зелёным, ничего не проверив. Если поднять не удалось — честный провал, а не крах.
    try { fs.unlinkSync(path.join(os.homedir(), '.agent-bus', 'quiet-mode')); } catch (_) {}
    let ready = true;
    try { if (!(await server.probe(3000))) await server.ensure(); }
    catch (e) { ready = false; check('ЖИВОЙ: модель удалось поднять для проверки', false, e.message.slice(0, 140)); }
    const before = ready ? used() : NaN;
    const pidsBefore = ready ? server.llamaPids() : [];

    if (ready) runCmd(CMD_ON);
    const after = used();
    const pidsAfter = server.llamaPids();
    check('ЖИВОЙ: ярлык «модель ВЫКЛ» убил процесс',
      pidsBefore.length > 0 && pidsAfter.length === 0,
      `процессов было ${pidsBefore.length}, стало ${pidsAfter.length}`);
    check('ЖИВОЙ: видеопамять реально освободилась',
      Number.isFinite(before) && Number.isFinite(after) && before - after > 3000,
      `${before} → ${after} МБ (освободилось ${before - after})`);

    if (ready) runCmd(CMD_OFF);
    check('ЖИВОЙ: ярлык «Модель ВКЛ» вернул модель в память',
      ready && server.llamaPids().length > 0 && used() > 3000,
      `${used()} МБ, процессов ${server.llamaPids().length}`);
  }

  console.log('');
  let bad = 0;
  for (const r of results) { console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}\n      ${r.why}`); if (!r.ok) bad++; }
  console.log('');
  console.log(bad ? `ПРОВАЛ: ${bad} из ${results.length}` : `ВСЁ ЗЕЛЕНО: ${results.length} из ${results.length}`);
  if (process.env.QUIET_LIVE !== '1') console.log('(живой прогон пропущен — QUIET_LIVE=1 чтобы включить)');
  process.exit(bad ? 1 : 0);
})();
