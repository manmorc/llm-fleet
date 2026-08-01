// Общая оснастка регресс-тестов шины: временный $HOME с ключами/реестром + драйвер MCP-сервера.
// Всё изолировано в os.tmpdir(): тест НЕ должен зависеть от того, что лежит у прогоняющего в
// ~/.agent-bus, и НЕ должен трогать боевые ящики/логи.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const MCP_DIR = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'redis-stub.js');

function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bus-test-${tag}-`));
  return d;
}

// Ed25519-пара тем же способом, что mcp/keygen.js (pkcs8 PEM приватный, base64 SPKI DER публичный).
function makeKey(dir, name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(dir, `${name}.key`);
  fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return { file, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

function writeRegistry(dir, entries) {
  const file = path.join(dir, 'agent-keys.json');
  fs.writeFileSync(file, JSON.stringify({ '//': 'тестовый реестр', ...entries }, null, 2));
  return file;
}

// Прогнать MCP-сервер agent-bus.js на заглушке Redis: отправить запросы, собрать ответы, забрать
// дамп состояния «Redis» после выхода. Проверяем и ответ инструмента, и побочный эффект.
function runBus({ env = {}, seed = {}, requests = [] }) {
  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bus-dump-')), 'state.json');
  const child = spawn(process.execPath, ['-r', STUB, path.join(MCP_DIR, 'agent-bus.js')], {
    env: {
      PATH: process.env.PATH,
      NODE_PATH: path.join(MCP_DIR, '..', 'node_modules'),
      REDIS_URL: 'redis://stub',
      REDIS_STUB_SEED: JSON.stringify(seed),
      REDIS_STUB_DUMP: dump,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  for (const [i, req] of requests.entries()) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...req }) + '\n');
  }
  child.stdin.end();
  return new Promise((resolve) => {
    child.on('close', (code) => {
      const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const texts = replies.map((r) => (r.result && r.result.content ? r.result.content.map((c) => c.text).join('\n') : null));
      let state = {};
      try { state = JSON.parse(fs.readFileSync(dump, 'utf8')); } catch (_) {}
      resolve({ code, replies, texts, state, err });
    });
  });
}

// Вызов одного инструмента — самый частый случай.
const toolCall = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args } });

// Запуск одноразового скрипта шины (bus-send/bus-selftest) с замером времени: для инцидента №1
// важен не только exit-код, но и то, что процесс УЛОЖИЛСЯ в дедлайн, а не завис до внешнего киллера.
// stub=false → настоящий ioredis (нужен, когда проверяем поведение при недоступном Redis).
function runScript(script, args = [], { env = {}, seed = null, stub = false } = {}) {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-dump-'));
  const dump = path.join(dumpDir, 'state.json');
  const argv = stub ? ['-r', STUB, script, ...args] : [script, ...args];
  const started = Date.now();
  const child = spawn(process.execPath, argv, {
    env: {
      PATH: process.env.PATH,
      NODE_PATH: path.join(MCP_DIR, '..', 'node_modules'),
      ...(stub ? { REDIS_STUB_SEED: JSON.stringify(seed || {}), REDIS_STUB_DUMP: dump } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  return new Promise((resolve) => child.on('close', (code) => {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(dump, 'utf8')); } catch (_) {}
    resolve({ code, out, err, state, ms: Date.now() - started });
  }));
}

module.exports = { tmpDir, makeKey, writeRegistry, runBus, runScript, toolCall, MCP_DIR, STUB };
