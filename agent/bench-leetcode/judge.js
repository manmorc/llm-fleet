// СУДЬЯ: запускает код кандидата в ОТДЕЛЬНОМ процессе и печатает вердикт JSON-ом в stdout.
//
// Почему отдельный процесс, а не require в стенде: у наивных решений на тестах производительности
// вполне законно бывает бесконечный цикл или переполнение стека. В общем процессе это убьёт весь
// замер и потеряет уже полученные результаты — а стенд, который умирает от плохого ответа, меряет
// собственную живучесть, а не модель.
//
// Запуск: node judge.js <файл-с-кодом> <id-задачи>
const fs = require('fs');
const path = require('path');
const problems = require('./problems');

const [, , codeFile, problemId] = process.argv;
const p = problems.find((x) => x.id === problemId);
if (!p) { console.log(JSON.stringify({ error: `нет задачи ${problemId}` })); process.exit(0); }

const src = fs.readFileSync(codeFile, 'utf8');

// Достаём функцию из произвольного куска кода. Модель может объявить её как function, const-стрелку
// или повесить на module.exports — принимаем все три: спор про синтаксис объявления не имеет
// отношения к вопросу «умеет ли она решать задачу».
function extractFn() {
  const wrapper = `
    const module = { exports: {} }; const exports = module.exports;
    ${src}
    ;try { if (typeof ${p.fn} === 'function') return ${p.fn}; } catch (e) {}
    if (typeof module.exports === 'function') return module.exports;
    if (module.exports && typeof module.exports.${p.fn} === 'function') return module.exports.${p.fn};
    return null;
  `;
  // eslint-disable-next-line no-new-func
  return new Function(wrapper)();
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Честный эталон для задач, где ожидаемый ответ на большом входе не выписать руками.
function referenceSlidingWindow(nums, k) {
  const out = [], dq = [];
  for (let i = 0; i < nums.length; i++) {
    while (dq.length && nums[dq[dq.length - 1]] <= nums[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - k) dq.shift();
    if (i >= k - 1) out.push(nums[dq[0]]);
  }
  return out;
}

(function main() {
  let fn;
  try { fn = extractFn(); } catch (e) {
    console.log(JSON.stringify({ loadError: `код не выполнился: ${e.message}` })); return;
  }
  if (typeof fn !== 'function') {
    console.log(JSON.stringify({ loadError: `функция ${p.fn} не найдена в ответе` })); return;
  }

  const cases = [];
  for (const c of p.cases) {
    try {
      // Копия входа: решение может испортить массив, и следующий тест получит мусор.
      // Без этого стенд наказывал бы за прошлый тест, а выглядело бы как неверный ответ.
      const got = fn(...JSON.parse(JSON.stringify(c.args)));
      cases.push({ note: c.note, ok: eq(got, c.expect), got: JSON.stringify(got).slice(0, 80), want: JSON.stringify(c.expect).slice(0, 80) });
    } catch (e) {
      cases.push({ note: c.note, ok: false, got: `ИСКЛЮЧЕНИЕ: ${e.message.slice(0, 60)}`, want: JSON.stringify(c.expect).slice(0, 80) });
    }
  }

  let perf = null;
  if (cases.every((c) => c.ok)) {
    // Тест на время имеет смысл ТОЛЬКО у корректного решения. Иначе померим скорость неправды.
    try {
      const args = p.perf.build();
      const want = p.perf.expect ? p.perf.expect(args)
        : (p.id === 'sliding-window-max' ? referenceSlidingWindow(args[0], args[1]) : null);
      const t0 = Date.now();
      const got = fn(...args);
      const ms = Date.now() - t0;
      perf = { ms, limitMs: p.perf.limitMs, correct: want === null ? true : eq(got, want), why: p.perf.why };
      perf.ok = perf.correct && ms <= p.perf.limitMs;
    } catch (e) { perf = { ok: false, error: e.message.slice(0, 80), limitMs: p.perf.limitMs, why: p.perf.why }; }
  }

  const passed = cases.filter((c) => c.ok).length;
  console.log(JSON.stringify({
    cases, passed, total: cases.length, perf,
    solved: passed === cases.length && !!(perf && perf.ok),
  }));
})();
