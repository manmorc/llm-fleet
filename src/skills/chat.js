const cfg = require('../config');
const { chat } = require('../ollama');

// Универсальный скил: произвольный промпт → ответ модели. ЛЮБОЙ проект кладёт задачу 'chat'
// без установки собственного скила на флот. Делает сеть generic «принимаю любую задачу».
//   payload: { prompt } | { messages:[...] } | { system, prompt }  (+ model?, format?, temperature? )
module.exports = {
  name: 'chat',
  async run(payload = {}, ctx = {}) {
    const p = typeof payload === 'string' ? { prompt: payload } : payload;
    const messages = Array.isArray(p.messages) ? p.messages : [
      ...(p.system ? [{ role: 'system', content: p.system }] : []),
      { role: 'user', content: p.prompt || '' },
    ];
    const model = p.model || ctx.model || cfg.model;
    const content = await (ctx.chat || chat)(messages, { model, format: p.format, temperature: p.temperature });
    return { content, model };
  },
};
