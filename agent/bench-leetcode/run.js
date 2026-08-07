// ЗАМЕР: «локальная модель плохо кодит — это модель или харнес?»
//
// ВОПРОС РЕШАЕТСЯ ТОЛЬКО СРАВНЕНИЕМ. Одна цифра «решила 2 из 9» не отвечает ни на что: она
// одинаково согласуется и со слабой моделью, и с хорошей моделью в плохой обвязке. Поэтому одни и
// те же задачи прогоняются ДВУМЯ путями:
//
//   ГОЛАЯ МОДЕЛЬ — один вызов, минимальный промпт, никаких инструментов и системной роли.
//                  Это потолок способностей самой модели.
//   ЧЕРЕЗ ХАРНЕС — агентская петля: системный промпт, каталог инструментов, tool-use, шаги,
//                  возможность запустить node и自 проверить себя.
//
// Разница между путями И ЕСТЬ вклад харнеса. Хуже через харнес — виноват харнес; одинаково плохо —
// виновата модель; лучше через харнес — обвязка полезна.
//
// ПРОГОНОВ НЕСКОЛЬКО. Один прогон на задачу — это шум: у модели ненулевая температура, и
// «3 из 3 против 2 из 3» между путями не значит ничего. Меряем долю.
//
// НАДЗОР В ЗАМЕРЕ ОТКЛЮЧЁН СОЗНАТЕЛЬНО. В бою стоит AGENT_SUPERVISOR=bus: каждая запись файла
// уходит заявкой мне и блокирует агента до ответа (таймаут 10 минут). С таким надзором замер
// мерил бы скорость моего согласования, а не качество кода. Это отдельный вопрос, и он вынесен
// в отчёт отдельной строкой.
//
// Запуск: node agent/bench-leetcode/run.js [--runs N] [--only <id>] [--path raw|harness]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const problems = require('./problems');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const RUNS = parseInt(arg('--runs', '3'), 10);
const ONLY = arg('--only', null);
const PATHS = (arg('--path', 'raw,harness')).split(',');

// Песочница агента и потолок токенов — до первого require наших модулей: и tools.js, и config.js
// читают окружение на загрузке. Установка «после» тихо не подействовала бы.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-lc-'));
process.env.AGENT_ROOT = SANDBOX;
process.env.AGENT_SUPERVISOR = 'allow';
process.env.AGENT_ALLOW_RISKY = '1';
process.env.LLM_MAX_TOKENS = process.env.LLM_MAX_TOKENS || '16384';
process.env.LLM_BACKEND = 'openai';
process.env.LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8081/v1';

const { chat } = require('../../src/ollama');
const { runAgent } = require('../loop');

const OUT_DIR = path.join(HERE, '..', 'bench-results');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, `leetcode-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const log = (s) => { process.stdout.write(s + '\n'); };

// Из ответа модели достаём код. Если модель обернула в ```-блок — берём его, иначе весь текст.
// Провал извлечения считаем ОТДЕЛЬНО от неверного решения: «не смог оформить ответ» и «решил
// неправильно» — разные диагнозы, и лечатся разным (первое — промптом, второе — ничем).
function extractCode(text) {
  if (!text) return { code: '', how: 'пустой ответ' };
  const fences = [...String(text).matchAll(/```(?:js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length) return { code: fences.join('\n\n'), how: `блок кода (${fences.length})` };
  return { code: String(text), how: 'без блока — взят весь текст' };
}

function judge(code, problemId) {
  const f = path.join(SANDBOX, `cand-${problemId}-${Math.abs(Date.now() % 1e6)}.js`);
  fs.writeFileSync(f, code);
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'judge.js'), f, problemId],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    // Судья убит по таймауту = кандидат завис. Это ПРОВАЛ ПО ВРЕМЕНИ, а не поломка стенда.
    return { loadError: e.killed ? 'кандидат завис (>60 с) — судья снят по таймауту' : `судья упал: ${(e.message || '').slice(0, 120)}` };
  } finally { try { fs.unlinkSync(f); } catch (_) {} }
}

const RAW_SYSTEM = 'Ты пишешь код на JavaScript. Отвечай ТОЛЬКО кодом в блоке ```js — без объяснений до и после.';

async function runRaw(p) {
  const t0 = Date.now();
  const prompt = `${p.statement}\n\nНапиши функцию:\n${p.signature}\n\nВерни только готовый код функции.`;
  let text = '', err = null;
  try {
    text = await chat([{ role: 'system', content: RAW_SYSTEM }, { role: 'user', content: prompt }], { temperature: 0.2 });
  } catch (e) { err = e.message; }
  const secs = (Date.now() - t0) / 1000;
  if (err) return { path: 'raw', secs, error: err };
  const { code, how } = extractCode(text);
  return { path: 'raw', secs, extract: how, chars: text.length, verdict: judge(code, p.id), answer: text.slice(0, 4000) };
}

async function runHarness(p) {
  const t0 = Date.now();
  const file = `solution-${p.id}.js`;
  // Задача сформулирована так, чтобы харнес мог показать СВОЁ преимущество: у него есть файлы и
  // shell, то есть возможность проверить себя до ответа. Если петля этим не пользуется — это
  // и есть находка.
  const task = `Реши задачу и запиши решение в файл ${file}.

${p.statement}

Требуемая функция:
${p.signature}

Порядок работы:
1) Напиши решение в файл ${file} инструментом write_file. В файле должна быть ТОЛЬКО функция ${p.fn}, без примеров вызова.
2) Проверь себя: создай отдельный файл с тестами и запусти его через shell командой "node <файл>". Сверь вывод с примерами из условия.
3) Если тест не сошёлся — исправь ${file} и проверь снова.
4) В ответе кратко напиши, что проверил и каков результат.`;
  let res = null, err = null;
  const trace = [];
  try {
    res = await runAgent(task, { maxSteps: 12, onEvent: (e) => { if (e.type === 'tool') trace.push(e.name); } });
  } catch (e) { err = e.message; }
  const secs = (Date.now() - t0) / 1000;
  if (err) return { path: 'harness', secs, error: err, tools: trace };

  // Код берём ИЗ ФАЙЛА — это и есть продукт харнеса. Если файла нет, падаем на текст ответа и
  // помечаем: «не создал файл» — само по себе диагноз о петле, а не о задаче.
  const full = path.join(SANDBOX, file);
  let code = '', from = '';
  if (fs.existsSync(full)) { code = fs.readFileSync(full, 'utf8'); from = 'файл'; }
  else { const e = extractCode(res.answer); code = e.code; from = `ФАЙЛ НЕ СОЗДАН → ${e.how}`; }
  return { path: 'harness', secs, extract: from, steps: res.steps, tools: trace, verdict: judge(code, p.id), answer: (res.answer || '').slice(0, 2000) };
}

(async () => {
  const list = ONLY ? problems.filter((p) => p.id === ONLY) : problems;
  const all = [];
  log(`\nЗАДАЧ: ${list.length}   ПУТЕЙ: ${PATHS.join(', ')}   ПРОГОНОВ НА КОМБИНАЦИЮ: ${RUNS}`);
  log(`песочница: ${SANDBOX}`);
  log(`результаты: ${OUT}\n`);

  for (const p of list) {
    log(`\n${'═'.repeat(76)}\n${p.title}\n  заученность: ${p.memorability}\n${'═'.repeat(76)}`);
    for (const pathName of PATHS) {
      for (let i = 1; i <= RUNS; i++) {
        process.stdout.write(`  ${pathName.padEnd(8)} прогон ${i}/${RUNS} … `);
        const r = pathName === 'raw' ? await runRaw(p) : await runHarness(p);
        r.problem = p.id; r.run = i;
        all.push(r);
        fs.writeFileSync(OUT, JSON.stringify(all, null, 2));   // инкрементально: прогон долгий
        const v = r.verdict;
        if (r.error) log(`ОШИБКА: ${String(r.error).slice(0, 90)}  (${r.secs.toFixed(0)}с)`);
        else if (!v || v.loadError) log(`не запустилось: ${(v && v.loadError) || '?'}  (${r.secs.toFixed(0)}с)`);
        else log(`${v.solved ? '✓ РЕШЕНО' : '✗'} тесты ${v.passed}/${v.total}`
          + `${v.perf ? `, время ${v.perf.ok ? 'ок' : 'ПРОВАЛ'}${v.perf.ms !== undefined ? ` (${v.perf.ms}мс/${v.perf.limitMs})` : ''}` : ', до времени не дошло'}`
          + `  (${r.secs.toFixed(0)}с${r.steps ? `, шагов ${r.steps}` : ''})`);
      }
    }
  }

  log(`\n\n${'█'.repeat(76)}\nИТОГ\n${'█'.repeat(76)}`);
  log(`${'задача'.padEnd(24)}${'путь'.padEnd(10)}решено  тесты(среднее)  время`);
  for (const p of list) {
    for (const pathName of PATHS) {
      const rs = all.filter((r) => r.problem === p.id && r.path === pathName);
      if (!rs.length) continue;
      const solved = rs.filter((r) => r.verdict && r.verdict.solved).length;
      const avgCases = rs.map((r) => (r.verdict && r.verdict.total ? r.verdict.passed / r.verdict.total : 0)).reduce((a, b) => a + b, 0) / rs.length;
      const avgSec = rs.reduce((a, b) => a + b.secs, 0) / rs.length;
      log(`${p.id.padEnd(24)}${pathName.padEnd(10)}${String(solved + '/' + rs.length).padEnd(8)}${(avgCases * 100).toFixed(0).padStart(9)}%${avgSec.toFixed(0).padStart(9)}с`);
    }
  }
  log(`\nподробности: ${OUT}`);
})();
