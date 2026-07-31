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
const FILE = 'agent/escalate.js';
const log = (m) => console.log(`${new Date().toISOString()} [decompose] ${m}`);

// ДВА АТОМА вместо одной составной задачи. Каждый — правка ровно в одном месте.
const STEPS = [
  'В файле agent/escalate.js у функции escalate третий аргумент — объект опций вида { fatal = false } = {}. '
  + 'Добавь в эту деструктуризацию ещё один параметр: silent = false. Больше НИЧЕГО не меняй.',

  'В файле agent/escalate.js найди блок, который отправляет копию в Telegram (он вызывает require(\'./notify\') '
  + 'и notify({...})). Оберни ВЕСЬ этот блок условием: выполнять его только если параметр silent НЕ установлен '
  + '(if (!silent) { ... }). Параметр silent уже объявлен в сигнатуре функции. Больше НИЧЕГО не меняй.',
];

// Критерий — дословно тот же, что у цельной задачи в bench-code-real.js.
const CHECK = `const src = require('fs').readFileSync('./agent/escalate.js','utf8');
  if (!/silent/.test(src)) throw new Error('опция silent не появилась в коде');
  const e = require('./agent/escalate.js');
  if (typeof e.escalate !== 'function') throw new Error('сломан экспорт escalate');
  const fn = e.escalate.toString();
  if (!/silent/.test(fn)) throw new Error('silent не используется внутри escalate');`;

function prepare(tag) {
  const dir = path.join(WORK, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['agent', 'mcp', 'src']) {
    const from = path.join(REPO, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch (_) {}
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
  log(`гипотеза: составная задача, проваленная 2/2 целиком, пройдёт после разреза на 2 атома`);
  log(`прогонов: ${RUNS} · критерий тот же, что у цельной задачи`);

  const origText = fs.readFileSync(path.join(REPO, FILE), 'utf8');
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
    const scope = ['fatal', 'notify', 'escalate(', 'silent'];
    const newSet = new Set(fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n').map((s) => s.trimEnd()));
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
