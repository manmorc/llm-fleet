#!/usr/bin/env node
// ЗАМЕР: тянет ли локальная модель ПРАВКИ КОДА. Вопрос владельца 31.07.2026 — можно ли грузить
// desktop-local тупой-но-массовой работой по коду ради экономии Claude-токенов.
//
// ЧЕСТНОСТЬ ЗАМЕРА — главное здесь. Критерий успеха НЕ «модель что-то написала», а «тесты прошли»:
// объективно, без моей интерпретации (класс №2 «ложный замер» — валидатор обязан быть механическим).
// Каждая задача изолирована в своей папке, агент видит только её (AGENT_ROOT), правит src.js,
// после чего мы гоняем `node --test` на НЕТРОНУТОМ test.js и смотрим код возврата.
//
// БЕЗОПАСНОСТЬ: полные права (write+shell) даются ТОЛЬКО внутри ~/agent-bench/work/<id>.
// Боевой агент (pm2 desktop-local-agent) остаётся в deny — его режим меняет владелец по результатам.
//
// Запуск: node agent/bench-code.js [--only <id>] [--tasks N]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BENCH = path.join(os.homedir(), 'agent-bench');
const WORK = path.join(BENCH, 'work');
const RESULTS = path.join(__dirname, 'bench-results', 'code.json');

// 20 задач класса «тупая-но-массовая»: мелкая правка, механически проверяемая тестом.
// Каждая — реальный паттерн из повседневного кода, а не головоломка: мы меряем рабочую лошадь,
// а не потолок рассуждения (он уже замерен и известен).
const TASKS = [
  { id: 'off-by-one', task: 'Функция last() должна возвращать ПОСЛЕДНИЙ элемент массива, а возвращает предпоследний. Исправь.',
    src: 'function last(a) { return a[a.length - 2]; }\nmodule.exports = { last };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {last}=require('./src.js');\ntest('last',()=>{A.strictEqual(last([1,2,3]),3);A.strictEqual(last(['x']),'x');});" },

  { id: 'null-check', task: 'Функция nameOf(user) падает, если user равен null или undefined. Пусть в этом случае возвращает строку "аноним".',
    src: 'function nameOf(user) { return user.name; }\nmodule.exports = { nameOf };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {nameOf}=require('./src.js');\ntest('nameOf',()=>{A.strictEqual(nameOf({name:'Ян'}),'Ян');A.strictEqual(nameOf(null),'аноним');A.strictEqual(nameOf(undefined),'аноним');});" },

  { id: 'sum-missing', task: 'Реализуй функцию sum(arr) — сумма чисел массива. Для пустого массива вернуть 0.',
    src: 'function sum(arr) { /* TODO: реализуй */ }\nmodule.exports = { sum };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {sum}=require('./src.js');\ntest('sum',()=>{A.strictEqual(sum([1,2,3]),6);A.strictEqual(sum([]),0);A.strictEqual(sum([-5,5]),0);});" },

  { id: 'sort-numeric', task: 'sortNums сортирует числа лексикографически (10 оказывается перед 9). Нужна числовая сортировка по возрастанию. Исходный массив не мутировать.',
    src: 'function sortNums(a) { return a.sort(); }\nmodule.exports = { sortNums };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {sortNums}=require('./src.js');\ntest('sortNums',()=>{A.deepStrictEqual(sortNums([10,9,1]),[1,9,10]);const o=[3,1];sortNums(o);A.deepStrictEqual(o,[3,1]);});" },

  { id: 'parse-radix', task: 'toInt использует parseInt без основания, из-за чего "08" разбирается неверно в старых движках. Добавь основание 10. Для нечисловой строки вернуть 0.',
    src: 'function toInt(s) { return parseInt(s); }\nmodule.exports = { toInt };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {toInt}=require('./src.js');\ntest('toInt',()=>{A.strictEqual(toInt('08'),8);A.strictEqual(toInt('42'),42);A.strictEqual(toInt('abc'),0);});" },

  { id: 'dedupe', task: 'Реализуй uniq(arr) — вернуть массив без повторов, сохранив порядок первого появления.',
    src: 'function uniq(arr) { /* TODO */ }\nmodule.exports = { uniq };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {uniq}=require('./src.js');\ntest('uniq',()=>{A.deepStrictEqual(uniq([1,2,1,3,2]),[1,2,3]);A.deepStrictEqual(uniq([]),[]);});" },

  { id: 'clamp', task: 'Реализуй clamp(x, min, max) — вернуть x, ограниченный диапазоном [min, max].',
    src: 'function clamp(x, min, max) { /* TODO */ }\nmodule.exports = { clamp };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {clamp}=require('./src.js');\ntest('clamp',()=>{A.strictEqual(clamp(5,0,10),5);A.strictEqual(clamp(-3,0,10),0);A.strictEqual(clamp(99,0,10),10);});" },

  { id: 'mod-negative', task: 'mod(a, n) должна возвращать ВСЕГДА неотрицательный остаток (математический модуль), а оператор % в JS для отрицательных даёт отрицательный. Исправь.',
    src: 'function mod(a, n) { return a % n; }\nmodule.exports = { mod };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {mod}=require('./src.js');\ntest('mod',()=>{A.strictEqual(mod(7,3),1);A.strictEqual(mod(-1,3),2);A.strictEqual(mod(-4,3),2);});" },

  { id: 'empty-array', task: 'avg(arr) делит на длину и возвращает NaN для пустого массива. Пусть для пустого возвращает 0.',
    src: 'function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }\nmodule.exports = { avg };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {avg}=require('./src.js');\ntest('avg',()=>{A.strictEqual(avg([2,4]),3);A.strictEqual(avg([]),0);});" },

  { id: 'missing-await', task: 'В функции load() забыт await — она возвращает Promise вместо значения. Исправь.',
    src: 'const get = async () => 42;\nasync function load() { const v = get(); return v; }\nmodule.exports = { load };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {load}=require('./src.js');\ntest('load',async()=>{const r=await load();A.strictEqual(r,42);A.strictEqual(typeof r,'number');});" },

  { id: 'deep-copy', task: 'copy(obj) делает поверхностную копию — вложенный объект остаётся общим. Сделай глубокую копию (структура простая: объекты, массивы, примитивы).',
    src: 'function copy(obj) { return { ...obj }; }\nmodule.exports = { copy };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {copy}=require('./src.js');\ntest('copy',()=>{const o={a:{b:1}};const c=copy(o);c.a.b=99;A.strictEqual(o.a.b,1);});" },

  { id: 'validate-input', task: 'Добавь в divide(a,b) проверку: при b===0 бросать Error с сообщением "деление на ноль".',
    src: 'function divide(a, b) { return a / b; }\nmodule.exports = { divide };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {divide}=require('./src.js');\ntest('divide',()=>{A.strictEqual(divide(6,3),2);A.throws(()=>divide(1,0),/деление на ноль/);});" },

  { id: 'default-param', task: 'greet(name, greeting) при отсутствии greeting подставляет undefined. Сделай значение по умолчанию "Привет".',
    src: 'function greet(name, greeting) { return greeting + ", " + name; }\nmodule.exports = { greet };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {greet}=require('./src.js');\ntest('greet',()=>{A.strictEqual(greet('Ян'),'Привет, Ян');A.strictEqual(greet('Ян','Хай'),'Хай, Ян');});" },

  { id: 'group-by', task: 'Реализуй groupBy(arr, key) — сгруппировать массив объектов в объект вида {значение_ключа: [элементы]}.',
    src: 'function groupBy(arr, key) { /* TODO */ }\nmodule.exports = { groupBy };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {groupBy}=require('./src.js');\ntest('groupBy',()=>{const r=groupBy([{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}],'t');A.deepStrictEqual(Object.keys(r).sort(),['a','b']);A.strictEqual(r.a.length,2);});" },

  { id: 'chunk', task: 'Реализуй chunk(arr, size) — разбить массив на подмассивы длины size (последний может быть короче).',
    src: 'function chunk(arr, size) { /* TODO */ }\nmodule.exports = { chunk };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {chunk}=require('./src.js');\ntest('chunk',()=>{A.deepStrictEqual(chunk([1,2,3,4,5],2),[[1,2],[3,4],[5]]);A.deepStrictEqual(chunk([],3),[]);});" },

  { id: 'try-catch', task: 'safeParse(s) падает на невалидном JSON. Оберни в try/catch и возвращай null при ошибке.',
    src: 'function safeParse(s) { return JSON.parse(s); }\nmodule.exports = { safeParse };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {safeParse}=require('./src.js');\ntest('safeParse',()=>{A.deepStrictEqual(safeParse('{\"a\":1}'),{a:1});A.strictEqual(safeParse('не json'),null);});" },

  { id: 'wrong-operator', task: 'isAdult должна возвращать true при возрасте 18 и больше, но использует строгое больше. Исправь.',
    src: 'function isAdult(age) { return age > 18; }\nmodule.exports = { isAdult };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {isAdult}=require('./src.js');\ntest('isAdult',()=>{A.strictEqual(isAdult(18),true);A.strictEqual(isAdult(17),false);A.strictEqual(isAdult(30),true);});" },

  { id: 'capitalize', task: 'Реализуй capitalize(s) — первая буква заглавная, остальные без изменений. Пустая строка остаётся пустой.',
    src: 'function capitalize(s) { /* TODO */ }\nmodule.exports = { capitalize };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {capitalize}=require('./src.js');\ntest('capitalize',()=>{A.strictEqual(capitalize('ян'),'Ян');A.strictEqual(capitalize(''),'');A.strictEqual(capitalize('ABC'),'ABC');});" },

  { id: 'range', task: 'Реализуй range(a, b) — массив целых от a до b включительно. Если a > b, вернуть пустой массив.',
    src: 'function range(a, b) { /* TODO */ }\nmodule.exports = { range };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {range}=require('./src.js');\ntest('range',()=>{A.deepStrictEqual(range(1,4),[1,2,3,4]);A.deepStrictEqual(range(3,3),[3]);A.deepStrictEqual(range(5,1),[]);});" },

  { id: 'count-words', task: 'countWords(s) считает слова через split(" ") и ошибается на нескольких пробелах подряд и на пустой строке. Исправь: пустая строка — 0.',
    src: 'function countWords(s) { return s.split(" ").length; }\nmodule.exports = { countWords };',
    test: "const {test}=require('node:test'),A=require('node:assert');const {countWords}=require('./src.js');\ntest('countWords',()=>{A.strictEqual(countWords('раз два'),2);A.strictEqual(countWords('раз  два'),2);A.strictEqual(countWords(''),0);});" },
];

const log = (m) => console.log(`${new Date().toISOString()} [bench-code] ${m}`);

function prepare(t) {
  const dir = path.join(WORK, t.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'src.js'), t.src);
  fs.writeFileSync(path.join(dir, 'test.js'), t.test);
  return dir;
}

// Критерий годности — ТОЛЬКО код возврата node --test. Никакой интерпретации ответа модели.
function testsPass(dir) {
  try {
    execFileSync(process.execPath, ['--test', 'test.js'], { cwd: dir, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

(async () => {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const limit = process.argv.includes('--tasks') ? parseInt(process.argv[process.argv.indexOf('--tasks') + 1], 10) : TASKS.length;
  const list = (only ? TASKS.filter((t) => t.id === only) : TASKS).slice(0, limit);

  fs.mkdirSync(WORK, { recursive: true });
  log(`задач: ${list.length} · песочница ${WORK}`);

  const rows = [];
  for (const t of list) {
    const dir = prepare(t);
    // Контрольная проверка: до правки тест ОБЯЗАН падать. Иначе задача не измеряет ничего
    // (класс №2: валидатор, который проходит без работы, — ложный замер).
    const before = testsPass(dir);
    if (before) { log(`⚠ ${t.id}: тест проходит ДО правки — задача негодная, пропускаю`); rows.push({ id: t.id, skipped: 'тест зелёный до правки' }); continue; }

    // Агент получает полные права ТОЛЬКО в этой папке.
    process.env.AGENT_ROOT = dir;
    process.env.AGENT_ALLOW_RISKY = '1';
    process.env.AGENT_SUPERVISOR = 'allow';
    delete require.cache[require.resolve('./tools')];
    delete require.cache[require.resolve('./loop')];
    const { converse, buildSystemPrompt } = require('./loop');

    const prompt = `В папке лежит файл src.js. Задача: ${t.task}\n`
      + `Прочитай src.js, внеси правку и запиши файл обратно через write_file. `
      + `Тест test.js не трогай. Когда закончишь — одной строкой скажи, что сделал.`;

    const t0 = Date.now();
    let err = null, calls = 0;
    try {
      await converse([{ role: 'system', content: buildSystemPrompt() }], prompt,
        { onEvent: (e) => { if (e.type === 'call') calls++; } });
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;

    const after = testsPass(dir);
    const changed = fs.readFileSync(path.join(dir, 'src.js'), 'utf8') !== t.src;
    rows.push({ id: t.id, ok: after, changed, calls, ms, err });
    log(`${after ? '✅' : '❌'} ${t.id} · ${(ms / 1000).toFixed(1)}с · тулз ${calls}${changed ? '' : ' · ФАЙЛ НЕ ИЗМЕНЁН'}${err ? ' · ' + err.slice(0, 60) : ''}`);
  }

  const done = rows.filter((r) => !r.skipped);
  const pass = done.filter((r) => r.ok).length;
  const wrote = done.filter((r) => r.changed).length;
  const out = {
    model: process.env.LLAMA_ALIAS || 'gpt-oss',
    pass, total: done.length, pct: done.length ? Math.round((pass / done.length) * 100) : 0,
    wroteFile: wrote,
    avgSec: done.length ? +(done.reduce((s, r) => s + (r.ms || 0), 0) / done.length / 1000).toFixed(1) : 0,
    rows,
  };
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  log(`ИТОГ: тесты прошли ${pass}/${done.length} (${out.pct}%) · файл изменён ${wrote}/${done.length} · среднее ${out.avgSec}с/задача`);
  log(`результат: ${RESULTS}`);
})();
