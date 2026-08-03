#!/usr/bin/env node
// УДЕРЖАНИЕ ОТ СНА НА ВРЕМЯ РАБОТЫ.
//
// Задача владельца: пока нода работает — машина не засыпает; как только работа кончилась —
// начинает тикать обычный таймер сна Windows, и машина уходит спать. Разбудить её потом можно
// адресным пакетом с always-on ноды (linux-prestige живёт в той же локальной сети, 192.168.1.31).
//
// ПОЧЕМУ НЕ «ОТКЛЮЧИТЬ СОН СОВСЕМ». Так и было — SCHEME: сон «никогда». Машина не спала никогда,
// то есть 12 ГБ видеопамяти и вся система висели впустую сутками. Правильно наоборот: таймер сна
// ВКЛЮЧЁН, а работа его придерживает.
//
// КАК ДЕРЖИМ. SetThreadExecutionState(ES_SYSTEM_REQUIRED) сбрасывает счётчик простоя Windows.
// Вызываем его периодически, пока есть работа. Флага ES_CONTINUOUS НЕ ставим намеренно: он держит
// систему бодрой до явной отмены, и если процесс упадёт — машина не заснёт уже никогда, и никто
// этого не заметит. Периодический сброс безопаснее: умер держатель → таймер пошёл сам.
//
// ЧТО СЧИТАЕТСЯ РАБОТОЙ (любое из):
//   • llama-server занят генерацией (есть занятые слоты);
//   • в очереди BullMQ есть невыполненные задачи;
//   • недавняя активность на шине (свежая запись в логе входящих);
//   • пользователь явно попросил не спать (файл-флаг, ставится ярлыком).
// Модель, просто ЗАГРУЖЕННАЯ в память, работой НЕ считается — иначе машина не заснёт никогда,
// ведь выгрузка происходит по простою, а простоя не будет.
//
// Запуск: pm2 start ecosystem.config.js --only keep-awake   |   node agent/keep-awake.js --once
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(os.homedir(), '.agent-bus');
const HOLD_FLAG = path.join(DIR, 'keep-awake');          // ручное удержание (ярлык)
const BUS_LOG = path.join(DIR, `${process.env.FLEET_NODE_ID || 'desktop-tt4i69c'}.log`);
const STATE = path.join(DIR, 'keep-awake.state');
const TICK_MS = parseInt(process.env.KEEPAWAKE_TICK_MS || String(60 * 1000), 10);
const BUS_IDLE_MS = parseInt(process.env.KEEPAWAKE_BUS_IDLE_MS || String(10 * 60 * 1000), 10);
const LLAMA = process.env.LLAMA_URL || 'http://127.0.0.1:8081';

const log = (m) => console.log(`${new Date().toISOString()} [keep-awake] ${m}`);

// Один сброс счётчика простоя. Без ES_CONTINUOUS — см. комментарий выше.
function poke() {
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$s=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);' -Name P -Namespace W -PassThru; $s::SetThreadExecutionState(0x00000001) | Out-Null"],
      { timeout: 15000, stdio: 'ignore', windowsHide: true });
    return true;
  } catch (_) { return false; }
}

async function busy() {
  const why = [];
  // 1. Модель реально считает (не «загружена», а занята).
  try {
    const r = await fetch(`${LLAMA}/slots`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const slots = await r.json();
      const n = slots.filter((s) => s && s.is_processing).length;
      if (n) why.push(`модель считает (${n} слот(ов))`);
    }
  } catch (_) {}
  // 2. Очередь флота не пуста — задачи ждут или выполняются.
  try {
    const IORedis = require(path.join(__dirname, '..', 'node_modules', 'ioredis'));
    let url = process.env.REDIS_URL;
    if (!url) for (const l of fs.readFileSync(path.join(DIR, 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*REDIS_URL\s*=\s*(.+?)\s*$/); if (m) url = m[1];
    }
    if (url) {
      const r = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: () => null });
      r.on('error', () => {});
      const wait = await r.llen('bull:fast:wait').catch(() => 0);
      const act = await r.llen('bull:fast:active').catch(() => 0);
      if (wait + act > 0) why.push(`очередь: ${wait} ждут, ${act} в работе`);
      await r.quit().catch(() => r.disconnect());
    }
  } catch (_) {}
  // 3. Свежая активность на шине — идёт разговор, спать рано.
  try {
    const age = Date.now() - fs.statSync(BUS_LOG).mtimeMs;
    if (age < BUS_IDLE_MS) why.push(`шина активна (${Math.round(age / 60000)} мин назад)`);
  } catch (_) {}
  // 4. Ручное удержание владельцем.
  if (fs.existsSync(HOLD_FLAG)) why.push('ручное удержание (файл-флаг)');
  return why;
}

(async () => {
  const once = process.argv.includes('--once');
  log(`старт · тик ${TICK_MS / 1000}с · порог тишины шины ${BUS_IDLE_MS / 60000} мин`);
  for (;;) {
    const why = await busy();
    if (why.length) {
      const ok = poke();
      try { fs.writeFileSync(STATE, JSON.stringify({ holding: true, why, at: new Date().toISOString() }, null, 2)); } catch (_) {}
      log(`${ok ? 'держу' : '⚠ не смог сбросить таймер'}: ${why.join(' · ')}`);
    } else {
      try { fs.writeFileSync(STATE, JSON.stringify({ holding: false, at: new Date().toISOString() }, null, 2)); } catch (_) {}
      log('работы нет — отпускаю, таймер сна Windows тикает сам');
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
})();
