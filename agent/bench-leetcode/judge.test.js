// ПРОВЕРКА СУДЬИ. Стенд, который не отличает верное решение от наивного, померяет что угодно и
// выдаст правдоподобное число — поэтому судья проверяется ДО того, как им судят модель.
//
// Три подставных кандидата на каждую задачу:
//   ЭТАЛОН   — правильное решение нужной сложности → обязан пройти целиком;
//   НАИВНЫЙ  — верный по смыслу, но квадратичный → обязан пройти тесты и УПАСТЬ по времени.
//              Это главный тест: без него «решено» означало бы всего лишь «не ошиблось в примерах»;
//   МУСОР    — не тот тип/нет функции → обязан дать loadError, а не тихий ноль.
// Пары «эталон против наивного» здесь то же самое, что положительный близнец у отрицательного
// теста: по отдельности каждый ничего не доказывает.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
const results = [];
const check = (n, ok, why) => results.push({ n, ok, why });

function run(code, id) {
  const f = path.join(TMP, `c-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, code);
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'judge.js'), f, id], { encoding: 'utf8', timeout: 60000, maxBuffer: 4e6 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) { return { loadError: e.killed ? 'таймаут' : `упал: ${e.message.slice(0, 80)}` }; }
}

const GOOD_TRAP = `function trap(h){let l=0,r=h.length-1,lm=0,rm=0,s=0;while(l<r){if(h[l]<h[r]){lm=Math.max(lm,h[l]);s+=lm-h[l];l++;}else{rm=Math.max(rm,h[r]);s+=rm-h[r];r--;}}return s;}`;
const NAIVE_TRAP = `function trap(h){let s=0;for(let i=0;i<h.length;i++){let L=0,R=0;for(let j=0;j<=i;j++)L=Math.max(L,h[j]);for(let j=i;j<h.length;j++)R=Math.max(R,h[j]);s+=Math.min(L,R)-h[i];}return s;}`;
const GOOD_SWM = `function maxSlidingWindow(n,k){const o=[],d=[];for(let i=0;i<n.length;i++){while(d.length&&n[d[d.length-1]]<=n[i])d.pop();d.push(i);if(d[0]<=i-k)d.shift();if(i>=k-1)o.push(n[d[0]]);}return o;}`;
const NAIVE_SWM = `function maxSlidingWindow(n,k){const o=[];for(let i=0;i+k<=n.length;i++){let m=-Infinity;for(let j=i;j<i+k;j++)if(n[j]>m)m=n[j];o.push(m);}return o;}`;
const ONED_ON_2D = `function trapRainWater(g){let s=0;for(const row of g){let l=0,r=row.length-1,lm=0,rm=0;while(l<r){if(row[l]<row[r]){lm=Math.max(lm,row[l]);s+=lm-row[l];l++;}else{rm=Math.max(rm,row[r]);s+=rm-row[r];r--;}}}return s;}`;

// ── trap: эталон
{
  const r = run(GOOD_TRAP, 'trap-rain-water');
  check('trap: эталон O(n) решает целиком', r.solved === true && r.passed === r.total,
    r.solved ? `${r.passed}/${r.total}, время ${r.perf.ms}мс` : `НЕ признан: ${JSON.stringify(r).slice(0, 160)}`);
}
// ── trap: наивный — ГЛАВНЫЙ ТЕСТ
// Проверки СТРОГИЕ и требуют чисел. Первая версия сравнивала `r.passed === r.total`, а судья
// возвращал loadError — и `undefined === undefined` давало зелёный. Тест проходил, ничего не
// проверив, ровно в том сценарии, ради которого написан. Теперь форма ответа проверяется явно.
{
  const r = run(NAIVE_TRAP, 'trap-rain-water');
  const gotNumbers = Number.isInteger(r.passed) && Number.isInteger(r.total) && r.total > 0;
  const casesOk = gotNumbers && r.passed === r.total;
  const perfFailed = r.solved === false && r.perf && r.perf.ok === false && Number.isFinite(r.perf.ms);
  check('trap: наивный O(n²) проходит примеры, но ПАДАЕТ по времени', casesOk && perfFailed,
    gotNumbers ? `тесты ${r.passed}/${r.total}, solved=${r.solved}, время ${r.perf && r.perf.ms}мс/${r.perf && r.perf.limitMs}`
               : `судья не дал разбора: ${JSON.stringify(r).slice(0, 140)}`);
}
// ── sliding window: эталон и наивный
{
  const g = run(GOOD_SWM, 'sliding-window-max');
  check('окно: эталон O(n) решает целиком', g.solved === true, g.solved ? `${g.passed}/${g.total}, ${g.perf.ms}мс` : JSON.stringify(g).slice(0, 160));
  const n = run(NAIVE_SWM, 'sliding-window-max');
  const nOk = Number.isInteger(n.passed) && n.total > 0 && n.passed === n.total
    && n.solved === false && n.perf && n.perf.ok === false && Number.isFinite(n.perf.ms);
  check('окно: наивный O(n·k) верен, но ПАДАЕТ по времени', nOk,
    Number.isInteger(n.passed) ? `тесты ${n.passed}/${n.total}, solved=${n.solved}, ${n.perf && n.perf.ms}мс/${n.perf && n.perf.limitMs}`
                               : `судья не дал разбора: ${JSON.stringify(n).slice(0, 140)}`);
}
// ── 2D: подмена одномерным решением обязана валиться НА ТЕСТАХ, а не по времени
{
  const r = run(ONED_ON_2D, 'trap-rain-water-2d');
  check('2D: одномерное решение по строкам НЕ признаётся верным', !r.solved && r.passed < r.total,
    `тесты ${r.passed}/${r.total} — ловится на смысле, а не на скорости`);
}
// ── мусор
{
  const r = run('const x = 42;', 'trap-rain-water');
  check('нет функции → честный loadError, а не тихий ноль', !!r.loadError, r.loadError || 'ПРОГЛОТИЛ');
  const r2 = run('function trap(h){ while(true){} }', 'trap-rain-water');
  check('вечный цикл → снят по таймауту, стенд жив', !!r2.loadError, r2.loadError || 'не поймал зависание');
}

console.log('');
let bad = 0;
for (const r of results) { console.log(`  ${r.ok ? '✓' : '✗'} ${r.n}\n      ${r.why}`); if (!r.ok) bad++; }
console.log('');
console.log(bad ? `СУДЬЯ НЕИСПРАВЕН: ${bad} из ${results.length}` : `СУДЬЯ ГОДЕН: ${results.length} из ${results.length}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(bad ? 1 : 0);
