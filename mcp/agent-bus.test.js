// Регресс-тесты MCP-сервера шины (mcp/agent-bus.js). Уровень A — БЕЗ живого Redis:
// сервер поднимается настоящий, но 'ioredis' подменён заглушкой (mcp/test/redis-stub.js),
// и мы смотрим не только на ТЕКСТ ответа тула, но и на побочный эффект — что реально легло в ящики.
// Именно расхождение «отчёт бодрый / в ящиках пусто» и стоило нам двух суток.
//
// Покрываемые инциденты:
//  №2 (01.08) broadcast слал ТОЛЬКО «присутствующим» и вернул «0 агентов» КАК УСПЕХ при живых агентах:
//             presence — ключ с TTL, продлеваемый из того же процесса, что делает работу.
//  №3 (01.08) исходящие уходили ⚠ UNVERIFIED(unsigned), а отправитель видел успех.
//  №4 (02.08) `inbox` всегда отвечал «пусто» там, где ящик выгребает персистер (4 часа глухоты).
const fs = require('fs'), path = require('path');
const { tmpDir, makeKey, writeRegistry, runBus, toolCall } = require('./test/fixtures');

const dir = tmpDir('bus');
const SELF = 'node-self', LIVE = 'node-live', SLEEPER = 'node-sleeper';
const selfKey = makeKey(dir, SELF);
const liveKey = makeKey(dir, LIVE);
const REG = writeRegistry(dir, { [SELF]: selfKey.pub, [LIVE]: liveKey.pub, [SLEEPER]: makeKey(dir, SLEEPER).pub });
const EMPTY_REG = path.join(dir, 'empty-keys.json');
fs.writeFileSync(EMPTY_REG, '{}');

process.env.AGENT_KEYS_FILE = REG;          // до require('./keys') — проверять подписи будем сами
const { test } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('./keys');
const integrity = require('./bus-integrity');

// Окружение «боевого» узла: свой id, свой приватный ключ, изолированный $HOME.
const baseEnv = (extra = {}) => ({
  AGENT_ID: SELF, AGENT_KEYS_FILE: REG, AGENT_PRIVKEY_FILE: selfKey.file,
  HOME: dir, ...extra,
});
const presence = (id) => JSON.stringify({ id, label: '', host: id, ts: Date.now() });
const inboxOf = (state, id) => (state.list || {})[`agents:inbox:${id}`] || [];

// ── ИНЦИДЕНТ №2: адресаты broadcast ──────────────────────────────────────────────────────────────
test('ИНЦИДЕНТ №2: broadcast адресует по РЕЕСТРУ, а спящий агент всё равно получает в ящик', async () => {
  const r = await runBus({
    env: baseEnv(),
    seed: { str: { [`agents:presence:${LIVE}`]: presence(LIVE) } },   // спящий в presence ОТСУТСТВУЕТ
    requests: [toolCall('broadcast', { text: 'директива флоту' })],
  });
  assert.match(r.texts[0], /Broadcast → 2 агент/, 'адресаты = реестр минус ты сам');
  assert.match(r.texts[0], new RegExp(`${SLEEPER} \\(спит`), 'спящему честно помечаем отложенное чтение');
  // ГЛАВНОЕ: сообщение реально положено обоим, а не только «онлайн».
  assert.equal(inboxOf(r.state, SLEEPER).length, 1, 'спящий обязан получить сообщение в durable-ящик');
  assert.equal(inboxOf(r.state, LIVE).length, 1);
  assert.equal(inboxOf(r.state, SELF).length, 0, 'сам себе broadcast не шлём');
});

test('ИНЦИДЕНТ №2: доставленное broadcast подписано и проходит проверку у КАЖДОГО получателя', async () => {
  const r = await runBus({ env: baseEnv(), requests: [toolCall('broadcast', { text: 'проверь подпись' })] });
  for (const id of [LIVE, SLEEPER]) {
    const rec = JSON.parse(inboxOf(r.state, id)[0]);
    assert.equal(rec.kind, 'broadcast');
    assert.equal(rec.to, id);
    assert.equal(keys.verify(rec), 'ok', `получатель ${id} обязан увидеть ✓, а не ⚠`);
  }
});

test('ИНЦИДЕНТ №2: пустой реестр → честный фолбэк на presence, а не тихое «0 агентов»', async () => {
  const r = await runBus({
    env: baseEnv({ AGENT_KEYS_FILE: EMPTY_REG }),
    seed: { str: { [`agents:presence:${LIVE}`]: presence(LIVE) } },
    requests: [toolCall('broadcast', { text: 'реестра нет' })],
  });
  assert.match(r.texts[0], /Broadcast → 1 агент/);
  assert.equal(inboxOf(r.state, LIVE).length, 1);
});

test('ИНЦИДЕНТ №2: некому слать → так и сказано «(реестр пуст)», без вида успешной рассылки', async () => {
  const r = await runBus({
    env: baseEnv({ AGENT_KEYS_FILE: EMPTY_REG }),
    requests: [toolCall('broadcast', { text: 'в пустоту' })],
  });
  assert.match(r.texts[0], /Broadcast → 0 агент\(ов\): \(реестр пуст\)/);
});

// ── ИНЦИДЕНТ №4: «пусто» может означать «я не туда смотрю» ────────────────────────────────────────
test('ИНЦИДЕНТ №4: пустой ящик + лог персистера → в ответе путь к логу и предупреждение', async () => {
  const log = path.join(dir, 'persister.log');
  fs.writeFileSync(log, '📨 ✓ 2026-08-02T00:00:00.000Z node-live: было сообщение\n');
  const r = await runBus({ env: baseEnv({ AGENT_BUS_LOG: log }), requests: [toolCall('inbox')] });
  assert.match(r.texts[0], /\(пусто\)/);
  assert.match(r.texts[0], /⚠/, 'без предупреждения «пусто» снова прочтут как «сообщений не было»');
  assert.ok(r.texts[0].includes(log), 'обязан быть путь к РЕАЛЬНОМУ каналу приёма');
  assert.match(r.texts[0], /НЕ значит/);
});

test('ИНЦИДЕНТ №4: лога персистера нет → обычное «пусто» без ложной тревоги', async () => {
  const r = await runBus({
    env: baseEnv({ AGENT_BUS_LOG: path.join(dir, 'нет-такого.log') }),
    requests: [toolCall('inbox')],
  });
  assert.match(r.texts[0], /\(пусто\)/);
  assert.ok(!r.texts[0].includes('⚠'), 'когда персистера нет, «пусто» честно и пугать нечем');
});

test('inbox помечает подписи: ✓ / ⚠unsigned / ⚠BAD — и вычищает ящик (peek — нет)', async () => {
  const good = { from: LIVE, to: SELF, text: 'подписанное', kind: 'direct', ts: Date.now() };
  process.env.AGENT_PRIVKEY_FILE = liveKey.file;
  delete require.cache[require.resolve('./keys')];
  const liveKeys = require('./keys');
  good.sig = liveKeys.sign(good);
  const tampered = { ...good, text: 'ПОДМЕНЁННОЕ после подписи' };
  const unsigned = { from: LIVE, to: SELF, text: 'без подписи', kind: 'direct', ts: Date.now() };

  const seed = { list: { [`agents:inbox:${SELF}`]: [good, tampered, unsigned].map((m) => JSON.stringify(m)) } };
  const peek = await runBus({ env: baseEnv(), seed, requests: [toolCall('inbox', { peek: true })] });
  assert.match(peek.texts[0], /Входящих: 3/);
  assert.match(peek.texts[0], /✓ .*подписанное/);
  assert.match(peek.texts[0], /⚠BAD/);
  assert.match(peek.texts[0], /⚠unsigned/);
  assert.equal(inboxOf(peek.state, SELF).length, 3, 'peek не имеет права опустошать ящик');

  const take = await runBus({ env: baseEnv(), seed, requests: [toolCall('inbox')] });
  assert.equal(inboxOf(take.state, SELF).length, 0, 'обычный inbox забирает сообщения');
});

test('inbox отдаёт многострочное сообщение ЦЕЛИКОМ (тело не режется на выдаче)', async () => {
  const text = 'Критерии:\n1) раз\n2) два\n3) три';
  const seed = { list: { [`agents:inbox:${SELF}`]: [JSON.stringify({ from: LIVE, text, kind: 'direct', ts: Date.now() })] } };
  const r = await runBus({ env: baseEnv(), seed, requests: [toolCall('inbox')] });
  for (const part of ['1) раз', '2) два', '3) три']) assert.ok(r.texts[0].includes(part), part);
});

// ── ИНЦИДЕНТ №3: отправка без ключа обязана быть видимой ─────────────────────────────────────────
test('ИНЦИДЕНТ №3: нет приватного ключа → send честно говорит «⚠ без подписи», а не «Отправлено»', async () => {
  const r = await runBus({
    env: baseEnv({ AGENT_PRIVKEY_FILE: path.join(dir, 'нет-ключа.key') }),
    requests: [toolCall('send', { to: LIVE, text: 'важное' })],
  });
  assert.match(r.texts[0], /без подписи/, 'иначе неподписанная директива выглядит как доставленная');
  const rec = JSON.parse(inboxOf(r.state, LIVE)[0]);
  assert.equal(keys.verify(rec), 'unsigned');
});

test('send с ключом → подписанное сообщение в ящике адресата (canon = from|ts|text)', async () => {
  const r = await runBus({ env: baseEnv(), requests: [toolCall('send', { to: LIVE, text: 'по делу' })] });
  assert.match(r.texts[0], /Отправлено → node-live/);
  const rec = JSON.parse(inboxOf(r.state, LIVE)[0]);
  assert.equal(rec.from, SELF);
  // С 03.08.2026 текст уходит с маркером целостности в начале. Сверяем не сырую строку, а ТЕЛО
  // после проверки маркера — так тест продолжает утверждать ровно то же («дошло целиком»),
  // но заодно доказывает, что маркер поставлен и сходится.
  const iv = integrity.verify(rec.text);
  assert.equal(iv.stamped, true, 'отправка обязана ставить маркер целостности');
  assert.equal(iv.ok, true, 'маркер сходится с телом');
  assert.equal(iv.body, 'по делу');
  assert.equal(keys.verify(rec), 'ok');
});

test('send с многострочным текстом кладёт в ящик ПОЛНЫЙ текст (подпись покрывает всё тело)', async () => {
  const text = 'шапка\nтело1\nтело2';
  const r = await runBus({ env: baseEnv(), requests: [toolCall('send', { to: LIVE, text })] });
  const rec = JSON.parse(inboxOf(r.state, LIVE)[0]);
  const iv = integrity.verify(rec.text);
  assert.equal(iv.ok, true, 'маркер сходится — тело дошло целиком');
  assert.equal(iv.body, text);
  // Подпись покрывает УЖЕ ПОМЕЧЕННЫЙ текст: обе проверки обязаны считать одно и то же,
  // иначе получатель, доверяющий подписи, и получатель, доверяющий маркеру, разойдутся.
  assert.equal(keys.verify(rec), 'ok');
});

// ── presence и ящик: TTL, обрезка, служебное ────────────────────────────────────────────────────
test('presence обновляется с TTL, а у ящика недельный TTL (непрочитанное не пропадает за ночь)', async () => {
  const r = await runBus({ env: baseEnv(), requests: [toolCall('send', { to: LIVE, text: 'x' })] });
  const expire = (r.state.calls || []).find((c) => c[0] === 'expire' && c[1] === `agents:inbox:${LIVE}`);
  assert.ok(expire, 'ящику обязаны выставлять TTL');
  assert.equal(expire[2], 7 * 24 * 3600);
  assert.ok((r.state.str || {})[`agents:presence:${SELF}`], 'хартбит ставится при любом вызове тула');
});

test('who показывает онлайн-агентов и помечает себя (presence — ТОЛЬКО отображение)', async () => {
  const r = await runBus({
    env: baseEnv(),
    seed: { str: { [`agents:presence:${LIVE}`]: presence(LIVE) } },
    requests: [toolCall('who')],
  });
  assert.match(r.texts[0], /Онлайн \(2\)/);
  assert.match(r.texts[0], new RegExp(`${SELF} ← ты`));
});

test('MCP-протокол: initialize и tools/list отдают все четыре инструмента', async () => {
  const r = await runBus({
    env: baseEnv(),
    requests: [{ method: 'initialize', params: {} }, { method: 'tools/list', params: {} }],
  });
  assert.equal(r.replies[0].result.serverInfo.name, 'agent-bus');
  const names = r.replies[1].result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['broadcast', 'inbox', 'send', 'who']);
});

test('ошибка инструмента возвращается как isError, а не как пустой успех', async () => {
  const r = await runBus({ env: baseEnv(), requests: [toolCall('send', { to: LIVE })] });
  assert.equal(r.replies[0].result.isError, true);
  assert.match(r.texts[0], /Ошибка/);
});
