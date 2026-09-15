#!/usr/bin/env node
// Сторож персистера шины: держит agent-bus-<NODE_ID> живым и ПРОВЕРЯЕТ, что канал реально носит.
// Запускается заданием планировщика каждые 10 минут (и при логоне). Идемпотентен: если всё живо —
// ничего не делает и молчит.
//
// ЗАЧЕМ ОН ЕСТЬ (сбой 04–15.09.2026, 11 дней тишины на шине).
// Персистер не поднялся после перезагрузки, и владелец узнал об этом только когда хаб пожаловался.
// Корневая причина оказалась не в персистере: задание `pm2-resurrect-fleet` вызывало `pm2 resurrect`,
// а тот поднимает РОВНО содержимое ~/.pm2/dump.pm2. В дампе от 09.09 лежал один diary-rag — кто-то
// сделал `pm2 save` в момент, когда флотские процессы были погашены, и дамп закрепил поломку
// навсегда. Задание при этом отрабатывало с кодом 0: «команда ушла» ≠ «эффект наступил».
// Поэтому здесь источник истины — ecosystem.config.js из репозитория, а не изменяемый дамп.
//
// ДВА РАЗНЫХ ОТКАЗА, и оба надо ловить:
//  1) процесса нет / он не online              → лечится pm2 start (быстро, каждый запуск);
//  2) процесс online, но канал не носит        → видно ТОЛЬКО сквозной пробой. Тишина в логе
//     неотличима от «сообщений не было», поэтому раз в час гоняем своё сообщение через настоящий
//     Redis и ждём его в настоящем логе. Не прошло — перезапуск и повторная проба.
//
// ENV: FLEET_NODE_ID / REDIS_URL (иначе берутся из ~/.agent-bus/fleet.env)
// Ключи: --probe принудительно гонит сквозную пробу, --quiet глушит вывод при успехе.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const IORedis = require('ioredis');

const REPO = path.join(__dirname, '..');
const HOME = os.homedir();
const STATE = path.join(HOME, '.agent-bus', 'bus-ensure.state.json');
const PROBE_EVERY_MS = 60 * 60 * 1000;   // сквозная проба раз в час
const PROBE_WAIT_MS = 20000;             // сколько ждём пробу в логе

const argv = process.argv.slice(2);
const FORCE_PROBE = argv.includes('--probe');
const QUIET = argv.includes('--quiet');
const LOCK = path.join(HOME, '.agent-bus', 'bus-ensure.lock');
const LOCK_STALE_MS = 5 * 60 * 1000;   // ExecutionTimeLimit задания — 5 минут; дольше лок жить не может

function localEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(HOME, '.agent-bus', 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}
const L = localEnv();
const NODE_ID = process.env.FLEET_NODE_ID || L.FLEET_NODE_ID || 'desktop-tt4i69c';
const REDIS_URL = process.env.REDIS_URL || L.REDIS_URL || '';
const APP = `agent-bus-${NODE_ID}`;
const KEY = `agents:inbox:${NODE_ID}`;
const LOG = path.join(HOME, '.agent-bus', NODE_ID + '.log');

const log = (...a) => { if (!QUIET) console.log(new Date().toISOString(), ...a); };
const warn = (...a) => console.error(new Date().toISOString(), ...a);

// pm2 на Windows — это pm2.cmd; execFileSync не запускает .cmd без shell, поэтому зовём через него.
function pm2(args) {
  return execFileSync('pm2', args, { cwd: REPO, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// pm2 jlist отдаёт JSON с дублирующимися ключами окружения (username/USERNAME) — JSON.parse это
// переживает (последний выигрывает), в отличие от ConvertFrom-Json в PowerShell.
function status() {
  try {
    const apps = JSON.parse(pm2(['jlist']));
    const a = apps.find((x) => x.name === APP);
    return a ? (a.pm2_env && a.pm2_env.status) || 'unknown' : 'missing';
  } catch (e) {
    warn('[ensure] pm2 jlist не прочитан:', e.message);
    return 'unknown';
  }
}

function start() {
  // --only берёт ровно одну запись из ecosystem.config.js: секрет REDIS_URL и AGENT_ID подставит он,
  // а ручной `pm2 start mcp/agent-bus.persist.js` их потеряет и уйдёт слушать очередь с именем хоста
  // (на этой машине — В ВЕРХНЕМ РЕГИСТРЕ, а Redis к регистру чувствителен: молча не та очередь).
  log('[ensure] поднимаю', APP);
  try { pm2(['start', 'ecosystem.config.js', '--only', APP]); return true; }
  catch (e) { warn('[ensure] pm2 start не удался:', e.message); return false; }
}

function restart() {
  log('[ensure] перезапускаю', APP);
  try { pm2(['restart', APP]); return true; }
  catch (e) { warn('[ensure] pm2 restart не удался:', e.message); return false; }
}

// Одна физическая строка — как и у персистера: любой строчный читатель (tail|grep, Monitor) берёт
// строку целиком, а не первый её кусок.
function alertToLog(text) {
  const line = `⚠ BUS-ENSURE ALERT ${new Date().toISOString()}: ${String(text).replace(/\r?\n/g, ' ⏎ ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { warn('[ensure] alert не записан:', e.message); }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (e) { warn('[ensure] state не записан:', e.message); }
}

// Сквозная проба: кладём сообщение в НАСТОЯЩУЮ очередь и ждём его в НАСТОЯЩЕМ логе.
// Проверяем весь путь целиком — Redis, BLPOP-цикл, запись файла. Метка уникальна, чтобы не спутать
// с чужой строкой и не засчитать успех по старому хвосту лога.
async function probe() {
  if (!REDIS_URL) { warn('[ensure] нет REDIS_URL — пробу не гоняю'); return { ok: false, reason: 'no-redis-url' }; }
  const mark = 'probe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const from = Number(fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
  const r = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 10000, lazyConnect: true });
  r.on('error', () => {});
  try {
    await r.connect();
    await r.rpush(KEY, JSON.stringify({
      from: 'bus-selftest',
      text: `BUS SELFTEST ${mark} — служебная проба живости канала, не сообщение агента (bin/bus-ensure.js)`,
    }));
  } catch (e) {
    try { r.disconnect(); } catch (_) {}
    // Хаб недоступен — это НЕ поломка нашего персистера, и перезапуском не лечится (так было
    // 04.09.2026: часы ETIMEDOUT к Redis через tailscale при совершенно живом процессе).
    // Разводим диагнозы: лечить будем только то, что в нашей власти.
    warn('[ensure] хаб недоступен:', e.message);
    return { ok: false, hubDown: true, reason: 'хаб недоступен: ' + e.message };
  }
  try { r.disconnect(); } catch (_) {}

  const deadline = Date.now() + PROBE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    let tail = '';
    try {
      const size = fs.statSync(LOG).size;
      if (size > from) {
        const fd = fs.openSync(LOG, 'r');
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
        tail = buf.toString('utf8');
      }
    } catch (_) {}
    if (tail.includes(mark)) return { ok: true };
  }
  return { ok: false, reason: 'не дошло за ' + (PROBE_WAIT_MS / 1000) + 'с' };
}

// Одновременный запуск двух сторожей — не теория: 15.09.2026 плановый тик наложился на ручной
// прогон, оба прочитали один и тот же устаревший lastProbe и оба погнали пробу (две строки в логе
// шины с разницей в 5 секунд). Безобидно, пока это лишний шум; опасно, когда оба одновременно
// решат перезапустить персистер. Лок атомарный ('wx' — создать или упасть), с протуханием, иначе
// один убитый процесс заблокировал бы сторожа навсегда.
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') { warn('[ensure] лок не создан:', e.message); return true; } // не запираться из-за FS
      let age = Infinity;
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch (_) {}
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(LOCK); continue; } catch (_) {} }
      return false;
    }
  }
  return false;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch (_) {} };

(async () => {
  if (!acquireLock()) { log('[ensure] другой экземпляр уже работает — выхожу'); return; }
  process.on('exit', releaseLock);
  let st = status();
  if (st !== 'online') {
    warn('[ensure] статус', APP, '=', st);
    start();
    await new Promise((r) => setTimeout(r, 4000));
    st = status();
    if (st !== 'online') {
      warn('[ensure] ПОДНЯТЬ НЕ УДАЛОСЬ, статус:', st);
      writeState({ ...readState(), lastCheck: new Date().toISOString(), status: st, alert: 'start-failed' });
      process.exit(1);
    }
    log('[ensure]', APP, 'поднят');
  }

  const state = readState();
  const due = FORCE_PROBE || !state.lastProbe || (Date.now() - Date.parse(state.lastProbe) > PROBE_EVERY_MS);
  if (!due) {
    // alert НЕ сбрасываем: снять его вправе только успешная проба. Тик, который пробу не гонял,
    // ничего о канале не знает — а затирал бы чужой диагноз (поймано на себе 15.09.2026: тик по
    // расписанию наложился на ручной прогон и через полсекунды стёр его alert в null).
    writeState({ ...state, lastCheck: new Date().toISOString(), status: st });
    log('[ensure] online, проба не по расписанию');
    return;
  }

  let p = await probe();
  if (!p.ok && !p.hubDown) {
    // Процесс числится online, но канал молчит — ровно тот отказ, который не видно по pm2.
    warn('[ensure] СКВОЗНАЯ ПРОБА НЕ ПРОШЛА:', p.reason, '— перезапускаю и пробую снова');
    restart();
    await new Promise((r) => setTimeout(r, 5000));
    p = await probe();
  }
  writeState({
    lastCheck: new Date().toISOString(),
    lastProbe: new Date().toISOString(),
    status: status(),
    probeOk: p.ok,
    alert: p.ok ? null : (p.hubDown ? 'hub-unreachable: ' : 'probe-failed: ') + p.reason,
  });
  if (!p.ok) {
    // Владельца за машиной может не быть, а state-файл сам себя не прочитает. Пишем строку в САМ лог
    // шины: её подхватит Monitor живой Claude-сессии — тот же канал, которым приходят сообщения.
    // Если сессии нет, строка всё равно останется в durable-логе и будет видна при следующем заходе.
    alertToLog(p.hubDown
      ? `хаб недоступен, канал не носит (${p.reason}). Персистер жив, лечить нечего — ждём хаб.`
      : `КАНАЛ НЕ НОСИТ ДАЖЕ ПОСЛЕ ПЕРЕЗАПУСКА (${p.reason}). Входящие сейчас теряются.`);
    warn('[ensure] alert записан в лог шины:', p.reason);
    process.exit(p.hubDown ? 4 : 2);
  }
  log('[ensure] сквозная проба прошла');
})().catch((e) => { warn('[ensure] упал:', e && e.stack || e); process.exit(3); });
