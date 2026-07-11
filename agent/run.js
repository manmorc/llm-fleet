#!/usr/bin/env node
// Локальный запуск агентной петли для теста (без шины).
//   AGENT_ROOT=<dir> node agent/run.js "<задача>" [model]
// Рисковые тулзы: AGENT_ALLOW_RISKY=1 (по умолчанию выкл).
const { runAgent } = require('./loop');
const t = require('./tools');

const task = process.argv[2];
const model = process.argv[3] || process.env.MODEL || 'gemma4:latest';
if (!task) { console.error('usage: node agent/run.js "<задача>" [model]'); process.exit(1); }

console.log(`agent desktop-local | model=${model} | root=${t.ROOT} | risky=${t.ALLOW_RISKY ? 'ON' : 'off'}`);
console.log(`tools: ${t.schemas().map(s => s.function.name).join(', ')}\n`);

runAgent(task, {
  model,
  onEvent: (e) => {
    if (e.type === 'call') console.log(`  → ${e.name}(${JSON.stringify(e.args)})`);
    else if (e.type === 'result') console.log(`  ← ${e.result.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
    else if (e.type === 'final') console.log(`\n✅ ОТВЕТ:\n${e.content}`);
    else if (e.type === 'exhausted') console.log(`\n⚠ лимит шагов`);
  },
}).then(r => console.log(`\n[${r.steps} шаг(ов)]`)).catch(e => { console.error('ERR', e.message); process.exit(1); });
