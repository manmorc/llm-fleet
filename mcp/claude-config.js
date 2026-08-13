#!/usr/bin/env node
// Вписывает MCP-блок `agent-bus` в конфиг Claude (~/.claude.json) — СЛИЯНИЕМ, не перезаписью.
//
// Почему отдельный модуль, а не `node -e` внутри bash-бутстрапа: ~/.claude.json — это НЕ конфиг шины,
// а личный файл владельца (проекты, история, другие MCP-серверы, флаги онбординга; на боевой машине
// это десятки килобайт данных, которые нигде больше не лежат). Однострочник, собирающий файл заново,
// стирает всё, чего он про файл не знал. Поэтому слияние живёт в коде, который покрыт тестами
// (mcp/claude-config.test.js), и подчиняется трём правилам:
//   1) неизвестные ключи верхнего уровня и чужие mcpServers переносятся дословно;
//   2) существующий блок agent-bus ОБНОВЛЯЕТСЯ по полям (ручные добавки владельца выживают);
//   3) файл, который не парсится как JSON, НЕ перезаписывается — это отказ с указанием файла,
//      потому что «починить» повреждённый конфиг записью поверх = потерять его содержимое.
// Перед записью кладётся резервная копия, запись атомарная (tmp + rename в том же каталоге).
//
// CLI:
//   node mcp/claude-config.js --id <agent-id> --label <роль> --server /abs/path/mcp/agent-bus.js \
//        --redis-url 'redis://:PASS@host:6379' [--file ~/.claude.json]
// Секрет в stdout НЕ печатается (маскируется) — вывод бутстрапа читает агент и может утащить в лог.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = process.env.CLAUDE_CONFIG_FILE || path.join(os.homedir(), '.claude.json');
const SERVER_NAME = 'agent-bus';

// Пароль в redis://:PASS@host — единственный секрет, который тут проходит. Маскируем везде, где печатаем.
function maskUrl(url) {
  return String(url || '').replace(/(redis(?:s)?:\/\/[^:@/]*:)[^@]*(@)/i, '$1***$2');
}

// Читает конфиг. Нет файла → {} (нормальный случай: свежая машина).
// Есть, но битый → бросаем: молча начать с {} значит подготовить перезапись чужих данных.
function readConfig(file = DEFAULT_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { config: {}, existed: false };
    throw new Error(`не могу прочитать ${file}: ${e.message}`);
  }
  if (raw.trim() === '') return { config: {}, existed: true };
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('корень не объект');
    }
    return { config, existed: true };
  } catch (e) {
    throw new Error(
      `${file} существует, но не парсится как JSON (${e.message}). НЕ перезаписываю: там личные данные ` +
      `владельца (проекты, другие MCP-серверы). Почини файл или отодвинь его и повтори.`
    );
  }
}

// Чистая функция слияния: возвращает НОВЫЙ объект, исходный не трогает.
function mergeAgentBus(config, { id, label, serverPath, redisUrl }) {
  if (!id) throw new Error('нужен AGENT_ID');
  if (!serverPath) throw new Error('нужен путь к mcp/agent-bus.js');
  if (!redisUrl) throw new Error('нужен REDIS_URL');
  const base = config && typeof config === 'object' ? config : {};
  const servers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  const prev = servers[SERVER_NAME] && typeof servers[SERVER_NAME] === 'object' ? servers[SERVER_NAME] : {};
  const prevEnv = prev.env && typeof prev.env === 'object' ? prev.env : {};
  return {
    ...base,                                  // все неизвестные нам ключи владельца — дословно
    mcpServers: {
      ...servers,                             // чужие MCP-серверы — дословно
      [SERVER_NAME]: {
        ...prev,                              // ручные добавки в самом блоке agent-bus — сохраняем
        type: prev.type || 'stdio',
        command: 'node',
        args: [serverPath],
        env: { ...prevEnv, REDIS_URL: redisUrl, AGENT_ID: id, AGENT_LABEL: label || 'agent' },
      },
    },
  };
}

// Атомарная запись с резервной копией. Возвращает путь копии (или null, если файла не было).
function writeConfig(file, config) {
  let backup = null;
  let mode = 0o600;
  try {
    const st = fs.statSync(file);
    mode = st.mode & 0o777;
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = `${file}.tmp-${process.pid}`;         // тот же каталог → rename атомарен
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  return backup;
}

// Полный цикл: прочитать → слить → записать.
function applyAgentBus(opts) {
  const file = opts.file || DEFAULT_FILE;
  const { config, existed } = readConfig(file);
  const merged = mergeAgentBus(config, opts);
  const backup = writeConfig(file, merged);
  return { file, existed, backup, merged };
}

module.exports = { readConfig, mergeAgentBus, writeConfig, applyAgentBus, maskUrl, DEFAULT_FILE, SERVER_NAME };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const opts = {
    id: arg('id', process.env.AGENT_ID),
    label: arg('label', process.env.AGENT_LABEL),
    serverPath: arg('server', path.join(__dirname, 'agent-bus.js')),
    redisUrl: arg('redis-url', process.env.REDIS_URL),
    file: arg('file', DEFAULT_FILE),
  };
  try {
    const { file, existed, backup, merged } = applyAgentBus(opts);
    const others = Object.keys(merged.mcpServers).filter((k) => k !== SERVER_NAME);
    console.log(`✅ MCP-блок agent-bus вписан в ${file}${existed ? '' : ' (файла не было — создан)'}`);
    console.log(`   AGENT_ID=${opts.id}  AGENT_LABEL=${opts.label || 'agent'}  REDIS_URL=${maskUrl(opts.redisUrl)}`);
    console.log(`   сохранено рядом: MCP-серверов ${others.length}${others.length ? ` (${others.join(', ')})` : ''}, ключей верхнего уровня ${Object.keys(merged).length}`);
    if (backup) console.log(`   резервная копия: ${backup}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
