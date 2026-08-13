#!/usr/bin/env node
// Приёмка узла шины ПОСЛЕ бутстрапа: проверяет не «скрипт отработал», а что реально получилось.
//
// Зачем отдельно от bus-selftest.js: селфтест гоняет сообщение сам себе и требует, чтобы узел уже был
// в реестре — на свежей машине он честно валится «unknown-key», и этот провал ничего не диагностирует.
// Доктор проверяет ровно то, что бутстрап только что создал, и КАЖДЫЙ провал называет, что именно не так:
// молчаливого «готово» быть не должно — тишина читается как успех.
//
//   node mcp/bus-doctor.js [--hub-dir /path/to/llm-fleet/на/хабе]
//
// Коды: 0 — локально всё исправно (в реестре можно ещё не быть, это ожидаемо и печатается отдельно);
//       1 — есть провалившаяся проверка.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const CONFIG_FILE = argOf('config', process.env.CLAUDE_CONFIG_FILE || path.join(os.homedir(), '.claude.json'));
const HUB_DIR = argOf('hub-dir', process.env.HUB_DIR || '<каталог llm-fleet на хабе>');
const REDIS_TIMEOUT_MS = Number(process.env.BUS_DOCTOR_TIMEOUT_MS) || 8000;

const { maskUrl, SERVER_NAME } = require('./claude-config');

const fails = [];
const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (what, why) => { fails.push(what); console.log(`✗ ${what}: ${why}`); };

// ── 1. Конфиг Claude: файл парсится, блок на месте, поля заполнены ─────────────────────────────
let cfg = null, block = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const others = Object.keys(cfg.mcpServers || {}).filter((k) => k !== SERVER_NAME);
  block = (cfg.mcpServers || {})[SERVER_NAME];
  if (!block) {
    bad('конфиг Claude', `${CONFIG_FILE} парсится, но блока mcpServers.${SERVER_NAME} в нём нет — MCP-сервер шины не поднимется`);
  } else {
    ok(`конфиг Claude: ${CONFIG_FILE} — валидный JSON, блок ${SERVER_NAME} на месте` +
       (others.length ? ` (рядом сохранены: ${others.join(', ')})` : ''));
  }
} catch (e) {
  bad('конфиг Claude', `${CONFIG_FILE} — ${e.code === 'ENOENT' ? 'файла нет' : `не парсится как JSON (${e.message})`}`);
}

const env = (block && block.env) || {};
const AGENT_ID = env.AGENT_ID || process.env.AGENT_ID || '';
const REDIS_URL = env.REDIS_URL || process.env.REDIS_URL || '';
if (block) {
  if (!AGENT_ID) bad('AGENT_ID', 'пуст в блоке agent-bus — узел не сможет назваться на шине');
  if (!REDIS_URL) bad('REDIS_URL', 'пуст в блоке agent-bus — подключаться некуда');
  const server = (block.args || [])[0];
  if (!server) bad('путь к MCP-серверу', 'в блоке agent-bus нет args[0]');
  else if (!fs.existsSync(server)) bad('путь к MCP-серверу', `${server} не существует (репозиторий переехал или не склонирован)`);
  else ok(`MCP-сервер: ${server}`);
}

// ── 2. Приватный ключ: есть, режим 600, читается ───────────────────────────────────────────────
const PRIV = process.env.AGENT_PRIVKEY_FILE || path.join(os.homedir(), '.agent-bus', 'agent.key');
let myPub = null;
try {
  const st = fs.statSync(PRIV);
  const mode = st.mode & 0o777;
  const key = crypto.createPrivateKey(fs.readFileSync(PRIV));
  myPub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  if (process.platform !== 'win32' && mode !== 0o600) {
    bad('права на приватный ключ', `${PRIV} имеет режим ${mode.toString(8)}, нужен 600 (исправь: chmod 600 ${PRIV})`);
  } else {
    ok(`приватный ключ: ${PRIV}${process.platform === 'win32' ? '' : ' (chmod 600)'}`);
  }
} catch (e) {
  bad('приватный ключ', `${PRIV} — ${e.code === 'ENOENT' ? 'не создан (запусти: AGENT_ID=<id> node mcp/keygen.js)' : e.message}`);
}

// ── 3. Реестр: признан ли этот узел (это НЕ провал — это ожидание решения владельца) ───────────
let registryState = 'pending';
try {
  const regFile = process.env.AGENT_KEYS_FILE || path.join(__dirname, 'agent-keys.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  if (AGENT_ID && reg[AGENT_ID] && myPub) {
    if (reg[AGENT_ID] === myPub) registryState = 'registered';
    else { registryState = 'conflict'; bad('реестр', `id «${AGENT_ID}» уже занят ДРУГИМ ключом — выбери другой AGENT_ID, иначе подписи не сойдутся`); }
  }
} catch (_) { /* реестра может не быть у изолированного узла — это не ошибка приёмки */ }

// ── 4. Redis: доступен ли координатор именно с этой машины ─────────────────────────────────────
async function checkRedis() {
  if (!REDIS_URL) return;
  let IORedis;
  try { IORedis = require('ioredis'); }
  catch (_) { bad('Redis', 'модуль ioredis не установлен — выполни npm install в каталоге llm-fleet'); return; }
  const r = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: Math.min(5000, REDIS_TIMEOUT_MS),
    commandTimeout: Math.min(5000, REDIS_TIMEOUT_MS),
    retryStrategy: () => null,       // одноразовая проверка: нужен конечный отказ, а не вечный реконнект
    lazyConnect: true,
  });
  // Ошибку сокета запоминаем: при обрыве connect ioredis отдаёт бесполезное «Connection is closed»,
  // а причина (ECONNREFUSED / ETIMEDOUT / WRONGPASS) приходит именно сюда. Без этого диагноз врал бы.
  let lastErr = null;
  r.on('error', (e) => { lastErr = e; });
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error(`нет ответа за ${REDIS_TIMEOUT_MS}мс`)), REDIS_TIMEOUT_MS));
  try {
    await Promise.race([r.connect().then(() => r.ping()), guard]);
    ok(`Redis: PING прошёл (${maskUrl(REDIS_URL)})`);
  } catch (e) {
    const raw = String(e.message || e);
    const m = /Connection is closed/i.test(raw) && lastErr ? String(lastErr.message || lastErr) : raw;
    const why = /WRONGPASS|NOAUTH|invalid password/i.test(m) ? `координатор ответил, но пароль в REDIS_URL не подошёл (${m})`
      : /ENOTFOUND|EAI_AGAIN/i.test(m) ? `имя хоста не резолвится (${m}) — машина вне tailnet или MagicDNS не поднят`
      : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|нет ответа/i.test(m) ? `нет сети до координатора (${m}) — проверь tailscale status/ping`
      : m;
    bad('Redis', `${maskUrl(REDIS_URL)} — ${why}`);
  } finally { try { r.disconnect(); } catch (_) {} }
}

checkRedis().then(() => {
  console.log('');
  if (fails.length) {
    console.log(`✗ ПРИЁМКА НЕ ПРОЙДЕНА — провалов: ${fails.length} (${fails.join(', ')}). Чини по строкам «✗» выше.`);
    process.exit(1);
  }
  ok('локальная часть узла исправна');
  if (registryState === 'registered') {
    console.log(`\n✅ «${AGENT_ID}» УЖЕ в реестре — узел признан. Проверь канал: AGENT_ID='${AGENT_ID}' REDIS_URL='<url>' node mcp/bus-selftest.js`);
    return;
  }
  // Последний шаг — не автоматизируем: запись в реестр = выдача прав, её делает владелец.
  console.log('\n════════ ОТДАТЬ ВЛАДЕЛЬЦУ ════════');
  console.log(`Машина «${AGENT_ID}» готова, но ещё НЕ признана на шине: её сообщения у других будут`);
  console.log('⚠ UNVERIFIED(unknown-key), а рассылки ей не дойдут — broadcast идёт по реестру, не по онлайну.');
  console.log(`\nПубличный ключ: ${myPub}`);
  console.log('\nКоманда признания — выполнить НА ХАБЕ (linux-prestige):');
  console.log(`  node ${path.join(HUB_DIR, 'mcp', 'agent-keys-add.js')} ${AGENT_ID} ${myPub}`);
  console.log('══════════════════════════════════');
});
