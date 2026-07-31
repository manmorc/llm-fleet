#!/usr/bin/env node
// ПРОВЕРКА ГИПОТЕЗЫ О ДЕКОМПОЗИЦИИ.
//
// Замер 31.07-01.08.2026 показал: локальный агент НАДЁЖЕН на правках в ОДНОМ месте (5 задач из 8 —
// 100% в каждом прогоне, включая файл на 220 строк) и НЕ СПРАВЛЯЕТСЯ, когда правку надо согласовать
// в НЕСКОЛЬКИХ местах (escalate-silent 0/2, tools-word-count 0/2). Размер файла ни при чём:
// 220 строк — всегда, 63 строки — никогда.
//
// Гипотеза: дело не в сложности задачи, а в ЧИСЛЕ ТОЧЕК правки. Если так, то задача, которая
// не проходит НИКОГДА целиком, должна проходить НАДЁЖНО, будучи разрезанной на атомы.
// Это проверяемо, и от ответа зависит вся схема работы: «агент делает фичу» против
// «Claude режет фичу на атомы, агент их исполняет».
//
// Берём escalate-silent — она провалилась во ВСЕХ прогонах и целиком, и после всех фиксов.
// Режем на два шага, каждый — правка в одном месте. Прогоняем N раз. Критерий — ТОТ ЖЕ,
// что у неудачной цельной задачи, иначе сравнение нечестное.
//
// Запуск: node agent/bench-decompose.js [--runs 3]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(os.homedir(), 'llm-fleet');
const WORK = path.join(os.homedir(), 'agent-bench', 'decompose');
// ДВА случая из класса «целиком не проходит НИКОГДА» (оба 0/2 в bench-code-real.js).
// Проверяем на обоих: правило, подтверждённое одним примером, — это совпадение.
// Второй случай проверяет уточнённую гипотезу: важна не только МНОЖЕСТВЕННОСТЬ точек правки,
// но и ОБЪЁМ одной правки. tools-word-count — это ОДНА вставка, но крупная (целый инструмент
// со схемой и телом) в файл на 365 строк; делим её на «вставить заготовку» + «наполнить телом».
const CASES = {
  'escalate-silent': {
    file: 'agent/escalate.js',
    steps: [
      'В файле agent/escalate.js у функции escalate третий аргумент — объект опций вида { fatal = false } = {}. '
      + 'Добавь в эту деструктуризацию ещё один параметр: silent = false. Больше НИЧЕГО не меняй.',
      'В файле agent/escalate.js найди блок, который отправляет копию в Telegram (он вызывает require(\'./notify\') '
      + 'и notify({...})). Оберни ВЕСЬ этот блок условием: выполнять его только если параметр silent НЕ установлен '
      + '(if (!silent) { ... }). Параметр silent уже объявлен в сигнатуре функции. Больше НИЧЕГО не меняй.',
    ],
    check: `const src = require('fs').readFileSync('./agent/escalate.js','utf8');
      if (!/silent/.test(src)) throw new Error('опция silent не появилась в коде');
      const e = require('./agent/escalate.js');
      if (typeof e.escalate !== 'function') throw new Error('сломан экспорт escalate');
      if (!/silent/.test(e.escalate.toString())) throw new Error('silent не используется внутри escalate');`,
    scope: ['fatal', 'notify', 'escalate(', 'silent'],
  },
  'tools-word-count': {
    file: 'agent/tools.js',
    steps: [
      'В файле agent/tools.js в объекте REGISTRY найди инструмент count_lines. Сразу ПОСЛЕ его закрывающей '
      + 'скобки добавь новый инструмент word_count ровно такой заготовкой (скопируй дословно):\n'
      + '  word_count: {\n'
      + '    safe: true,\n'
      + '    schema: { type: \'object\', properties: { file: { type: \'string\' } }, required: [\'file\'] },\n'
      + '    description: \'Количество слов в файле\',\n'
      + '    run: async ({ file }) => 0,\n'
      + '  },\n'
      + 'Больше НИЧЕГО не меняй.',
      'В файле agent/tools.js у инструмента word_count замени тело функции run на настоящий подсчёт: '
      + 'прочитать файл через fs.readFileSync(safePath(file), \'utf8\') и вернуть количество слов, '
      + 'разделённых любыми пробельными символами. Больше НИЧЕГО не меняй.',
    ],
    check: `const t = require('./agent/tools.js');
      if (!t.REGISTRY.word_count) throw new Error('инструмент не зарегистрирован');
      if (t.REGISTRY.word_count.safe !== true) throw new Error('должен быть safe');
      if (!t.schemas().some(s => s.function.name === 'word_count')) throw new Error('нет в схемах');
      if (!t.REGISTRY.read_file || !t.REGISTRY.calc) throw new Error('сломаны соседние инструменты');
      const fs2 = require('fs'); fs2.writeFileSync('./__wc.txt', 'раз два три\\nчетыре  пять');
      const n = await t.REGISTRY.word_count.run({ file: '__wc.txt' });
      if (Number(n) !== 5) throw new Error('неверный подсчёт слов: ' + n);`,
    scope: [],
  },
  // ТРЕТИЙ СЛУЧАЙ — уточнённая гипотеза после опровержения второй.
  // tools-word-count провалился 0/3 ДАЖЕ разрезанный на атомы, то есть дело НЕ в числе точек правки.
  // Разбор прогона 1 показал, что именно ломается: агент вставлял блок внутрь объекта REGISTRY и
  // СЪЕДАЛ закрывающую скобку соседнего инструмента — `},` от count_lines исчезла, скобки
  // разбалансировались, файл упал с SyntaxError в самом конце. При этом ТЕЛО функции он написал
  // верно: читает файл, режет по \s+, возвращает число. Логика правильная — сломалась СТРУКТУРА.
  // Гипотеза: ненадёжна не правка вообще, а вставка блока во ВЛОЖЕННУЮ структуру, где надо удержать
  // баланс скобок. Тот же инструмент ОТДЕЛЬНЫМ ФАЙЛОМ (плоский модуль, вложенности нет) должен
  // проходить. Если так — это и есть архитектурный вывод: расширять агента новыми файлами-скилами
  // (agent/skills/, см. skills-loader.js), а не врезками в общий реестр.
  'word-count-as-skill': {
    file: 'agent/skills/word_count.js',
    fresh: true,                       // файла нет — агент создаёт его с нуля
    steps: [
      'Создай новый файл agent/skills/word_count.js через write_file. Это самостоятельный модуль-скил. '
      + 'Содержимое ровно такое:\n'
      + "module.exports = {\n"
      + "  name: 'word_count',\n"
      + "  description: 'Количество слов в файле',\n"
      + "  safe: true,\n"
      + "  schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },\n"
      + "  run: async ({ file }) => 0,\n"
      + "};\n"
      + 'Больше ничего не создавай и не меняй.',
      'В файле agent/skills/word_count.js замени тело функции run на настоящий подсчёт: прочитать файл '
      + "через require('fs').readFileSync(file, 'utf8') и вернуть количество слов, разделённых любыми "
      + 'пробельными символами. Используй edit_file. Больше ничего не меняй.',
    ],
    check: `const s = require('./agent/skills/word_count.js');
      if (!s || s.name !== 'word_count') throw new Error('модуль не отдаёт name');
      if (s.safe !== true) throw new Error('должен быть safe');
      if (typeof s.run !== 'function') throw new Error('нет run()');
      const fs2 = require('fs'); fs2.writeFileSync('./__wc.txt', 'раз два три\\nчетыре  пять');
      const n = await s.run({ file: './__wc.txt' });
      if (Number(n) !== 5) throw new Error('неверный подсчёт слов: ' + n);
      const t = require('./agent/tools.js');
      if (!t.REGISTRY.read_file || !t.REGISTRY.calc) throw new Error('сломаны встроенные инструменты');`,
    scope: [],
  },
  // ЧЕТВЁРТЫЙ СЛУЧАЙ — предельно надёжная конфигурация, к которой привели три предыдущих замера.
  // Итог наблюдений: агент ломается на ДВУХ вещах — (1) удержание баланса скобок при вставке во
  // вложенную структуру (0/3 врезкой в REGISTRY), (2) дословное воспроизведение литерала
  // (2/3 отдельным файлом: единственный провал — не создал файл на шаге «скопируй такой текст»).
  // Логику при этом он пишет ВЕРНО даже там, где всё остальное сломал.
  // Отсюда разделение труда: СКЕЛЕТ создаёт Claude (структура + точный текст), АГЕНТ пишет ТЕЛО
  // (одна правка, плоский файл, ничего копировать не надо). Проверяем, даёт ли это 3/3.
  'skeleton-then-logic': {
    file: 'agent/skills/word_count.js',
    fresh: true,
    // Скелет кладёт САМ ЗАМЕР — эмулируя то, что в работе сделает Claude.
    seed: "module.exports = {\n"
      + "  name: 'word_count',\n"
      + "  description: 'Количество слов в файле',\n"
      + "  safe: true,\n"
      + "  schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },\n"
      + "  run: async ({ file }) => {\n"
      + "    return 0; // TODO: посчитать слова\n"
      + "  },\n"
      + "};\n",
    steps: [
      'В файле agent/skills/word_count.js внутри функции run замени строку "return 0; // TODO: посчитать слова" '
      + "на настоящий подсчёт: прочитать файл через require('fs').readFileSync(file, 'utf8') и вернуть "
      + 'количество слов, разделённых любыми пробельными символами. Используй edit_file. Больше ничего не меняй.',
    ],
    check: `const s = require('./agent/skills/word_count.js');
      if (typeof s.run !== 'function') throw new Error('нет run()');
      if (s.name !== 'word_count' || s.safe !== true) throw new Error('скелет повреждён');
      const fs2 = require('fs'); fs2.writeFileSync('./__wc.txt', 'раз два три\\nчетыре  пять');
      const n = await s.run({ file: './__wc.txt' });
      if (Number(n) !== 5) throw new Error('неверный подсчёт слов: ' + n);`,
    scope: ['return 0'],
  },
};

const PICK = process.argv.find((a) => CASES[a]) || 'escalate-silent';
const C = CASES[PICK];
const FILE = C.file;
const log = (m) => console.log(`${new Date().toISOString()} [decompose] ${m}`);

// Атомы и критерий берём из выбранного случая. Критерий — ТОТ ЖЕ, что у цельной задачи
// в bench-code-real.js, иначе сравнение «целиком против по частям» было бы нечестным.
const STEPS = C.steps;
const CHECK = C.check;

function prepare(tag) {
  const dir = path.join(WORK, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['agent', 'mcp', 'src']) {
    const from = path.join(REPO, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch (_) {}
  // Скелет — то, что в реальной работе пишет Claude: структура и точный текст. Агенту остаётся логика.
  if (C.seed) {
    const p = path.join(dir, C.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, C.seed);
  }
  return dir;
}

function runCheck(dir) {
  const f = path.join(dir, '__check.js');
  fs.writeFileSync(f, `(async()=>{ try { ${CHECK} ; console.log('CHECK_OK'); } catch(e){ console.error('CHECK_FAIL: '+e.message); process.exit(1);} })();`);
  try {
    const out = execFileSync(process.execPath, ['__check.js'], { cwd: dir, timeout: 30000, encoding: 'utf8', stdio: 'pipe' });
    return { ok: /CHECK_OK/.test(out), note: '' };
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '')).split('\n').find((l) => /CHECK_FAIL/.test(l)) || 'упал';
    return { ok: false, note: msg.slice(0, 100) };
  }
}

(async () => {
  const RUNS = parseInt(process.env.RUNS || (process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : '3'), 10);
  fs.mkdirSync(WORK, { recursive: true });
  log(`случай: ${PICK} · гипотеза: задача, проваленная целиком (0/2), пройдёт после разреза на атомы`);
  log(`прогонов: ${RUNS} · критерий тот же, что у цельной задачи`);

  const origText = C.fresh ? '' : fs.readFileSync(path.join(REPO, FILE), 'utf8');
  const results = [];

  for (let run = 1; run <= RUNS; run++) {
    const dir = prepare(`run${run}`);
    const before = runCheck(dir);
    if (before.ok) { log(`⚠ прогон ${run}: проверка зелёная ДО правки — замер негодный`); continue; }

    process.env.AGENT_ROOT = dir;
    process.env.AGENT_ALLOW_RISKY = '1';
    process.env.AGENT_SUPERVISOR = 'allow';
    for (const m of ['./tools', './loop']) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
    const { converse, buildSystemPrompt } = require('./loop');

    const t0 = Date.now();
    let calls = 0, failedStep = null;
    for (let i = 0; i < STEPS.length; i++) {
      const prompt = `В рабочей папке лежит проект. Задача: ${STEPS[i]}\n`
        + `Сначала прочитай ${FILE} через read_file, потом внеси правку через edit_file: в old_string ТОЧНЫЙ `
        + `фрагмент из файла (посимвольно, с отступами), в new_string — чем заменить. write_file не используй. `
        + `В конце одной строкой скажи, что сделал.`;
      try {
        await converse([{ role: 'system', content: buildSystemPrompt() }], prompt,
          { maxSteps: 8, onEvent: (e) => { if (e.type === 'call') calls++; } });
      } catch (e) { failedStep = `шаг ${i + 1}: ${e.message.slice(0, 60)}`; break; }
    }
    const sec = +((Date.now() - t0) / 1000).toFixed(1);

    const after = runCheck(dir);
    // Сопутствующий ущерб: строки исходника, исчезнувшие вне области задачи.
    const scope = C.scope || [];
    // Файла может не быть вовсе: для случая fresh:true агент создаёт его сам и может не справиться.
    // Читать безусловно — значит уронить весь замер вместо того, чтобы записать честный провал.
    const curText = fs.existsSync(path.join(dir, FILE)) ? fs.readFileSync(path.join(dir, FILE), 'utf8') : '';
    const newSet = new Set(curText.split('\n').map((s) => s.trimEnd()));
    const damage = origText.split('\n').map((s) => s.trimEnd())
      .filter((s) => s.trim() && !newSet.has(s) && !/module\.exports/.test(s))
      .filter((s) => !scope.some((k) => s.includes(k)));

    const good = after.ok && damage.length === 0;
    results.push(good);
    log(`${good ? '✅' : '❌'} прогон ${run} · ${sec}с · тулз ${calls}${damage.length ? ` · 🔴 порча ${damage.length}` : ''}${after.ok ? '' : ' · ' + after.note}${failedStep ? ' · ' + failedStep : ''}`);
  }

  const good = results.filter(Boolean).length;
  log('');
  log(`ИТОГ: ${good}/${results.length} годных`);
  log(`СРАВНЕНИЕ: та же задача ЦЕЛИКОМ давала 0/2 (проваливалась всегда, при любых фиксах)`);
  log(good === results.length && results.length > 0
    ? '✅ ГИПОТЕЗА ПОДТВЕРЖДЕНА: декомпозиция переводит задачу из «никогда» в «всегда»'
    : good > 0 ? '⚠️ частично: декомпозиция помогает, но надёжности не даёт'
      : '❌ ГИПОТЕЗА ОПРОВЕРГНУТА: дело не в числе точек правки');
})();
