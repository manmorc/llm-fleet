// Регресс-тесты одноразовой отправки (mcp/bus-send.js). Уровень A — БЕЗ живого Redis.
//
// ЛОВИМ ИНЦИДЕНТ №1 (01.08.2026): скрипт ВИС на Redis и умирал от внешнего киллера —
// `maxRetriesPerRequest: null` (бесконечный ретрай), нет connectTimeout, `.catch` не закрывал сокет.
// Отправитель ошибки НЕ ВИДЕЛ: терялись и ответы узлов, и аварийные эскалации (escalate.js, таймаут 15с).
// Инвариант: при недоступной шине процесс завершается САМ, в пределах дедлайна, с НЕНУЛЕВЫМ кодом
// и внятной причиной. Молчание/зависание успехом не считается.
// Плюс инцидент №2 в его копии: broadcast здесь адресует по реестру, а не по presence.
const net = require('net');
const path = require('path');
const { tmpDir, makeKey, writeRegistry, runScript } = require('./test/fixtures');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SEND = path.join(__dirname, 'bus-send.js');
const dir = tmpDir('send');
const SELF = 'node-self', PEER = 'node-peer', SLEEPER = 'node-sleeper';
const selfKey = makeKey(dir, SELF);
const REG = writeRegistry(dir, { [SELF]: selfKey.pub, [PEER]: makeKey(dir, PEER).pub, [SLEEPER]: makeKey(dir, SLEEPER).pub });
process.env.AGENT_KEYS_FILE = REG;
const keys = require('./keys');
const integrity = require('./bus-integrity');

// HOME пустой и временный: скрипт не должен подхватить боевой ~/.agent-bus/fleet.env.
const env = (extra = {}) => ({ HOME: dir, AGENT_ID: SELF, AGENT_KEYS_FILE: REG, AGENT_PRIVKEY_FILE: selfKey.file, ...extra });
const inboxOf = (state, id) => (state.list || {})[`agents:inbox:${id}`] || [];

// Заведомо закрытый порт: поднимаем и сразу гасим слушателя — честнее мока, ловит и ретраи, и сокет.
function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
// «Чёрная дыра»: TCP-соединение принимается, но ответа нет никогда — это ровно та ситуация,
// в которой старый bus-send висел вечно (connect прошёл, команда не отвечает).
function blackhole() {
  return new Promise((res) => {
    const s = net.createServer((sock) => sock.on('error', () => {}));   // молчим в сокет
    s.listen(0, '127.0.0.1', () => res({ port: s.address().port, close: () => s.close() }));
  });
}

test('ИНЦИДЕНТ №1: Redis недоступен → выход за дедлайн, код ≠ 0, причина в stderr', async () => {
  const port = await freePort();
  const r = await runScript(SEND, [PEER, 'важное сообщение'], {
    env: env({ REDIS_URL: `redis://127.0.0.1:${port}`, BUS_SEND_TIMEOUT_MS: '4000' }),
  });
  assert.notEqual(r.code, 0, 'недоставленное обязано быть ненулевым кодом, иначе вызывающий примет за успех');
  assert.match(r.err, /ERR/);
  assert.match(r.err, /НЕ доставлено/);
  assert.ok(r.ms < 6000, `уложился в дедлайн, а не висел до киллера (было ${r.ms}мс)`);
});

test('ИНЦИДЕНТ №1: шина «молчит в сокет» → сторож добивает процесс сам, с причиной', async () => {
  const bh = await blackhole();
  try {
    const r = await runScript(SEND, [PEER, 'эскалация'], {
      env: env({ REDIS_URL: `redis://127.0.0.1:${bh.port}`, BUS_SEND_TIMEOUT_MS: '3000' }),
    });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /таймаут|НЕ доставлено/);
    assert.ok(r.ms < 8000, `сторож обязан сработать (было ${r.ms}мс)`);
  } finally { bh.close(); }
});

test('ИНЦИДЕНТ №1 (корень): нет REDIS_URL → отказ до отправки, без тихого фолбэка на localhost', async () => {
  const r = await runScript(SEND, [PEER, 'текст'], { env: env() });   // ни env, ни fleet.env в пустом HOME
  assert.equal(r.code, 1);
  assert.match(r.err, /нет REDIS_URL/);
});

test('без аргументов → usage и ненулевой код (а не «как бы отправлено»)', async () => {
  const r = await runScript(SEND, [], { env: env({ REDIS_URL: 'redis://127.0.0.1:1' }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /usage/);
});

test('happy-path: сообщение подписано и лежит в ящике адресата, текст целый', async () => {
  const text = 'шапка\nтело1\nтело2';
  const r = await runScript(SEND, [PEER, text], { env: env({ REDIS_URL: 'redis://stub' }), stub: true });
  assert.equal(r.code, 0);
  assert.match(r.out, /signed ✓/);
  const rec = JSON.parse(inboxOf(r.state, PEER)[0]);
  const iv = integrity.verify(rec.text);
  assert.equal(iv.ok, true, 'маркер целостности сходится — текст дошёл целиком');
  assert.equal(iv.body, text, 'многострочный текст не должен обрезаться при отправке');
  assert.equal(keys.verify(rec), 'ok');
});

test('ИНЦИДЕНТ №2 в bus-send: `all` адресует по реестру — спящий тоже получает', async () => {
  const r = await runScript(SEND, ['all', 'директива'], {
    env: env({ REDIS_URL: 'redis://stub' }), stub: true,
    seed: { str: { [`agents:presence:${PEER}`]: JSON.stringify({ id: PEER, ts: Date.now() }) } },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /broadcast → 2 \(онлайн сейчас 1\)/);
  assert.equal(inboxOf(r.state, SLEEPER).length, 1, 'спящий обязан получить в durable-ящик');
  assert.equal(inboxOf(r.state, PEER).length, 1);
  assert.equal(inboxOf(r.state, SELF).length, 0);
  assert.equal(keys.verify(JSON.parse(inboxOf(r.state, SLEEPER)[0])), 'ok');
});

test('ИНЦИДЕНТ №3 в bus-send: без приватного ключа в выводе «⚠ без ключа», а не тихое «отправлено»', async () => {
  const r = await runScript(SEND, [PEER, 'важное'], {
    env: env({ REDIS_URL: 'redis://stub', AGENT_PRIVKEY_FILE: path.join(dir, 'нет-ключа.key') }), stub: true,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /без ключа/);
  assert.equal(keys.verify(JSON.parse(inboxOf(r.state, PEER)[0])), 'unsigned');
});
