#!/usr/bin/env node
// Многошаговый eval АГЕНТА (не модели): задачи, требующие полной tool-use петли (list→read→рассуждение),
// с проверяемым финальным ответом. Прогон ×RUNS на СТАБИЛЬНОСТЬ (§7: вариативность = часть результата).
//   AGENT_ROOT=~/agent-sandbox RUNS=3 node agent/eval-agent.js [model]
const { runAgent } = require('./loop');
const MODEL = process.argv[2] || require('./loop').DEFAULT_MODEL;
const RUNS = parseInt(process.env.RUNS || '3', 10);
const MAXSTEPS = parseInt(process.env.MAXSTEPS || '8', 10);

// Каждая задача: expect — предикат по нормализованному финальному ответу.
const has = (s) => (ans) => ans.toLowerCase().includes(s.toLowerCase());
const hasAny = (...ss) => (ans) => ss.some((s) => ans.toLowerCase().includes(s.toLowerCase()));
const EASY = [
  { id: 'count-entries', q: 'Сколько всего элементов (файлов и папок) в рабочей папке? Ответь числом.', ok: has('6') },
  { id: 'read-project', q: 'Прочитай notes.txt и назови проект.', ok: has('llm-fleet') },
  { id: 'sum-numbers', q: 'В файле numbers.txt числа по строкам. Назови их сумму числом.', ok: has('100') },
  { id: 'json-field', q: 'Открой config.json и назови значение поля port.', ok: has('11434') },
  { id: 'find-secret', q: "Какой из файлов log1.txt или log2.txt содержит слово 'секрет'? Назови имя файла.", ok: has('log2') },
  { id: 'count-lines', q: 'Сколько строк в файле data/items.txt? Ответь числом.', ok: has('3') },
];
// Жёсткий тир — длиннее цепочки, кросс-файловое рассуждение, обработка ошибок, строгий формат.
const HARD = [
  { id: 'longest-file', q: 'Из файлов numbers.txt, notes.txt и log1.txt — в каком БОЛЬШЕ всего строк? Назови имя файла.', ok: has('numbers') },
  { id: 'average', q: 'Числа в numbers.txt по строкам. Посчитай их среднее арифметическое, ответь числом.', ok: has('25') },
  { id: 'cross-check', q: 'Значение поля port из config.json встречается среди чисел в numbers.txt? Ответь да или нет.', ok: hasAny('нет', ' no', 'не встреч') },
  { id: 'missing-file', q: 'Прочитай файл secret-plan.txt и перескажи его содержимое.', ok: hasAny('не сущест', 'не найд', 'отсутств', 'нет такого', 'no such', 'не удалось') },
  { id: 'strict-format', q: 'Сколько .txt файлов в КОРНЕ рабочей папки (не в подпапках)? Ответь ТОЛЬКО числом, без слов.', ok: (a) => /(^|\D)4(\D|$)/.test(a.trim()) && a.trim().length < 8 },
  { id: 'sum-two-files', q: 'Сколько строк СУММАРНО в файлах log1.txt и log2.txt вместе? Ответь числом.', ok: has('2') },
  { id: 'chain-mult', q: 'Умножь количество строк в data/items.txt на значение поля port из config.json. Ответь числом.', ok: has('34302') },
  { id: 'chain-filter', q: 'В файле numbers.txt в скольких строках число больше 20? Ответь числом.', ok: (a) => /(^|\D)2(\D|$)/.test(a.trim()) },
];
const SET = process.env.SET || 'easy';
const TASKS = SET === 'hard' ? HARD : SET === 'all' ? [...EASY, ...HARD] : EASY;

(async () => {
  console.log(`Agent-eval · model=${MODEL} · runs=${RUNS} · maxSteps=${MAXSTEPS} · root=${process.env.AGENT_ROOT}\n`);
  const stat = {}; TASKS.forEach((t) => (stat[t.id] = { pass: 0, steps: [] }));
  for (let run = 1; run <= RUNS; run++) {
    for (const t of TASKS) {
      let ans = '', steps = 0;
      try { const r = await runAgent(t.q, { model: MODEL, maxSteps: MAXSTEPS }); ans = r.answer || ''; steps = r.steps; }
      catch (e) { ans = 'ERR:' + e.message; }
      const pass = t.ok(ans);
      if (pass) stat[t.id].pass++;
      stat[t.id].steps.push(steps);
      process.stdout.write(`  run${run} ${t.id.padEnd(14)} ${pass ? '✅' : '❌'} (${steps}ш) ${pass ? '' : '→ ' + ans.replace(/\n/g, ' ').slice(0, 70)}\n`);
    }
  }
  console.log('\nЗАДАЧА            PASS   СТАБ   ~шагов');
  let totPass = 0;
  for (const t of TASKS) {
    const s = stat[t.id]; totPass += s.pass;
    const avgSteps = (s.steps.reduce((a, b) => a + b, 0) / s.steps.length).toFixed(1);
    const stable = s.pass === RUNS ? 'стабильно' : s.pass === 0 ? 'провал' : 'флап';
    console.log(`${t.id.padEnd(16)} ${(s.pass + '/' + RUNS).padEnd(6)} ${stable.padEnd(10)} ${avgSteps}`);
  }
  const rate = ((totPass / (TASKS.length * RUNS)) * 100).toFixed(0);
  console.log(`\nИТОГО: ${totPass}/${TASKS.length * RUNS} (${rate}%) · цель = стабильно ≥90%`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
