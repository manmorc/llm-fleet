#!/usr/bin/env node
// Интерактивный ЧАТ с локальным агентом + харнес (работа с машиной под аппрувом).
// Держит историю диалога между репликами; рисковое спрашивает y/N в этом же окне.
//   AGENT_ROOT=<папка> node agent/chat.js [model]
//   действия (запись/shell): AGENT_ALLOW_RISKY=1 AGENT_SUPERVISOR=ask AGENT_ROOT=<папка> node agent/chat.js
const readline = require('readline');
const { converse, buildSystemPrompt } = require('./loop');
const supervisor = require('./supervisor');
const t = require('./tools');

const model = process.argv[2] || process.env.MODEL || 'gemma4:latest';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let history = [{ role: 'system', content: buildSystemPrompt() }];
let busy = false;

// аппрув рискового — через ЭТОТ же readline (единый stdin, без конфликта)
supervisor.setAsker((prompt) => new Promise((res) => rl.question('\n' + prompt, (a) => res(/^\s*(y|yes|да|д)\s*$/i.test(a || '')))));

const ask = () => process.stdout.write('\nвы> ');
console.log('💬 Чат с локальным агентом desktop-local');
console.log(`модель: ${model} | папка: ${t.ROOT} | действия: ${t.ALLOW_RISKY ? 'ВКЛ (надзор=' + (process.env.AGENT_SUPERVISOR || 'deny') + ')' : 'выкл (только чтение)'}`);
console.log(`тулзы: ${t.schemas().map((s) => s.function.name).join(', ')}`);
console.log('команды: /reset (сброс истории) · /tools · /exit');
ask();

rl.on('line', async (line) => {
  if (busy) return; // идёт ход агента / аппрув — ввод обрабатывается там
  const text = line.trim();
  if (!text) return ask();
  if (text === '/exit') return rl.close();
  if (text === '/reset') { history = [{ role: 'system', content: buildSystemPrompt() }]; console.log('(история сброшена)'); return ask(); }
  if (text === '/tools') { console.log(t.schemas().map((s) => s.function.name).join(', ')); return ask(); }
  busy = true;
  try {
    const r = await converse(history, text, { model, onEvent: (e) => { if (e.type === 'call') process.stdout.write(`  · ${e.name}(${JSON.stringify(e.args).slice(0, 90)})\n`); } });
    history = r.history;
    console.log(`\nагент> ${r.answer}`);
  } catch (e) { console.log('ошибка:', e.message); }
  busy = false;
  ask();
});
rl.on('close', () => { console.log('\nпока!'); process.exit(0); });
