#!/usr/bin/env node
// ЗАМЕР ВТОРОГО ЯРУСА: правки в РЕАЛЬНЫХ файлах проекта, а не в двухстрочных заглушках.
//
// Зачем отдельно от bench-code.js: первый ярус дал 19/19, но задачи были изолированными функциями
// по 2 строки. Реальная работа — это файл на 200-300 строк, который надо прочитать целиком, понять
// и поправить хирургически, не сломав остальное. Именно это решает, годится ли агент для цикла
// «Claude ставит задачу → агент правит → Claude ревьюит дифф» по-настоящему.
//
// ЧЕСТНОСТЬ ЗАМЕРА:
//   • песочница — СВЕЖАЯ КОПИЯ llm-fleet на каждую задачу (агент не трогает рабочий репозиторий);
//   • критерий — код возврата теста, никакой моей интерпретации;
//   • КОНТРОЛЬ ПЕРЕД: тест обязан падать ДО правки, иначе задача ничего не меряет;
//   • КОНТРОЛЬ ПОСЛЕ: отдельная проверка, что модуль всё ещё грузится и старые экспорты целы —
//     ловит «починил ценой поломки соседнего», чего первый ярус увидеть не мог.
//
// Запуск: node agent/bench-code-real.js [--only <id>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(os.homedir(), 'llm-fleet');
const WORK = path.join(os.homedir(), 'agent-bench', 'real');
const RESULTS = path.join(__dirname, 'bench-results', 'code-real.json');
const log = (m) => console.log(`${new Date().toISOString()} [bench-real] ${m}`);

// Задачи на НАСТОЯЩИХ файлах. Каждая — то, что реально просят в повседневной работе.
// `check` выполняется в песочнице: бросил исключение → провал.
const TASKS = [
  {
    id: 'budget-tokensLeft', scope: [], file: 'agent/budget.js',
    task: 'В файле agent/budget.js добавь и экспортируй функцию tokensLeft(messages, budgetTokens): она возвращает, сколько токенов ещё влезает — то есть budgetTokens минус оценка занятого. Если уже превышено, вернуть 0. Существующие экспорты не трогай.',
    check: `const b = require('./agent/budget.js');
      if (typeof b.tokensLeft !== 'function') throw new Error('нет экспорта tokensLeft');
      const m = [{role:'user',content:'привет'}];
      const left = b.tokensLeft(m, 1000);
      if (typeof left !== 'number') throw new Error('вернул не число');
      if (left <= 0 || left >= 1000) throw new Error('неверное значение: ' + left);
      if (b.tokensLeft([{role:'user',content:'x'.repeat(50000)}], 10) !== 0) throw new Error('при превышении должен быть 0');
      if (typeof b.compact !== 'function' || typeof b.estimateTokens !== 'function') throw new Error('сломаны старые экспорты');`,
  },
  {
    id: 'budget-env-coeff', scope: ['CHARS_PER_TOKEN'], file: 'agent/budget.js',
    task: 'В agent/budget.js сделай коэффициент CHARS_PER_TOKEN настраиваемым через переменную окружения AGENT_CHARS_PER_TOKEN (если она задана и это положительное число — берём её, иначе прежнее значение). Остальное не меняй.',
    check: `delete require.cache[require.resolve('./agent/budget.js')];
      process.env.AGENT_CHARS_PER_TOKEN = '5';
      const b = require('./agent/budget.js');
      if (b.CHARS_PER_TOKEN !== 5) throw new Error('env не применилась: ' + b.CHARS_PER_TOKEN);
      if (typeof b.compact !== 'function') throw new Error('сломан экспорт compact');`,
  },
  {
    id: 'tools-word-count', scope: [], file: 'agent/tools.js',
    task: 'В agent/tools.js добавь новый БЕЗОПАСНЫЙ инструмент word_count: принимает { file } — путь к файлу относительно рабочей папки — и возвращает количество слов в нём (слова разделены любыми пробельными символами). Оформи его так же, как соседние инструменты в REGISTRY (safe, schema, description, run).',
    check: `const t = require('./agent/tools.js');
      if (!t.REGISTRY.word_count) throw new Error('инструмент не зарегистрирован');
      if (t.REGISTRY.word_count.safe !== true) throw new Error('должен быть safe');
      if (!t.schemas().some(s => s.function.name === 'word_count')) throw new Error('нет в схемах');
      if (!t.REGISTRY.read_file || !t.REGISTRY.calc) throw new Error('сломаны соседние инструменты');`,
  },
  {
    id: 'server-port-env', scope: ['PORT', 'module.exports'], file: 'agent/server.js',
    task: 'В agent/server.js порт llama-server сейчас берётся из переменной PORT. Убедись, что его можно переопределить переменной окружения LLAMA_PORT, и экспортируй текущее значение порта как PORT из модуля. Логику запуска не меняй.',
    check: `delete require.cache[require.resolve('./agent/server.js')];
      process.env.LLAMA_PORT = '9123';
      const s = require('./agent/server.js');
      if (String(s.PORT) !== '9123') throw new Error('LLAMA_PORT не применилась: ' + s.PORT);
      if (typeof s.ensure !== 'function') throw new Error('сломан экспорт ensure');`,
  },
  {
    id: 'escalate-silent', scope: ['fatal', 'notify', 'escalate('], file: 'agent/escalate.js',
    task: 'В agent/escalate.js у функции escalate третий аргумент — объект опций. Добавь опцию silent: при silent:true копия в Telegram НЕ отправляется, а сообщение в шину уходит как обычно. Поведение по умолчанию не меняй.',
    check: `const src = require('fs').readFileSync('./agent/escalate.js','utf8');
      if (!/silent/.test(src)) throw new Error('опция silent не появилась в коде');
      const e = require('./agent/escalate.js');
      if (typeof e.escalate !== 'function') throw new Error('сломан экспорт escalate');
      const fn = e.escalate.toString();
      if (!/silent/.test(fn)) throw new Error('silent не используется внутри escalate');`,
  },
  {
    id: 'bus-send-json', scope: ['process.argv', 'console.log', 'const to', 'const text'], file: 'mcp/bus-send.js',
    task: 'В mcp/bus-send.js добавь поддержку флага --json: если он есть среди аргументов, скрипт печатает результат в виде JSON (например {"ok":true,"to":"...","signed":true}) вместо человекочитаемой строки. Флаг не должен попадать в текст сообщения.',
    check: `const src = require('fs').readFileSync('./mcp/bus-send.js','utf8');
      if (!/--json|'json'|"json"/.test(src)) throw new Error('флаг --json не добавлен');
      if (!/JSON\\.stringify/.test(src)) throw new Error('нет вывода JSON');
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, ['--check', './mcp/bus-send.js']);`,
  },
  {
    id: 'loop-export-maxtokens', scope: ['module.exports'], file: 'agent/loop.js',
    task: 'В agent/loop.js значение MAX_TOKENS сейчас внутреннее. Экспортируй его из модуля, не меняя остальных экспортов и логики.',
    check: `const l = require('./agent/loop.js');
      if (typeof l.MAX_TOKENS !== 'number') throw new Error('MAX_TOKENS не экспортирован');
      if (typeof l.converse !== 'function' || typeof l.buildSystemPrompt !== 'function') throw new Error('сломаны старые экспорты');`,
  },
  {
    id: 'budget-guard-negative', scope: ['function compact', 'budgetTokens'], file: 'agent/budget.js',
    task: 'В agent/budget.js функция compact при отрицательном или нулевом budgetTokens ведёт себя странно. Сделай так, чтобы при budgetTokens <= 0 она возвращала только системное сообщение (первый элемент), а не пустой массив и не всю историю.',
    check: `const b = require('./agent/budget.js');
      const sys = {role:'system',content:'системный'};
      const msgs = [sys, {role:'user',content:'раз'}, {role:'assistant',content:'два'}];
      const r = b.compact(msgs, { budgetTokens: 0 });
      if (!Array.isArray(r)) throw new Error('вернул не массив');
      if (r.length !== 1) throw new Error('должно остаться ровно одно сообщение, вернулось ' + r.length);
      if (r[0] !== sys) throw new Error('уцелеть должно системное сообщение');`,
  },
];

// Свежая копия репозитория на задачу. Копируем только исходники — без node_modules и .git,
// иначе каждая задача тащила бы сотни мегабайт и замер превратился бы в тест диска.
function prepare(id) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['agent', 'mcp', 'src']) {
    const from = path.join(REPO, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  for (const f of ['package.json']) {
    if (fs.existsSync(path.join(REPO, f))) fs.cpSync(path.join(REPO, f), path.join(dir, f));
  }
  // node_modules — симлинком на настоящие: зависимости нужны, копировать их 300 МБ на задачу нельзя.
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch (_) {}
  return dir;
}

// Проверка = запуск check-скрипта отдельным процессом в песочнице. Отдельным — потому что правка
// может сломать модуль так, что упадёт весь замер; изоляция обязательна.
function runCheck(dir, check) {
  const f = path.join(dir, '__check.js');
  fs.writeFileSync(f, `(async()=>{ try { ${check} ; console.log('CHECK_OK'); } catch(e){ console.error('CHECK_FAIL: '+e.message); process.exit(1);} })();`);
  try {
    const out = execFileSync(process.execPath, ['__check.js'], { cwd: dir, timeout: 30000, encoding: 'utf8', stdio: 'pipe' });
    return { ok: /CHECK_OK/.test(out), note: '' };
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '')).split('\n').find((l) => /CHECK_FAIL|Error/.test(l)) || 'упал';
    return { ok: false, note: msg.slice(0, 120) };
  }
}

(async () => {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const base = only ? TASKS.filter((t) => t.id === only) : TASKS;
  // ПОВТОРЫ — не роскошь, а условие достоверности. Одиночные прогоны дали 6/8 и 5/8 на одной и той же
  // конфигурации: разброс между запусками больше эффекта правок, и сравнивать их бессмысленно.
  // Владельцу нужен результат ПОСТОЯННО — значит меряем устойчивость каждой задачи, а не разовый успех.
  const REPEATS = parseInt(process.env.BENCH_REPEATS || '1', 10);
  const list = [];
  for (let r = 1; r <= REPEATS; r++) for (const t of base) list.push({ ...t, _run: r, _key: t.id, id: REPEATS > 1 ? `${t.id}#${r}` : t.id });
  fs.mkdirSync(WORK, { recursive: true });
  log(`задач: ${base.length} × прогонов: ${REPEATS} = ${list.length} · песочница ${WORK}`);

  const rows = [];
  for (const t of list) {
    const dir = prepare(t.id);
    const before = runCheck(dir, t.check);
    if (before.ok) { log(`⚠ ${t.id}: проверка проходит ДО правки — задача негодная`); rows.push({ id: t.id, skipped: true }); continue; }

    const origText = fs.readFileSync(path.join(dir, t.file), 'utf8');
    const origSize = Buffer.byteLength(origText);
    const origLines = origText.split('\n').length;

    process.env.AGENT_ROOT = dir;
    process.env.AGENT_ALLOW_RISKY = '1';
    process.env.AGENT_SUPERVISOR = 'allow';    // замер идёт в песочнице; надзор меряем отдельно
    for (const m of ['./tools', './loop']) delete require.cache[require.resolve(m)];
    const { converse, buildSystemPrompt } = require('./loop');

    // ПОСТАНОВКА ЗАДАЧИ — переменная замера. MODE=write (перезапись файла целиком) дала 0/8 годных
    // диффов: агент перепечатывал 100-300 строк и портил посторонние. MODE=edit даёт хирургический
    // edit_file, где порча вне правки невозможна физически. Сравниваем ровно эти две постановки.
    const MODE = process.env.BENCH_EDIT_MODE || 'edit';
    const how = MODE === 'write'
      ? 'потом запиши изменённую версию через write_file — ПОЛНЫМ текстом файла, а не фрагментом.'
      : 'потом внеси правку через edit_file: передай в old_string ТОЧНЫЙ фрагмент из файла (копируй '
        + 'посимвольно, вместе с отступами), в new_string — чем его заменить. Меняй ТОЛЬКО то, что нужно '
        + 'по задаче; можешь вызвать edit_file несколько раз. write_file для этой задачи НЕ используй.';
    const prompt = `В рабочей папке лежит проект. Задача: ${t.task}\n`
      + `Файл для правки: ${t.file} (${origLines} строк). Сначала прочитай его целиком через read_file, `
      + how + ` Ничего другого не меняй. В конце одной строкой скажи, что сделал.`;

    const t0 = Date.now();
    let calls = 0, err = null;
    try {
      await converse([{ role: 'system', content: buildSystemPrompt() }], prompt,
        { maxSteps: 10, onEvent: (e) => { if (e.type === 'call') calls++; } });
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;

    const after = runCheck(dir, t.check);
    const newText = fs.readFileSync(path.join(dir, t.file), 'utf8');
    const shrunk = Buffer.byteLength(newText) < origSize * 0.7;   // «переписал короче» = вероятно выкинул код

    // 🔴 СОПУТСТВУЮЩИЙ УЩЕРБ — главная метрика этого яруса. Первый прогон дал 1/1 «успех», хотя агент
    // МОЛЧА испортил постороннюю строку: /\/v1\/?$/ превратилось в /\\v1\/?$/ (экранированный слеш стал
    // литеральным бэкслешем). Проверка этого не видела — она смотрела только на заказанную функцию.
    // Считаем строки исходника, ИСЧЕЗНУВШИЕ из результата: при задаче «добавь X» их должно быть 0
    // (кроме строки экспортов, которую менять и просили). Именно так ловится «починил ценой поломки».
    // ⚠️ ОБЛАСТЬ ЗАДАЧИ (t.scope) обязательна. Без неё детектор считал порчей САМУ ПРАВКУ: задача
    // «сделай CHARS_PER_TOKEN настраиваемым» требует изменить строку с CHARS_PER_TOKEN, а метрика
    // объявляла это ущербом. Дважды получил заниженный результат (4/8 вместо 6/8), пока не сверил
    // диффы глазами. Порча = изменённая строка ВНЕ области задачи.
    const newSet = new Set(newText.split('\n').map((s) => s.trimEnd()));
    const scope = t.scope || [];
    const lost = origText.split('\n').map((s) => s.trimEnd())
      .filter((s) => s.trim() && !newSet.has(s) && !/module\.exports/.test(s))
      .filter((s) => !scope.some((k) => s.includes(k)));
    rows.push({ id: t.id, file: t.file, lines: origLines, ok: after.ok, note: after.note, calls,
      sec: +(ms / 1000).toFixed(1), shrunk, collateral: lost.length, lostSample: lost.slice(0, 2), err });
    // Пишем результат ПОСЛЕ КАЖДОЙ задачи, а не в конце: прогон на 24 задачи идёт полчаса и уже был
    // оборван — при записи только в конце все данные терялись бы целиком.
    try {
      fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
      fs.writeFileSync(RESULTS + '.partial', JSON.stringify(rows, null, 2));
    } catch (_) {}

    const clean = after.ok && lost.length === 0;
    log(`${clean ? '✅' : after.ok ? '⚠️' : '❌'} ${t.id} (${origLines} строк) · ${(ms / 1000).toFixed(1)}с · тулз ${calls}`
      + `${lost.length ? ` · 🔴 ИСПОРЧЕНО ЧУЖИХ СТРОК: ${lost.length}` : ''}`
      + `${shrunk ? ' · ФАЙЛ УСОХ' : ''}${after.ok ? '' : ' · ' + after.note}`);
    if (lost.length) lost.slice(0, 2).forEach((l) => log(`      было: ${l.trim().slice(0, 100)}`));
  }

  const done = rows.filter((r) => !r.skipped);
  const pass = done.filter((r) => r.ok).length;
  const clean = done.filter((r) => r.ok && !r.collateral).length;   // ГОДНЫЙ ДИФФ = задача решена И ничего не сломано
  const out = { pass, clean, total: done.length,
    pct: done.length ? Math.round(pass / done.length * 100) : 0,
    pctClean: done.length ? Math.round(clean / done.length * 100) : 0,
    withCollateral: done.filter((r) => r.collateral).length,
    avgSec: +(done.reduce((s, r) => s + r.sec, 0) / (done.length || 1)).toFixed(1), rows };
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  log(`ИТОГ: задача решена ${pass}/${done.length} · ГОДНЫХ ДИФФОВ (без порчи чужого) ${clean}/${done.length} (${out.pctClean}%)`);
  log(`      диффов с сопутствующим ущербом: ${out.withCollateral} · среднее ${out.avgSec}с/задача`);

  // УСТОЙЧИВОСТЬ — главный вопрос владельца («выдавать хороший результат ПОСТОЯННО»).
  // Задача, которая проходит через раз, для автоматического цикла бесполезна: на неё нельзя положиться.
  const byTask = {};
  for (const r of done) { (byTask[r._key || r.id] = byTask[r._key || r.id] || []).push(r.ok && !r.collateral); }
  const keys = Object.keys(byTask);
  if (keys.some((k) => byTask[k].length > 1)) {
    log('');
    log('УСТОЙЧИВОСТЬ по задачам (годный дифф в каждом прогоне):');
    let stable = 0, flaky = 0, never = 0;
    for (const k of keys) {
      const v = byTask[k], good = v.filter(Boolean).length;
      const mark = good === v.length ? '✅ всегда' : good === 0 ? '❌ никогда' : '🔀 ПЛАВАЕТ';
      if (good === v.length) stable++; else if (good === 0) never++; else flaky++;
      log(`  ${k.padEnd(24)} ${good}/${v.length}  ${mark}`);
    }
    log(`ВЫВОД: стабильно годных ${stable}/${keys.length} · плавающих ${flaky} · всегда провальных ${never}`);
    out.stability = { stable, flaky, never, total: keys.length };
    fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  }
})();
