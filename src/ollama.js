const cfg = require('./config');

// Тонкий клиент к локальному Ollama (нативный /api/chat). format:'json' просит модель вернуть JSON.
async function chat(messages, { model, format, temperature = 0.2 } = {}) {
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || cfg.model, messages, stream: false, format, options: { temperature } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.message?.content ?? '';
}

module.exports = { chat };
