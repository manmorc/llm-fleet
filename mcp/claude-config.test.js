// Регресс-тесты слияния MCP-блока в конфиг Claude (mcp/claude-config.js). Уровень A — без Redis.
//
// ЧТО ЗДЕСЬ СТОРОЖИТСЯ. ~/.claude.json — личный файл владельца: проекты, история, флаги онбординга,
// ДРУГИЕ MCP-серверы (на боевой машине это десятки килобайт, которых больше нигде нет). Бутстрап
// новой машины обязан ДОПИСАТЬ в него один блок. Ошибка «собрать файл заново из того, что я знаю»
// не падает и ничего не сообщает — она просто стирает остальное, и обнаруживается через день, когда
// у владельца пропал rag-archive и все проекты. Это ровно класс «молчаливого провала»: тишина
// читается как успех. Поэтому каждое правило слияния закреплено тестом.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, runScript } = require('./test/fixtures');
const cc = require('./claude-config');

const OPTS = {
  id: 'desktop-new',
  label: 'worker',
  serverPath: '/home/u/llm-fleet/mcp/agent-bus.js',
  redisUrl: 'redis://:s3cret@100.65.89.101:6379',
};

// Похоже на настоящий ~/.claude.json: чужой MCP-сервер + куча ключей верхнего уровня.
const OWNER_CONFIG = {
  numStartups: 412,
  userID: 'abc123',
  projects: { '/home/u/work': { allowedTools: ['Bash'] } },
  mcpServers: {
    'rag-archive': { type: 'stdio', command: 'node', args: ['/home/u/llm-fleet/rag/mcp.js'], env: { RAG_TOKEN: 'секрет' } },
  },
  hasCompletedOnboarding: true,
};

test('чужие ключи верхнего уровня и чужие MCP-серверы переносятся дословно', () => {
  const out = cc.mergeAgentBus(OWNER_CONFIG, OPTS);
  assert.equal(out.numStartups, 412);
  assert.equal(out.userID, 'abc123');
  assert.deepEqual(out.projects, OWNER_CONFIG.projects);
  assert.equal(out.hasCompletedOnboarding, true);
  assert.deepEqual(out.mcpServers['rag-archive'], OWNER_CONFIG.mcpServers['rag-archive']);
  assert.equal(out.mcpServers['agent-bus'].env.AGENT_ID, 'desktop-new');
});

test('исходный объект не мутируется (слияние — чистая функция)', () => {
  const before = JSON.stringify(OWNER_CONFIG);
  cc.mergeAgentBus(OWNER_CONFIG, OPTS);
  assert.equal(JSON.stringify(OWNER_CONFIG), before, 'вход должен остаться нетронутым');
});

test('повторный прогон обновляет блок agent-bus, а ручные поля владельца в нём выживают', () => {
  const first = cc.mergeAgentBus(OWNER_CONFIG, OPTS);
  first.mcpServers['agent-bus'].env.EXTRA_FLAG = '1';          // владелец дописал руками
  first.mcpServers['agent-bus'].disabled = false;
  const second = cc.mergeAgentBus(first, { ...OPTS, label: 'dispatcher' });
  assert.equal(second.mcpServers['agent-bus'].env.EXTRA_FLAG, '1');
  assert.equal(second.mcpServers['agent-bus'].disabled, false);
  assert.equal(second.mcpServers['agent-bus'].env.AGENT_LABEL, 'dispatcher', 'наши поля обновляются');
  assert.equal(Object.keys(second.mcpServers).length, 2, 'чужой сервер не потерян при повторе');
});

test('конфига нет → создаётся с одним блоком (свежая машина)', () => {
  const dir = tmpDir('cc-fresh');
  const file = path.join(dir, '.claude.json');
  const res = cc.applyAgentBus({ ...OPTS, file });
  assert.equal(res.existed, false);
  assert.equal(res.backup, null);
  const on_disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(on_disk.mcpServers), ['agent-bus']);
});

test('запись сохраняет чужое содержимое на диске и кладёт резервную копию', () => {
  const dir = tmpDir('cc-write');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(OWNER_CONFIG, null, 2));
  const res = cc.applyAgentBus({ ...OPTS, file });
  const on_disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(on_disk.numStartups, 412);
  assert.ok(on_disk.mcpServers['rag-archive'], 'чужой MCP-сервер обязан остаться');
  assert.ok(res.backup && fs.existsSync(res.backup), 'резервная копия обязана существовать');
  assert.deepEqual(JSON.parse(fs.readFileSync(res.backup, 'utf8')), OWNER_CONFIG, 'копия = состояние ДО записи');
});

test('битый JSON → отказ, файл НЕ перезаписан (иначе «починка» = потеря данных владельца)', () => {
  const dir = tmpDir('cc-broken');
  const file = path.join(dir, '.claude.json');
  const broken = '{ "numStartups": 412, "projects": {  // недописанный файл';
  fs.writeFileSync(file, broken);
  assert.throws(() => cc.applyAgentBus({ ...OPTS, file }), /не парсится как JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'содержимое должно остаться байт в байт');
});

test('пустой файл считается пустым конфигом, а не поводом упасть', () => {
  const dir = tmpDir('cc-empty');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, '\n');
  cc.applyAgentBus({ ...OPTS, file });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['agent-bus'].env.AGENT_ID, 'desktop-new');
});

test('пароль Redis не попадает в печатаемый вывод (его читает агент и тащит в логи)', async () => {
  const dir = tmpDir('cc-cli');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(OWNER_CONFIG));
  const r = await runScript(path.join(__dirname, 'claude-config.js'), [
    '--id', 'desktop-new', '--label', 'worker', '--server', OPTS.serverPath,
    '--redis-url', OPTS.redisUrl, '--file', file,
  ]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes('s3cret'), `секрет утёк в stdout:\n${r.out}`);
  assert.match(r.out, /redis:\/\/:\*\*\*@/);
  assert.match(r.out, /rag-archive/, 'вывод обязан подтверждать, что чужие серверы сохранены');
  // Секрет в самом конфиге, разумеется, нужен — проверяем, что записан именно он.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['agent-bus'].env.REDIS_URL, OPTS.redisUrl);
});

test('битый конфиг: CLI выходит с ненулевым кодом и называет файл (молчаливого «готово» нет)', async () => {
  const dir = tmpDir('cc-cli-broken');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, '{ oops');
  const r = await runScript(path.join(__dirname, 'claude-config.js'), [
    '--id', 'x', '--server', OPTS.serverPath, '--redis-url', OPTS.redisUrl, '--file', file,
  ]);
  assert.equal(r.code, 1);
  assert.match(r.err, /не парсится как JSON/);
  assert.ok(r.err.includes(file), 'сообщение обязано называть проблемный файл');
});
