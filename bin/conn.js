#!/usr/bin/env node
// `conn` — ЕДИНЫЙ ВХОД НА ЛЮБУЮ МАШИНУ ФЛОТА.
//
// Зачем: у каждой ноды завёлся свой алиас под свой хост (connpc, connlptp, …) — по одному на
// направление. Их надо помнить, они расползаются по машинам и устаревают при переименовании хоста
// (мы уже наступили: desktop-tt4i69c.tail241f5d.ts.net перестал резолвиться, а у соседей алиас остался).
// Здесь одна команда на всех: `conn` показывает флот и кто сейчас онлайн, `conn <id>` заходит сразу.
//
// ИСТОЧНИКИ ДАННЫХ — намеренно разные, каждый отвечает за своё:
//   • СПИСОК МАШИН   — mcp/agent-keys.json, реестр ключей флота. Он и так trust-anchor, владелец его
//     ведёт, и новая нода появляется в нём раньше, чем где-либо ещё.
//   • АДРЕСА SSH     — fleet-hosts.json (в репо, не секрет: tailnet-имена и логины).
//   • КТО ОНЛАЙН     — presence в Redis, справочно. НЕ фильтр: спящая машина может быть нужна
//     (WoL, отложенная задача), поэтому показываем всех, а онлайн лишь помечаем.
//
// Использование:
//   conn            — список машин, выбор номером
//   conn linux      — подключиться сразу (хватает уникального куска имени)
//   conn --list     — только показать, без подключения
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOSTS = path.join(ROOT, 'fleet-hosts.json');
const KEYS = path.join(ROOT, 'mcp', 'agent-keys.json');
const SELF = process.env.FLEET_NODE_ID || fromFleetEnv('FLEET_NODE_ID') || os.hostname();

function fromFleetEnv(key) {
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return {}; } }

// Кто онлайн — по presence. Недоступность Redis НЕ должна ломать подключение: это справка, а не гейт.
async function online() {
  const url = process.env.REDIS_URL || fromFleetEnv('REDIS_URL');
  if (!url) return null;
  let r;
  try {
    const IORedis = require(path.join(ROOT, 'node_modules', 'ioredis'));
    r = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: () => null });
    r.on('error', () => {});
    const out = new Set();
    for (const k of await r.keys('agents:presence:*')) {
      const v = await r.get(k);
      if (v) try { out.add(JSON.parse(v).id); } catch (_) {}
    }
    return out;
  } catch (_) { return null; }
  finally { try { await r.quit(); } catch (_) { try { r.disconnect(); } catch (__) {} } }
}

function machines() {
  const hosts = readJson(HOSTS);
  const reg = Object.keys(readJson(KEYS)).filter((k) => !k.startsWith('//'));
  // Объединяем: реестр даёт ПОЛНЫЙ список флота, hosts — как туда попасть.
  // Машина без адреса всё равно показывается: лучше честное «адрес не задан», чем молчаливое отсутствие.
  // Ключи, начинающиеся с '//' — комментарии в JSON (в обоих файлах), а не машины.
  // desktop-local — локальный агент НА этой же машине, ssh к самому себе не нужен.
  const ids = [...new Set([...reg, ...Object.keys(hosts)])]
    .filter((id) => !id.startsWith('//') && id !== SELF && id !== 'desktop-local');
  return ids.map((id) => ({ id, ...(hosts[id] || {}) }));
}

function connect(m) {
  if (!m.ssh) {
    console.error(`\n❌ для "${m.id}" не задан адрес в fleet-hosts.json.`);
    console.error('   Добавь запись вида: "' + m.id + '": { "ssh": "user@host", "note": "чья машина" }');
    process.exit(1);
  }
  console.log(`\n→ ${m.id}  (${m.ssh})\n`);
  const args = [...(m.opts || []), m.ssh, ...process.argv.slice(3)];
  const p = spawn('ssh', args, { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c || 0));
  p.on('error', (e) => { console.error('ssh не запустился: ' + e.message); process.exit(1); });
}

(async () => {
  const list = machines();
  if (!list.length) { console.error('во флоте не найдено других машин (проверь mcp/agent-keys.json)'); process.exit(1); }

  const live = await online();
  const mark = (id) => (live === null ? ' ' : live.has(id) ? '🟢' : '💤');

  const arg = process.argv[2];
  if (arg && arg !== '--list') {
    const hit = list.filter((m) => m.id.toLowerCase().includes(arg.toLowerCase()));
    if (hit.length === 1) return connect(hit[0]);
    if (!hit.length) { console.error(`нет машины по запросу "${arg}". Доступны: ${list.map((m) => m.id).join(', ')}`); process.exit(1); }
    console.error(`"${arg}" подходит нескольким: ${hit.map((m) => m.id).join(', ')} — уточни`);
    process.exit(1);
  }

  console.log(`\nФлот (ты на ${SELF})${live === null ? '  · presence недоступен, статус не показан' : ''}:\n`);
  list.forEach((m, i) => {
    const addr = m.ssh || '— адрес не задан —';
    console.log(`  ${String(i + 1).padStart(2)}. ${mark(m.id)} ${m.id.padEnd(20)} ${addr.padEnd(34)} ${m.note || ''}`);
  });
  if (arg === '--list') return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('\nНомер или имя (Enter — выход): ', res));
  rl.close();
  const s = String(ans).trim();
  if (!s) return;
  const byNum = /^\d+$/.test(s) ? list[+s - 1] : null;
  const byName = list.find((m) => m.id.toLowerCase().includes(s.toLowerCase()));
  const pick = byNum || byName;
  if (!pick) { console.error('не понял выбор'); process.exit(1); }
  connect(pick);
})();
