// Регресс-тесты durable-персистера (mcp/agent-bus.persist.js). Уровень A — БЕЗ живого Redis.
//
// ЛОВИМ ИНЦИДЕНТ №5 (02.08.2026): персистер писал текст КАК ЕСТЬ → сообщение с переносами
// становилось НЕСКОЛЬКИМИ строками лога, а строчный читатель (tail|grep, вотчер, парсер) брал первую.
// Дважды дошёл только заголовок: mac-artyom прислал 6 критериев — получен один; объяснение для
// desktop-tt4i69c дошло без фактов. Отправитель оба раза видел успех — тихий сбой внутри канала.
// Инвариант, который здесь защищаем: ОДНО СООБЩЕНИЕ = ОДНА ФИЗИЧЕСКАЯ СТРОКА, и текст восстановим.
const path = require('path');
const { tmpDir, makeKey, writeRegistry } = require('./test/fixtures');

// Реестр/ключ подставляем ДО загрузки persist (он тянет keys.js, а тот читает пути при загрузке).
const dir = tmpDir('persist');
const alice = makeKey(dir, 'alice');
process.env.AGENT_KEYS_FILE = writeRegistry(dir, { 'agent-alice': alice.pub });
process.env.AGENT_PRIVKEY_FILE = alice.file;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('./keys');
const P = require('./agent-bus.persist');   // require НЕ должен поднимать BLPOP-цикл (main-guard)

// «Физическая строка» = то, как читают лог: tail/split по \n, а в JS-читателях ещё и U+2028/29,
// которые движок считает переносом (^/$ при /m). Всё это обязано отсутствовать во flatten-выводе.
const physLines = (s) => s.split(/\r\n|\r|\n|\u2028|\u2029/);

test('ИНЦИДЕНТ №5: текст с \\n, \\r\\n, \\r и U+2028/29 → РОВНО одна физическая строка', () => {
  const text = 'Заголовок\nпункт 1\r\nпункт 2\rпункт 3\u2028пункт 4\u2029пункт 5';
  const line = P.formatLine({ from: 'agent-alice', text, ts: 1 });
  assert.equal(physLines(line).length, 1, 'сообщение обязано остаться одной строкой лога');
  assert.match(line, /пункт 5/, 'хвост сообщения не должен теряться');
});

test('парс обратно восстанавливает текст (переносы нормализуются в \\n)', () => {
  const text = 'Критерии:\nа) раз\nб) два\n\nг) четыре';
  const line = P.formatLine({ from: 'agent-alice', text, ts: 1 });
  const got = P.parseLine(line);
  assert.ok(got, 'строка лога обязана разбираться обратно');
  assert.equal(got.text, text);
  assert.equal(got.from, 'agent-alice');
  assert.equal(got.kind, 'direct');
});

test('\\r\\n и U+2028 восстанавливаются как \\n (нормализация, тело целое)', () => {
  const got = P.parseLine(P.formatLine({ from: 'agent-alice', text: 'a\r\nb\u2028c\u2029d\re', ts: 1 }));
  assert.equal(got.text, 'a\nb\nc\nd\ne');
});

test('ДЫРА, найденная тестом: текст с самим маркером ⏎ раньше «отращивал» лишний перенос', () => {
  // Без экранирования маркера flatten/unflatten читали ⏎ в теле как перенос, которого не было.
  const text = 'смотри символ ⏎ в тексте, и ещё ⏎ подряд ⏎⏎ вот так';
  const got = P.parseLine(P.formatLine({ from: 'agent-alice', text, ts: 1 }));
  assert.equal(got.text, text, 'литеральный ⏎ обязан пережить круг без превращения в перенос');
  assert.equal(physLines(P.formatLine({ from: 'agent-alice', text, ts: 1 })).length, 1);
});

test('маркер вплотную к переносу — разбор однозначен в обе стороны', () => {
  for (const text of ['a⏎\nb', 'a\n⏎b', '⏎ ', '⏎', '\n⏎ ⏎\n', 'x⏎ y']) {
    assert.equal(P.unflatten(P.flatten(text)), text.replace(/\r\n|\r|\u2028|\u2029/g, '\n'), JSON.stringify(text));
  }
});

test('фаззинг: unflatten(flatten(x)) === x для произвольного текста без экзотических переносов', () => {
  const alphabet = ['a', 'я', '⏎', ' ', ':', '📨', '(broadcast)', '✓', '⚠', '\n', '{', '"'];
  let rnd = 42;
  const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 500; i++) {
    let s = '';
    const n = Math.floor(next() * 20);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(next() * alphabet.length)];
    assert.equal(P.unflatten(P.flatten(s)), s, JSON.stringify(s));
  }
});

test('текст с «: », «📨» и «(broadcast)» внутри не ломает разбор строки лога', () => {
  const text = '📨 отчёт: всё ок (broadcast): продолжаю';
  const got = P.parseLine(P.formatLine({ from: 'agent-alice', text, kind: 'broadcast', ts: 1 }));
  assert.equal(got.text, text);
  assert.equal(got.kind, 'broadcast', 'настоящий тег broadcast берётся из заголовка, а не из тела');
});

test('пометка подписи в логе: подписанное → ✓, неподписанное → ⚠ UNVERIFIED(unsigned)', () => {
  const signed = { from: 'agent-alice', text: 'дело', ts: Date.now() };
  signed.sig = keys.sign(signed);
  assert.ok(P.parseLine(P.formatLine(signed)).ok, 'подписанное обязано быть ✓');

  const bad = P.parseLine(P.formatLine({ from: 'agent-alice', text: 'дело', ts: Date.now() }));
  assert.equal(bad.ok, false);
  assert.equal(bad.verify, 'unsigned');
});

test('несколько сообщений подряд = столько же строк лога, и каждое читается целиком', () => {
  const msgs = [
    { from: 'agent-alice', text: 'первое\nс телом', ts: 1 },
    { from: 'agent-alice', text: 'второе', ts: 2 },
    { from: 'agent-alice', text: 'третье\nтоже\nс телом', ts: 3 },
  ];
  const log = msgs.map((m) => P.formatLine(m)).join('\n') + '\n';
  const lines = log.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'три сообщения — ровно три строки (иначе читатель насчитает лишние)');
  assert.deepEqual(lines.map((l) => P.parseLine(l).text), msgs.map((m) => m.text));
});

test('пустой/отсутствующий текст не роняет ни запись, ни разбор', () => {
  assert.equal(P.parseLine(P.formatLine({ from: 'agent-alice', ts: 1 })).text, '');
  assert.equal(P.flatten(null), '');
  assert.equal(P.parseLine('мусор не из лога'), null);
});

test('require модуля не поднимает Redis-цикл (иначе тесты уровня A требовали бы шину)', () => {
  assert.equal(typeof P.flatten, 'function');
  assert.ok(P.KEY.startsWith('agents:inbox:'));
  assert.ok(path.isAbsolute(P.LOG));
});
