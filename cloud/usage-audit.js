#!/usr/bin/env node
// Считает РЕАЛЬНОЕ потребление токенов из логов Claude Code и переводит его
// в деньги по тарифам API — чтобы сравнить безлимитную подписку со счётчиком.
// Читаем построчно: файлы большие, целиком в память не влезут.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = 'C:/Users/makei/.claude/projects';

// $/1M токенов. Кэш читается сильно дешевле обычного входа — это и делает
// длинные сессии Claude Code в разы дешевле наивной оценки «вход × цена».
const RATES = {
  opus:   { in: 15,  out: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  sonnet: { in: 3,   out: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  haiku:  { in: 0.80, out: 4,  cacheWrite: 1.00,  cacheRead: 0.08 },
};
function rateFor(model = '') {
  const m = model.toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return RATES.opus;
  if (m.includes('haiku')) return RATES.haiku;
  return RATES.sonnet;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

(async () => {
  const files = walk(ROOT);
  const byDay = new Map();   // YYYY-MM-DD -> {in,out,cw,cr,cost}
  const byModel = new Map(); // модель -> {in,out,cw,cr,cost,calls}
  let lines = 0, withUsage = 0;

  for (const f of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(f, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lines++;
      if (!line || line.indexOf('"usage"') === -1) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const u = j.message && j.message.usage;
      if (!u) continue;
      withUsage++;

      const model = (j.message && j.message.model) || 'неизвестно';
      const r = rateFor(model);
      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const cost =
        (inp * r.in + out * r.out + cw * r.cacheWrite + cr * r.cacheRead) / 1e6;

      const day = (j.timestamp || '').slice(0, 10) || 'без даты';
      for (const [map, key] of [[byDay, day], [byModel, model]]) {
        const a = map.get(key) || { in: 0, out: 0, cw: 0, cr: 0, cost: 0, calls: 0 };
        a.in += inp; a.out += out; a.cw += cw; a.cr += cr; a.cost += cost; a.calls++;
        map.set(key, a);
      }
    }
  }

  const M = (n) => (n / 1e6).toFixed(2) + 'M';
  const $ = (n) => '$' + n.toFixed(2);

  console.log(`Файлов: ${files.length} | строк: ${lines} | записей с расходом: ${withUsage}\n`);

  const days = [...byDay.entries()].filter(([d]) => d !== 'без даты').sort();
  if (!days.length) { console.log('Записей с датой нет.'); return; }

  console.log('=== ПО ДНЯМ ===');
  console.log('дата         вход    кэш-зап  кэш-чт   выход   стоимость по API');
  let total = { in: 0, out: 0, cw: 0, cr: 0, cost: 0 };
  for (const [d, a] of days) {
    console.log(
      d.padEnd(12),
      M(a.in).padStart(7), M(a.cw).padStart(8), M(a.cr).padStart(8),
      M(a.out).padStart(7), $(a.cost).padStart(10));
    for (const k of Object.keys(total)) total[k] += a[k];
  }

  console.log('\n=== ПО МОДЕЛЯМ ===');
  for (const [m, a] of [...byModel.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
    console.log(`  ${m.padEnd(34)} ${String(a.calls).padStart(6)} вызовов  ${$(a.cost).padStart(10)}`);
  }

  const span = days.length;
  const first = days[0][0], last = days[days.length - 1][0];
  const spanDays = Math.max(1, (new Date(last) - new Date(first)) / 86400000 + 1);

  console.log('\n=== ИТОГ ===');
  console.log(`Период: ${first} … ${last} (${spanDays.toFixed(0)} дн., активных ${span})`);
  console.log(`Вход ${M(total.in)} | запись кэша ${M(total.cw)} | чтение кэша ${M(total.cr)} | выход ${M(total.out)}`);
  console.log(`Всего токенов: ${M(total.in + total.cw + total.cr + total.out)}`);
  console.log(`\nПо тарифам API это стоило бы: ${$(total.cost)}`);
  console.log(`В пересчёте на 30 дней:        ${$(total.cost / spanDays * 30)}`);
})();
