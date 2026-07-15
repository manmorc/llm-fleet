#!/usr/bin/env node
// Локальный запуск агента (без шины) — полный judgment-mode (классификация→каркас→model-routing).
//   AGENT_ROOT=<dir> node agent/run.js "<задача>" [model]
// Рисковые тулзы: AGENT_ALLOW_RISKY=1 (+ AGENT_SUPERVISOR=allow|bus|file). По умолчанию read-only.
const { runAgentAuto } = require('./router');
const t = require('./tools');

const task = process.argv[2];
const model = process.argv[3] || process.env.MODEL || 'gemma4:latest';
if (!task) { console.error('usage: AGENT_ROOT=<dir> node agent/run.js "<задача>" [model]'); process.exit(1); }

console.log(`agent desktop-local | model=${model} | root=${t.ROOT} | risky=${t.ALLOW_RISKY ? 'ON' : 'off'}`);
console.log(`tools: ${t.schemas().map((s) => s.function.name).join(', ')}\n`);

runAgentAuto(task, {
  model,
  onEvent: (e) => {
    if (e.type === 'class') console.log(`  [класс: ${e.class}]`);
    else if (e.type === 'route') console.log(`  [routing → ${e.model}]`);
    else if (e.type === 'rag') console.log(`  [rag: факт подтянут]`);
    else if (e.type === 'call') console.log(`  → ${e.name}(${JSON.stringify(e.args)})`);
    else if (e.type === 'result') console.log(`  ← ${String(e.result).replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
  },
}).then((r) => {
  console.log(`\n✅ ОТВЕТ [${r.class}${r.model && /r1|deepseek/i.test(r.model) ? '·r1' : ''}${r.needsFacts ? '·нужен-RAG-факт' : ''}]:\n${r.answer}`);
  console.log(`\n[${r.steps} шаг(ов)]`);
}).catch((e) => { console.error('ERR', e.message); process.exit(1); });
