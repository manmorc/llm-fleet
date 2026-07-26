#!/usr/bin/env node
// Суточный отчёт ноды в Telegram — в ЕДИНОМ формате флота (как у остальных агентов).
// Считает по фактам (pm2-логи, очередь BullMQ), а не по ощущениям.
//
// Запуск:
//   node agent/daily-report.js            — отправить отчёт
//   node agent/daily-report.js --dry      — показать в консоли, НЕ отправлять (проверка)
//
// По расписанию (Планировщик Windows, раз в сутки — НЕ зовёт Claude, лимиты не тратит, PRINCIPLES §9):
//   schtasks /create /tn "fleet-daily-report" /tr "node C:\Users\makei\llm-fleet\agent\daily-report.js" /sc daily /st 21:00
const { execSync } = require('child_process');
const { notify, configured } = require('./notify');

const DRY = process.argv.includes('--dry');
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return ''; } };

// Сколько задач воркер отработал/завалил за сутки (по его же pm2-логу).
function workerStats() {
  const out = sh('pm2 logs llm-worker-desktop-tt4i69c --lines 2000 --nostream');
  const today = new Date().toISOString().slice(0, 10);
  const lines = out.split(/\r?\n/).filter((l) => l.includes(today));
  return {
    done: lines.filter((l) => l.includes('[done]')).length,
    fail: lines.filter((l) => l.includes('[fail]')).length,
  };
}

// Все ли процессы ноды живы.
function pm2Health() {
  const out = sh('pm2 jlist');
  try {
    const apps = JSON.parse(out);
    const bad = apps.filter((a) => a.pm2_env.status !== 'online').map((a) => a.name);
    return { total: apps.length, bad };
  } catch (_) { return { total: 0, bad: ['pm2 не отвечает'] }; }
}

// Сколько раз модель выгружалась за сутки (idle-watchdog работает?).
function unloads() {
  const out = sh('pm2 logs llama-watchdog --lines 2000 --nostream');
  const today = new Date().toISOString().slice(0, 10);
  return out.split(/\r?\n/).filter((l) => l.includes(today) && /гашу llama-server/.test(l)).length;
}

(async () => {
  const w = workerStats();
  const h = pm2Health();
  const u = unloads();

  // ПОРОГ ТРЕВОГИ. Раньше 🔴 ставился на ЛЮБОЙ единичный сбой — и первый же отчёт закричал
  // «ошибка» из-за одного `fetch failed`, который был моим собственным перезапуском модели
  // (101 задача, 1 сбой = 99% успеха, все процессы живы). Так уведомления быстро приучают
  // себя игнорировать — а тогда пропустится настоящая авария.
  // Красный — только на то, что требует ДЕЙСТВИЯ:
  //   • процесс лежит (это всегда чинить), либо
  //   • сбоев ≥5 за сутки, либо доля сбоев >10% (значит ломается систематически, а не разово).
  const total = w.done + w.fail;
  const rate = total ? w.fail / total : 0;
  const processDown = h.bad.length > 0;
  const systematic = w.fail >= 5 || (rate > 0.1 && w.fail > 1);
  const ok = !processDown && !systematic;

  // Формат флота требует коротких строк (≤6 слов) — укладываемся в них.
  const topic = 'сводка ноды за сутки';
  const result = processDown
    ? `упал ${h.bad[0]}, задач ${w.done}`
    : systematic
      ? `сбоев ${w.fail} из ${total} — систематически`
      : `задач ${w.done}, сбоев ${w.fail}, выгрузок ${u}`;

  if (DRY || !configured()) {
    console.log(`🤖 АГЕНТ · desktop-local · desktop-tt4i69c · ${ok ? '🟢 готово' : '🔴 ошибка'}`);
    console.log(`🗂 ${topic}`);
    console.log(`📝 ${result}`);
    if (!configured()) console.log('\n⚠ ТГ-креды не заданы (~/.tg/tg.env) — отправка пропущена');
    process.exit(0);
  }

  const sent = await notify({ topic, result, ok });
  console.log(sent ? '✅ отчёт отправлен в ТГ' : '❌ не отправлен');
})();
