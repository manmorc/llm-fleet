#!/usr/bin/env node
// Разбор СТИЛЯ работы с Claude Code, а не просто суммы расхода.
// Вопрос, на который отвечаем: во что обходится привычка жить в длинных сессиях,
// и где именно утекают деньги — в чтении кэша, в его перезаписи или в выводе.
//
// Ключевая цена вопроса (Opus, $/1M):
//   чтение кэша  $1.50  — дёшево, это выгода длинной сессии
//   ЗАПИСЬ кэша $18.75  — в 12.5 раза дороже чтения; платится каждый раз,
//                         когда кэш протух или сломался
//   выход        $75
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = 'C:/Users/makei/.claude/projects';
const R = { in: 15, out: 75, cw: 18.75, cr: 1.50 }; // Opus, доминирует в логах

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

(async () => {
  const sessions = new Map(); // sessionId -> запись

  for (const f of walk(ROOT)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(f, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const u = j.message && j.message.usage;
      if (!u) continue;

      const sid = j.sessionId || path.basename(f, '.jsonl');
      let s = sessions.get(sid);
      if (!s) {
        s = { id: sid, file: path.basename(f), turns: 0, cw: 0, cr: 0, out: 0, inp: 0,
              first: null, last: null, ctx: [], gaps: [], cwAfterGap: 0, cwTotal: 0, prevTs: null };
        sessions.set(sid, s);
      }
      const ts = j.timestamp ? Date.parse(j.timestamp) : null;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;

      s.turns++;
      s.cw += cw; s.cr += cr;
      s.out += u.output_tokens || 0; s.inp += u.input_tokens || 0;
      // Размер живого контекста на этом шаге = всё, что модель прочитала на вход.
      s.ctx.push(cr + cw + (u.input_tokens || 0));

      if (ts) {
        if (s.first === null || ts < s.first) s.first = ts;
        if (s.last === null || ts > s.last) s.last = ts;
        if (s.prevTs !== null) {
          const gapMin = (ts - s.prevTs) / 60000;
          if (gapMin > 0.1) s.gaps.push(gapMin);
          // Перезапись кэша ПОСЛЕ долгой паузы — вероятнее всего протухший кэш,
          // а не смена контекста. Это та трата, которой могло не быть.
          if (gapMin > 5 && cw > 10000) s.cwAfterGap += cw;
        }
        s.prevTs = ts;
      }
      s.cwTotal += cw;
    }
  }

  const list = [...sessions.values()].filter((s) => s.turns > 0);
  const cost = (s) => (s.inp * R.in + s.out * R.out + s.cw * R.cw + s.cr * R.cr) / 1e6;
  for (const s of list) s.cost = cost(s);
  list.sort((a, b) => b.cost - a.cost);

  const M = (n) => (n / 1e6).toFixed(1) + 'M';
  const K = (n) => (n / 1e3).toFixed(0) + 'k';
  const $ = (n) => '$' + n.toFixed(0);

  const totalCost = list.reduce((a, s) => a + s.cost, 0);
  const totalTurns = list.reduce((a, s) => a + s.turns, 0);

  console.log(`Сессий: ${list.length} | шагов модели: ${totalTurns} | всего ${$(totalCost)}\n`);

  console.log('=== САМЫЕ ДОРОГИЕ СЕССИИ ===');
  console.log('шагов   длит.   средн.контекст  макс.контекст  зап.кэша  чтен.кэша  стоимость  $/шаг');
  for (const s of list.slice(0, 12)) {
    const hours = s.first && s.last ? (s.last - s.first) / 3600000 : 0;
    const avgCtx = s.ctx.reduce((a, b) => a + b, 0) / s.ctx.length;
    const maxCtx = Math.max(...s.ctx);
    console.log(
      String(s.turns).padStart(5),
      (hours.toFixed(1) + 'ч').padStart(7),
      K(avgCtx).padStart(15),
      K(maxCtx).padStart(14),
      M(s.cw).padStart(9),
      M(s.cr).padStart(10),
      $(s.cost).padStart(10),
      ('$' + (s.cost / s.turns).toFixed(2)).padStart(7));
  }

  console.log('\n=== КУДА УХОДЯТ ДЕНЬГИ ===');
  const T = list.reduce((a, s) => ({ inp: a.inp + s.inp, out: a.out + s.out, cw: a.cw + s.cw, cr: a.cr + s.cr }),
    { inp: 0, out: 0, cw: 0, cr: 0 });
  const parts = [
    ['чтение кэша (длинный контекст)', T.cr * R.cr / 1e6, T.cr],
    ['ЗАПИСЬ кэша (пересоздание)', T.cw * R.cw / 1e6, T.cw],
    ['выход (ответы модели)', T.out * R.out / 1e6, T.out],
    ['свежий вход', T.inp * R.in / 1e6, T.inp],
  ].sort((a, b) => b[1] - a[1]);
  for (const [name, c, tok] of parts) {
    console.log(`  ${name.padEnd(32)} ${M(tok).padStart(8)}  ${$(c).padStart(8)}  ${(c / totalCost * 100).toFixed(0)}%`);
  }

  console.log('\n=== РОСТ КОНТЕКСТА ВНУТРИ СЕССИИ ===');
  console.log('(средний размер контекста на шаге N по всем сессиям — видно, за что платишь на каждом шаге)');
  const buckets = [[1, 10], [11, 25], [26, 50], [51, 100], [101, 200], [201, 400], [401, 9999]];
  for (const [lo, hi] of buckets) {
    let sum = 0, n = 0;
    for (const s of list) {
      for (let i = lo - 1; i < Math.min(hi, s.ctx.length); i++) { sum += s.ctx[i]; n++; }
    }
    if (!n) continue;
    const avg = sum / n;
    const perTurn = avg * R.cr / 1e6;
    console.log(`  шаги ${String(lo).padStart(3)}–${String(hi === 9999 ? '∞' : hi).padEnd(4)} средний контекст ${K(avg).padStart(7)}  ≈ $${perTurn.toFixed(3)} за шаг`);
  }

  console.log('\n=== ПРОТУХШИЙ КЭШ (перезапись после паузы >5 мин) ===');
  const cwGap = list.reduce((a, s) => a + s.cwAfterGap, 0);
  console.log(`  перезаписано после пауз: ${M(cwGap)} токенов = ${$(cwGap * R.cw / 1e6)}`);
  console.log(`  это ${(cwGap / Math.max(1, T.cw) * 100).toFixed(0)}% всей записи кэша и ${(cwGap * R.cw / 1e6 / totalCost * 100).toFixed(0)}% всего счёта`);

  const allGaps = list.flatMap((s) => s.gaps).sort((a, b) => a - b);
  if (allGaps.length) {
    const pct = (p) => allGaps[Math.floor(allGaps.length * p)].toFixed(1);
    const over5 = allGaps.filter((g) => g > 5).length;
    console.log(`  пауз между шагами: ${allGaps.length}, из них >5 мин: ${over5} (${(over5 / allGaps.length * 100).toFixed(0)}%)`);
    console.log(`  медиана паузы ${pct(0.5)} мин | 90-й перцентиль ${pct(0.9)} мин`);
  }

  console.log('\n=== РАСПРЕДЕЛЕНИЕ ===');
  const top5 = list.slice(0, 5).reduce((a, s) => a + s.cost, 0);
  const long = list.filter((s) => s.turns > 200);
  console.log(`  5 самых дорогих сессий = ${$(top5)} (${(top5 / totalCost * 100).toFixed(0)}% всего счёта)`);
  console.log(`  сессий длиннее 200 шагов: ${long.length} из ${list.length}, но они дали ${(long.reduce((a, s) => a + s.cost, 0) / totalCost * 100).toFixed(0)}% счёта`);
  const medTurns = [...list].sort((a, b) => a.turns - b.turns)[Math.floor(list.length / 2)].turns;
  console.log(`  медианная сессия: ${medTurns} шагов`);
})();
