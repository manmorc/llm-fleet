#!/usr/bin/env node
// ЗАМЕР КОНТЕКСТА: что реально влезает в 12 ГБ VRAM и какой ценой по скорости.
// Вопрос владельца 31.07.2026: «мы повышали контекст до 120к, почему стал 16к — нужно вернуть».
// Контекст был урезан мной при переезде gemma→gpt-oss ради скорости; владелец приоритет назвал
// иначе («гонюсь за лучшим результатом, а не за скоростью»), значит размен надо перемерить.
//
// РЫЧАГИ: -c (контекст), --n-cpu-moe N (эксперты N слоёв в RAM, освобождает VRAM ценой скорости),
// -ctk/-ctv q8_0 (квантование KV-кэша — вдвое меньше памяти на тот же контекст), -fa (flash-attn).
//
// Меряем ЧЕСТНО: влезло/нет, VRAM по nvidia-smi, скорость на фиксированном промпте.
// Запуск: node agent/bench-ctx.js
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const EXE = process.env.LLAMA_EXE || path.join(os.homedir(), 'tools', 'llama.cpp-b10046', 'llama-server.exe');
const MODEL = path.join(os.homedir(), '.lmstudio', 'models', 'ggml-org', 'gpt-oss-20b-GGUF', 'gpt-oss-20b-MXFP4.gguf');
const PORT = '8099';                      // отдельный порт: не мешаем боевому серверу на 8081
const BASE = `http://127.0.0.1:${PORT}`;

const CONFIGS = [
  { ctx: 16384,  moe: 2,  kv: 'f16',  label: 'текущий 16k' },
  { ctx: 32768,  moe: 2,  kv: 'f16',  label: '32k' },
  { ctx: 65536,  moe: 4,  kv: 'q8_0', label: '64k + KV q8' },
  { ctx: 131072, moe: 6,  kv: 'q8_0', label: '128k + KV q8' },
  { ctx: 131072, moe: 12, kv: 'q8_0', label: '128k + KV q8, больше в RAM' },
];

const log = (m) => console.log(`${new Date().toISOString()} [bench-ctx] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killServers() {
  try { execSync(`taskkill /F /IM llama-server.exe`, { stdio: 'ignore' }); } catch (_) {}
}
function vram() {
  try {
    const o = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { encoding: 'utf8' });
    const [used, total] = o.trim().split(',').map((x) => parseInt(x, 10));
    return { used, total };
  } catch (_) { return { used: -1, total: -1 }; }
}

async function ready(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch (_) {}
    await sleep(1500);
  }
  return false;
}

// Скорость на фиксированном промпте — сравнимо между конфигурациями.
async function speed() {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: 'bench', temperature: 0.7, max_tokens: 400,
      messages: [{ role: 'user', content: 'Объясни в 5 предложениях, чем отличается кэш процессора от оперативной памяти.' }] }),
  });
  const j = await r.json();
  const ms = Date.now() - t0;
  const tok = (j.usage && j.usage.completion_tokens) || 0;
  return { tps: tok ? +(tok / (ms / 1000)).toFixed(1) : 0, tok, ms };
}

(async () => {
  log(`модель: ${path.basename(MODEL)} · порт замера ${PORT}`);
  const rows = [];

  for (const c of CONFIGS) {
    killServers();
    await sleep(3000);
    const before = vram();

    const args = ['-m', MODEL, '--n-cpu-moe', String(c.moe), '-ngl', '99', '-c', String(c.ctx),
      '-fa', 'on', '-ctk', c.kv, '-ctv', c.kv,
      '--host', '127.0.0.1', '--port', PORT, '-a', 'bench', '--jinja'];

    log(`── ${c.label}: ctx=${c.ctx} n-cpu-moe=${c.moe} kv=${c.kv}`);
    const t0 = Date.now();
    const p = spawn(EXE, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();

    const up = await ready(180000);
    const loadSec = +((Date.now() - t0) / 1000).toFixed(1);
    if (!up) {
      log(`   ❌ НЕ ПОДНЯЛСЯ за 180с (скорее всего не хватило VRAM)`);
      rows.push({ ...c, ok: false, reason: 'не поднялся' });
      killServers(); await sleep(2000);
      continue;
    }

    const v = vram();
    let sp = { tps: 0 };
    try { sp = await speed(); } catch (e) { log(`   ⚠ замер скорости упал: ${e.message}`); }

    rows.push({ ...c, ok: true, loadSec, vramUsed: v.used, vramTotal: v.total, tps: sp.tps, tok: sp.tok });
    log(`   ✅ VRAM ${v.used}/${v.total} МБ · загрузка ${loadSec}с · ${sp.tps} t/s`);
    killServers(); await sleep(2000);
  }

  console.log('\n═══════ ИТОГ ═══════');
  console.log('конфигурация'.padEnd(32) + 'VRAM'.padEnd(14) + 'скорость'.padEnd(12) + 'загрузка');
  for (const r of rows) {
    if (!r.ok) { console.log(r.label.padEnd(32) + '— не поднялся —'); continue; }
    console.log(r.label.padEnd(32) + `${r.vramUsed}/${r.vramTotal}`.padEnd(14) + `${r.tps} t/s`.padEnd(12) + `${r.loadSec}с`);
  }
  require('fs').writeFileSync(path.join(__dirname, 'bench-results', 'ctx.json'), JSON.stringify(rows, null, 2));
  console.log('\nрезультат: agent/bench-results/ctx.json');
})();
