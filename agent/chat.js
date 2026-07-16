#!/usr/bin/env node
// Интерактивный ЧАТ с локальным агентом + харнес (работа с машиной под аппрувом).
// Единый readline и для реплик, и для y/N-аппрувов (без конфликта). История диалога сохраняется.
//   AGENT_ROOT=<папка> node agent/chat.js [model]
//   действия: AGENT_ALLOW_RISKY=1 AGENT_SUPERVISOR=ask AGENT_ROOT=<папка> node agent/chat.js
const readline = require('readline');
const { converse, buildSystemPrompt } = require('./loop');
const supervisor = require('./supervisor');
const t = require('./tools');

const model = process.argv[2] || require('./loop').DEFAULT_MODEL;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

// аппрув рискового — через ТОТ ЖЕ question() (единый stdin, без второго readline)
supervisor.setAsker(async (prompt) => /^\s*(y|yes|да|д)\s*$/i.test((await question('\n' + prompt)) || ''));

let history = [{ role: 'system', content: buildSystemPrompt() }];

console.log('💬 Чат с локальным агентом desktop-local');
console.log(`модель: ${model} | папка: ${t.ROOT} | действия: ${t.ALLOW_RISKY ? 'ВКЛ (надзор=' + (process.env.AGENT_SUPERVISOR || 'deny') + ')' : 'выкл (только чтение)'}`);
console.log(`тулзы: ${t.schemas().map((s) => s.function.name).join(', ')}`);
console.log('команды: /reset (сброс истории) · /tools · /exit');

(async () => {
  for (;;) {
    let text;
    try { text = ((await question('\nвы> ')) || '').trim(); } catch (_) { break; }
    if (!text) continue;
    if (text === '/exit') break;
    if (text === '/reset') { history = [{ role: 'system', content: buildSystemPrompt() }]; console.log('(история сброшена)'); continue; }
    if (text === '/tools') { console.log(t.schemas().map((s) => s.function.name).join(', ')); continue; }
    try {
      const r = await converse(history, text, {
        model,
        onEvent: (e) => { if (e.type === 'call') process.stdout.write(`  · ${e.name}(${JSON.stringify(e.args).slice(0, 90)})\n`); },
      });
      history = r.history;
      console.log('\nагент> ' + r.answer);
    } catch (e) { console.log('ошибка: ' + e.message); }
  }
  rl.close();
  console.log('\nпока!');
  process.exit(0);
})();
