// ТЕСТ ОТСТАВАНИЯ ПОТРЕБИТЕЛЯ (queueLag из bus-watch-health.js).
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ПРОВЕРКА. Остальные проверки здоровья шины смотрят на ФАЙЛ ЛОГА, и у них общее
// слепое пятно: если персистер мёртв, сообщения копятся в Redis, а лог просто перестаёт расти.
// «Тихий эфир» и «забирать некому» выглядят снаружи ОДИНАКОВО — а это противоположные состояния.
// Различает их только длина входящей очереди.
//
// Цена ошибки здесь выше обычной: чтение у нас разрушающее (BLPOP). Пока сообщения лежат в
// очереди — их ещё можно спасти; после того как их заберут и уронят — уже нет.
//
// Клиент подставной. Настоящий Redis в тесте не нужен и вреден: проверяем ЛОГИКУ, а тест,
// зависящий от живого сервиса, будет зелёным или красным по чужим причинам.
//
// Запуск: node mcp/bus-lag.test.js
const { queueLag } = require('./bus-watch-health.js');

const out = [];
const check = (n, ok, why) => out.push({ n, ok, why });
const NOW = 1000000000;

(async () => {
  // ── ГЛАВНЫЙ: в очереди лежат непрочитанные. Обязан быть провал, с числом и возрастом.
  {
    const fake = {
      llen: async () => 7,
      lindex: async () => JSON.stringify({ ts: NOW - 25 * 60000, from: 'linux-prestige' }),
    };
    const r = await queueLag(fake, 'nodeA', NOW);
    check('7 незабранных → тревога с числом и возрастом',
      r.depth === 7 && r.oldestMin === 25 && /7 НЕЗАБРАННЫХ/.test(r.problem || '') && /25 мин/.test(r.problem || ''),
      r.problem ? r.problem.slice(0, 100) : 'проблема не названа');
    check('в подсказке названо, ЧТО именно перезапускать',
      /pm2 restart agent-bus-nodeA/.test(r.problem || ''),
      'команда с подставленным id узла');
  }

  // ── ПОЛОЖИТЕЛЬНЫЙ БЛИЗНЕЦ. Без него главный тест был бы зелёным и у функции, которая ругается
  //    ВСЕГДА — то есть не отличал бы работающую проверку от сломанной.
  {
    let lindexCalled = false;
    const fake = { llen: async () => 0, lindex: async () => { lindexCalled = true; return null; } };
    const r = await queueLag(fake, 'nodeA', NOW);
    check('очередь пуста → тревоги нет (близнец)',
      r.depth === 0 && r.problem === null && !lindexCalled,
      r.problem === null ? 'тихо, и лишнего запроса к Redis не делает' : 'ЛОЖНАЯ ТРЕВОГА');
  }

  // ── Битая запись не должна ронять проверку: возраст неизвестен, но тревога обязана остаться.
  //    Проглотить тревогу из-за неразобравшегося JSON — ровно тот отказ, против которого всё это.
  {
    const fake = { llen: async () => 2, lindex: async () => 'не-JSON' };
    const r = await queueLag(fake, 'nodeA', NOW);
    check('битая запись → тревога остаётся, возраст просто неизвестен',
      r.depth === 2 && r.oldestMin === null && /2 НЕЗАБРАННЫХ/.test(r.problem || ''),
      r.depth === 2 && r.problem ? 'не упала и не замолчала' : 'проглотила');
  }

  // ── Одно сообщение — тоже отставание. Порога «ну одно не страшно» быть не должно: одно
  //    непрочитанное письмо от соседней машины уже стоило нам полутора суток молчания.
  {
    const fake = { llen: async () => 1, lindex: async () => JSON.stringify({ ts: NOW - 60000 }) };
    const r = await queueLag(fake, 'nodeA', NOW);
    check('одно незабранное — уже тревога, порога нет', r.depth === 1 && !!r.problem,
      r.problem ? 'сработала на одном' : 'промолчала на одном');
  }

  console.log('');
  let bad = 0;
  for (const r of out) { console.log(`  ${r.ok ? '✓' : '✗'} ${r.n}\n      ${r.why}`); if (!r.ok) bad++; }
  console.log('');
  console.log(bad ? `ПРОВАЛ: ${bad} из ${out.length}` : `ВСЁ ЗЕЛЕНО: ${out.length} из ${out.length}`);
  process.exit(bad ? 1 : 0);
})();
