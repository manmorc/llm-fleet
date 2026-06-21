const cfg = require('../config');
const { chat } = require('../ollama');

// Скил: распарсить сообщение крипто-канала в структурный торговый сигнал (локальной моделью).
const SYS = `Ты — парсер торговых сигналов из крипто-каналов. Верни СТРОГО JSON по схеме:
{"isSignal":boolean,"asset":string,"side":"long"|"short"|"none","entry":number|null,"sl":number|null,"tp":number|null,"leverage":integer|null,"confidence":integer}
Правила: isSignal=false, если это НЕ конкретный призыв к входу (аналитика, апдейт позиции «двину стоп», реклама).
confidence 0-100 — насколько уверенно подан сигнал. Никакого текста кроме JSON.`;

module.exports = {
  name: 'parseSignal',
  async run(payload, ctx = {}) {
    const text = (typeof payload === 'string' ? payload : payload?.text || '').slice(0, 4000);
    const out = await (ctx.chat || chat)(
      [{ role: 'system', content: SYS }, { role: 'user', content: text }],
      { model: ctx.model || cfg.model, format: 'json' },
    );
    try { return JSON.parse(out); }
    catch (_) { return { isSignal: false, parseError: true, raw: String(out).slice(0, 300) }; }
  },
};
