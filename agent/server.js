// Подъём локальной модели ПО ТРЕБОВАНИЮ (llama-server с gemma-4-26b).
// Зачем: модель теперь боевая везде (чат, агент, воркер), но держать 9.5 ГБ VRAM в простое не нужно.
// Первый же вызов поднимает сервер (~12-15 с), дальше он тёплый. Гасить — Gemma26B-stop.cmd.
//
// Пресеты замерены на этом железе (RTX 4070 Ti 12 ГБ), см. tools/moe-serve/BENCHMARK.md:
//   --n-cpu-moe 24 @131k → 9430 МБ / 43.7 t/s (цель ~9.5-10 ГБ: на карте ещё живёт рабочий стол)
//   --no-mmap даёт +18%; N ≥ 30 = no-op (у геммы ≤30 MoE-слоёв)
// Думалку НЕ ограничиваем (--reasoning-budget не задаём): свип доказал, что модель сама выбирает
// ~350 токенов, а любой потолок либо no-op, либо ломает (см. BENCHMARK.md).
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.LLAMA_PORT || '8081';
const BASE = `http://127.0.0.1:${PORT}`;
const ALIAS = process.env.LLAMA_ALIAS || 'gemma26b';
const EXE = process.env.LLAMA_EXE || path.join(os.homedir(), 'tools', 'llama.cpp-b10046', 'llama-server.exe');
const MODEL_FILE = process.env.LLAMA_MODEL_FILE || path.join(os.homedir(), '.lmstudio', 'models',
  'lmstudio-community', 'gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-Q4_K_M.gguf');
const NCPUMOE = process.env.LLAMA_N_CPU_MOE || '24';
const CTX = process.env.LLAMA_CTX || '131072';
const AUTOSTART = process.env.LLAMA_AUTOSTART !== '0';   // 0 = не поднимать самим (CI/чужая машина)
// Файл «последней активности» — ОБЩИЙ между процессами (воркер/агент/чат пишут, watchdog читает).
// Так простой детектируется надёжно: ensure() зовётся перед КАЖДЫМ запросом → штамп не пропустит ни один.
const ACTIVITY_FILE = process.env.LLAMA_ACTIVITY_FILE || path.join(os.homedir(), '.agent-bus', 'llama.active');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function touchActivity() { try { fs.writeFileSync(ACTIVITY_FILE, String(Date.now())); } catch (_) {} }
function lastActivity() { try { return parseInt(fs.readFileSync(ACTIVITY_FILE, 'utf8'), 10) || 0; } catch (_) { return 0; } }

// Занят ли сервер прямо сейчас (какой-то слот генерирует) — чтобы watchdog НЕ убил модель на лету.
// /slots доступен без флагов; is_processing:true = идёт генерация.
async function slotsBusy() {
  try {
    const res = await fetch(`${BASE}/slots`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const slots = await res.json();
    return Array.isArray(slots) && slots.some((s) => s && s.is_processing);
  } catch (_) { return false; }
}

// Готовность — ТОЛЬКО реальной генерацией. /v1/models отвечает ДО загрузки модели, а curl без -f
// возвращает 0 даже на 503 «Loading model» → обе проверки дают ложную «готовность» (BENCHMARK, грабли 3-4).
async function probe(timeoutMs = 8000) {
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl,
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
    return res.ok;
  } catch (_) { return false; }
}

// Жив ли КОНКРЕТНЫЙ pid (наш спавн), а не «любой llama-server.exe». Глобальный матч по имени образа
// маскировал смерть нашего процесса, если рядом есть чужой llama-server: fast-fail не срабатывал и
// мы ждали все 120 с вместо мгновенного падения.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', windowsHide: true });
    return new RegExp(`\\b${pid}\\b`).test(out);
  } catch (_) { return false; }
}

let inFlight = null;      // один подъём на процесс: параллельные вызовы ждут его же, а не плодят серверы
let serverPid = null;     // pid НАШЕГО llama-server (для точного fast-fail и защиты от дубль-спавна)

async function ensure({ log = () => {} } = {}) {
  touchActivity();   // любой запрос = активность (сброс idle-таймера watchdog'а), даже если модель уже тёплая
  if (await probe(4000)) return true;
  if (!AUTOSTART) throw new Error(`модель не отвечает на ${BASE} и LLAMA_AUTOSTART=0`);
  if (inFlight) return inFlight;
  // Сервер поднят нами и жив, но probe не ответил за 4 с → он ЗАГРУЖАЕТСЯ или ЗАНЯТ генерацией,
  // а не умер. Спавнить второй на тот же порт нельзя (не забиндится и умрёт) — ждём этот, дольше.
  if (pidAlive(serverPid)) {
    for (let i = 0; i < 30 && pidAlive(serverPid); i++) { if (await probe(8000)) return true; await sleep(1000); }
    if (await probe(8000)) return true;
  }
  inFlight = (async () => {
    if (!fs.existsSync(EXE)) throw new Error(`нет llama-server: ${EXE}`);
    if (!fs.existsSync(MODEL_FILE)) throw new Error(`нет файла модели: ${MODEL_FILE}`);
    log(`поднимаю ${ALIAS} (n-cpu-moe=${NCPUMOE}, ctx=${CTX})… первая загрузка ~15 с`);
    const args = ['-m', MODEL_FILE, '--n-cpu-moe', NCPUMOE, '--no-mmap', '-ngl', '99', '-c', CTX,
      '--host', '127.0.0.1', '--port', PORT, '-a', ALIAS, '--jinja'];
    const p = spawn(EXE, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // Без 'error'-листенера асинхронный сбой spawn (EACCES, AV-карантин .exe, битый бинарь) Node бросает
    // как uncaught → падает ВЕСЬ воркер/агент, а не только этот запрос. Ловим и превращаем в обычную ошибку.
    let spawnErr = null;
    p.on('error', (e) => { spawnErr = e; });
    serverPid = p.pid;
    p.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (spawnErr) throw new Error(`spawn llama-server не удался: ${spawnErr.message}`);
      // Дохлый ИМЕННО НАШ процесс — падаем сразу (по pid, не по имени образа).
      if (!pidAlive(serverPid)) throw new Error('llama-server умер при загрузке (проверь путь к модели / VRAM)');
      if (await probe()) { log(`${ALIAS} готова за ~${(i + 1) * 2} с`); return true; }
    }
    throw new Error('llama-server не поднялся за 120 с');
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function stop() {
  try { execSync('taskkill /F /IM llama-server.exe', { stdio: 'ignore', windowsHide: true }); serverPid = null; return true; }
  catch (_) { return false; }
}

module.exports = { ensure, probe, stop, slotsBusy, lastActivity, touchActivity, BASE, ALIAS };
