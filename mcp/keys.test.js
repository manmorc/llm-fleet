// Регресс-тесты подписи шины (mcp/keys.js). Уровень A — БЕЗ живого Redis.
//
// ЛОВИМ ИНЦИДЕНТ №3 (01.08.2026): исходящие уходили `⚠ UNVERIFIED(unsigned)` — MCP-субпроцесс был
// загружен ДО появления приватного ключа, и директиву «подписанное = авторизация» разослали
// НЕПОДПИСАННОЙ. То есть «доставлено» в форме, которую получатель обязан игнорировать, а отправитель
// видел успех. Отсюда требование: отсутствие ключа обязано быть ВИДНЫМ (sign → null, пометка в ответе),
// а не молчаливым «ок».
// Плюс базовый контракт доверия: подмена отправителя/текста/времени после подписи = BAD,
// незнакомый отправитель = unknown-key. На этих трёх словах держится правило «доверяй только ✓».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, makeKey, writeRegistry } = require('./test/fixtures');

// keys.js читает пути ключей/реестра при ЗАГРУЗКЕ модуля → перезагружаем под нужное окружение.
function loadKeys({ priv, registry }) {
  if (priv) process.env.AGENT_PRIVKEY_FILE = priv; else delete process.env.AGENT_PRIVKEY_FILE;
  if (registry) process.env.AGENT_KEYS_FILE = registry; else delete process.env.AGENT_KEYS_FILE;
  delete require.cache[require.resolve('./keys')];
  return require('./keys');
}

const dir = tmpDir('keys');
const alice = makeKey(dir, 'alice');
const bob = makeKey(dir, 'bob');
const REG = writeRegistry(dir, { 'agent-alice': alice.pub, 'agent-bob': bob.pub });

test('подписал → проверил: ok (базовый контракт «доверяй только ✓»)', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const m = { from: 'agent-alice', to: 'agent-bob', text: 'привет', ts: 1754000000000 };
  m.sig = keys.sign(m);
  assert.ok(m.sig, 'подпись должна ставиться при наличии приватного ключа');
  assert.equal(keys.verify(m), 'ok');
});

test('подмена from после подписи → BAD (форж отправителя ловится)', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const m = { from: 'agent-alice', text: 'директива флоту', ts: 1754000000000 };
  m.sig = keys.sign(m);
  m.from = 'agent-bob';                 // пароль Redis общий → from сам по себе ничего не доказывает
  assert.equal(keys.verify(m), 'BAD');
});

test('подмена текста и времени после подписи → BAD', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const base = { from: 'agent-alice', text: 'выполни X', ts: 1754000000000 };
  base.sig = keys.sign(base);
  assert.equal(keys.verify({ ...base, text: 'выполни Y' }), 'BAD');
  assert.equal(keys.verify({ ...base, ts: base.ts + 1 }), 'BAD');
});

test('отправитель не в реестре → unknown-key (а не ok и не «пусто»)', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const m = { from: 'agent-ghost', text: 'я свой, честно', ts: 1754000000000 };
  m.sig = keys.sign(m);                 // подпись валидная, но ключ отправителя неизвестен
  assert.equal(keys.verify(m), 'unknown-key');
});

test('ИНЦИДЕНТ №3: нет приватного ключа → sign=null и статус unsigned (молчаливого «ок» нет)', () => {
  const keys = loadKeys({ priv: path.join(dir, 'нет-такого.key'), registry: REG });
  const m = { from: 'agent-alice', text: 'важное', ts: 1754000000000 };
  m.sig = keys.sign(m);
  assert.equal(m.sig, null, 'без ключа sign обязан вернуть null, а не «как-нибудь подписать»');
  assert.equal(keys.verify(m), 'unsigned');
  assert.equal(keys.myPub(), null);
});

test('canon не включает to → одна подпись валидна для всех получателей broadcast', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const base = { from: 'agent-alice', text: 'всем', ts: 1754000000000, kind: 'broadcast' };
  base.sig = keys.sign(base);
  assert.equal(keys.verify({ ...base, to: 'agent-bob' }), 'ok');
  assert.equal(keys.verify({ ...base, to: 'кто-то-третий' }), 'ok');
});

test('многострочный текст подписывается и проверяется без потерь (canon многострочен)', () => {
  const keys = loadKeys({ priv: alice.file, registry: REG });
  const m = { from: 'agent-alice', text: 'строка1\nстрока2\n\nстрока4', ts: 1754000000000 };
  m.sig = keys.sign(m);
  assert.equal(keys.verify(m), 'ok');
  assert.equal(keys.verify({ ...m, text: 'строка1' }), 'BAD', 'обрезка тела обязана ломать подпись');
});
