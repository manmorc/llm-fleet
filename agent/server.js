// Подъём локальной модели ПО ТРЕБОВАНИЮ (llama-server с gpt-oss-20b).
// Зачем: модель боевая везде (чат, агент, воркер), но держать её в VRAM в простое не нужно —
// первый вызов поднимает сервер (~9 с), дальше он тёплый, idle-watchdog гасит через 4 мин простоя.
//
// МОДЕЛЬ: gpt-oss-20b в РОДНОМ формате MXFP4 (11.3 ГБ) — не пережатие, модель так и обучена.
// Замерено против gemma-4-26b на одних задачах (agent/bench-compare.js, 2026-07-25):
//   качество — ПАРИТЕТ (обе берут многошаговый счёт и скепсис к «слишком хорошим» цифрам)
//   скорость — 107 t/s против 40 t/s, суммарно 40 с против 141 с (в 3.5 раза быстрее)
// Причина скачка: гемма (15.6 ГБ) НЕ влезала в 12 ГБ VRAM → часть экспертов жила в RAM, и обращение
// к ним по PCIe было главным тормозом. gpt-oss влезает ЦЕЛИКОМ в видеопамять.
//
// Пресет замерен здесь же (RTX 4070 Ti 12 ГБ):
//   -ngl 99 --n-cpu-moe 2 -c 16384 → 11158 МБ / 97-107 t/s, запас VRAM ~840 МБ (рабочий стол тоже ест)
//   без --n-cpu-moe и с ctx 32k влезает, но запас всего 58 МБ — рискованно, ловили впритык.
// ⚠️ Контекст 16k против 131k у геммы: полный контекст в VRAM вместе с моделью не помещается.
//   Для чата/тиков/parseSignal хватает; для длинных документов — вернуть гемму (см. откат ниже).
// ОТКАТ на гемму одной строкой в ~/.agent-bus/fleet.env:
//   LLAMA_ALIAS=gemma26b, LLAMA_MODEL_FILE=<путь к gemma gguf>, LLAMA_N_CPU_MOE=24, LLAMA_CTX=131072
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.LLAMA_PORT || '8081';
const BASE = `http://127.0.0.1:${PORT}`;
const ALIAS = process.env.LLAMA_ALIAS || 'gpt-oss';
const EXE = process.env.LLAMA_EXE || path.join(os.homedir(), 'tools', 'llama.cpp-b10046', 'llama-server.exe');
const MODEL_FILE = process.env.LLAMA_MODEL_FILE || path.join(os.homedir(), '.lmstudio', 'models',
  'ggml-org', 'gpt-oss-20b-GGUF', 'gpt-oss-20b-MXFP4.gguf');
// КОНТЕКСТ 128k — полный, на который обучена gpt-oss-20b. Замер 31.07.2026 (agent/bench-ctx.js):
//   16k  n-cpu-moe=2  KV f16   → 11372/12282 МБ, 91 t/s
//   64k  n-cpu-moe=4  KV q8_0  → 11032/12282 МБ, 75 t/s
//   128k n-cpu-moe=6  KV q8_0  → 11198/12282 МБ, 62 t/s   ← выбрано
//   128k n-cpu-moe=12 KV q8_0  →  8770/12282 МБ, 31 t/s   (лишний вынос в RAM бьёт вдвое, не нужен)
// Размен: ~30% скорости за 8× контекста. Приоритет владельца — качество работы, не токены в секунду
// («в пределах разумного по времени»), а на 16k агент не мог удержать даже два файла этого проекта.
// Вернуть скорость: LLAMA_CTX=16384 LLAMA_N_CPU_MOE=2 LLAMA_KV_TYPE=f16.
const NCPUMOE = process.env.LLAMA_N_CPU_MOE || '6';
const CTX = process.env.LLAMA_CTX || '131072';
const KVTYPE = process.env.LLAMA_KV_TYPE || 'q8_0';   // квантование KV-кэша: вдвое меньше VRAM на тот же контекст
const AUTOSTART = process.env.LLAMA_AUTOSTART !== '0';   // 0 = не поднимать самим (CI/чужая машина)
// Файл «последней активности» — ОБЩИЙ между процессами (воркер/агент/чат пишут, watchdog читает).
// Так простой детектируется надёжно: ensure() зовётся перед КАЖДЫМ запросом → штамп не пропустит ни один.
const ACTIVITY_FILE = process.env.LLAMA_ACTIVITY_FILE || path.join(os.homedir(), '.agent-bus', 'llama.active');
// Lock загрузки: пока он свежий, watchdog НЕ гасит модель. Закрывает гонку «taskkill /IM убивает
// llama-server, который потребитель СЕЙЧАС спавнит под запрос» → та самая «умер при загрузке» на границе часа.
const LOCK_FILE = process.env.LLAMA_LOCK_FILE || path.join(os.homedir(), '.agent-bus', 'llama.loading');
// stderr llama-server (перезаписывается на каждый спавн) — чтобы смерть при загрузке была ДИАГНОСТИРУЕМА,
// а не проглочена stdio:'ignore' (из-за чего первопричину инцидента 05:00 пришлось воспроизводить вручную).
const SERVER_LOG = process.env.LLAMA_SERVER_LOG || path.join(os.homedir(), '.agent-bus', 'llama-server.err.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function touchActivity() { try { fs.writeFileSync(ACTIVITY_FILE, String(Date.now())); } catch (_) {} }
function lastActivity() { try { return parseInt(fs.readFileSync(ACTIVITY_FILE, 'utf8'), 10) || 0; } catch (_) { return 0; } }
function setLock() { try { fs.writeFileSync(LOCK_FILE, String(Date.now())); } catch (_) {} }
function clearLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }
// Идёт ли загрузка прямо сейчас (lock свежий)? Watchdog проверяет ПЕРЕД stop().
function loadingInProgress(maxAgeMs = 180000) { try { return Date.now() - (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) || 0) < maxAgeMs; } catch (_) { return false; } }

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

// Счётчик обработанных задач САМОГО llama-server (max id_task по слотам, монотонно растёт).
// ЗАЧЕМ: файл llama.active обновляет только ensure(), т.е. запросы, идущие через НАШ Node-код.
// Но встроенный веб-чат llama.cpp (его открывает десктопный ярлык!) и любой прямой клиент бьют
// в :8081 НАПРЯМУЮ — мимо ensure(). Watchdog видел «простой N мин» и убивал модель ПОСРЕДИ
// разговора владельца; тот перезапускал ярлык, и цикл повторялся («постоянно отваливалась»).
// Этот счётчик ловит активность на уровне СЕРВЕРА — любой путь, включая встроенный UI.
async function taskCounter() {
  try {
    const res = await fetch(`${BASE}/slots`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const slots = await res.json();
    if (!Array.isArray(slots)) return null;
    return Math.max(0, ...slots.map((s) => (s && s.id_task) || 0));
  } catch (_) { return null; }
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
    // mmap (по умолчанию) вместо --no-mmap: критично для idle-выгрузки. При --no-mmap вес модели —
    // анонимная/залоченная под GPU host-память; жёсткий taskkill /F watchdog'а НЕ отдаёт её драйверу
    // → утечка ~16 ГБ RAM за цикл (замерено). С mmap вес — file-backed страницы (page cache), ОС
    // освобождает их чисто при ЛЮБОМ убийстве. Цена: ~18% скорости. Для машины 32 ГБ, которую делят
    // с работой владельца, RAM важнее. Вернуть скорость (ценой утечки при выгрузке): LLAMA_NO_MMAP=1.
    // -fa on + KV q8_0 — то, чем оплачен переход с 16k на 128k: flash-attention и квантование
    // KV-кэша вдвое снижают его вес, иначе 128k в 12 ГБ видеопамяти не влезает вовсе.
    const args = ['-m', MODEL_FILE, '--n-cpu-moe', NCPUMOE, '-ngl', '99', '-c', CTX,
      '-fa', 'on', '-ctk', KVTYPE, '-ctv', KVTYPE,
      '--host', '127.0.0.1', '--port', PORT, '-a', ALIAS, '--jinja'];
    if (process.env.LLAMA_NO_MMAP === '1') args.splice(4, 0, '--no-mmap');
    // Ретрай: если процесс умер на загрузке (напр. чужой taskkill /IM зацепил наш спавн в гонке),
    // пробуем ещё раз, а не роняем запрос. Обновляем lock всю загрузку — watchdog не тронет.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      setLock();
      log(`поднимаю ${ALIAS} (n-cpu-moe=${NCPUMOE}, ctx=${CTX})… попытка ${attempt}, ~15 с`);
      let errFd; try { errFd = fs.openSync(SERVER_LOG, 'w'); } catch (_) { errFd = 'ignore'; }
      const p = spawn(EXE, args, { detached: true, stdio: ['ignore', errFd, errFd], windowsHide: true });
      let spawnErr = null;
      p.on('error', (e) => { spawnErr = e; });   // иначе async-сбой spawn = uncaught = падает весь процесс
      serverPid = p.pid;
      p.unref();
      try { if (typeof errFd === 'number') fs.closeSync(errFd); } catch (_) {}
      let died = false;
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        setLock();   // держим lock свежим всю загрузку (иначе watchdog решит, что простой, и убьёт)
        if (spawnErr) { lastErr = new Error(`spawn: ${spawnErr.message}`); died = true; break; }
        if (!pidAlive(serverPid)) { lastErr = new Error('llama-server умер при загрузке'); died = true; break; }
        if (await probe()) { log(`${ALIAS} готова за ~${(i + 1) * 2} с (попытка ${attempt})`); return true; }
      }
      if (!died) { lastErr = new Error('llama-server не поднялся за 120 с'); break; } // таймаут — не ретраим
      await sleep(2000); // дать VRAM освободиться перед повтором
    }
    // приложим хвост stderr llama-server — чтобы причина смерти была видна сразу
    let tail = ''; try { tail = fs.readFileSync(SERVER_LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '); } catch (_) {}
    throw new Error(`${lastErr ? lastErr.message : 'load fail'}${tail ? ' :: llama: ' + tail : ''}`);
  })().finally(() => { inFlight = null; clearLock(); });
  return inFlight;
}

function stop() {
  try { execSync('taskkill /F /IM llama-server.exe', { stdio: 'ignore', windowsHide: true }); serverPid = null; return true; }
  catch (_) { return false; }
}

module.exports = { ensure, probe, stop, slotsBusy, taskCounter, lastActivity, touchActivity, loadingInProgress, BASE, ALIAS };
