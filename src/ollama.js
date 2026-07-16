const cfg = require('./config');

// Тонкий клиент к локальной модели. Два бэкенда:
//   ollama (нативный /api/chat)          — ДЕФОЛТ, не трогаем: на mac/linux флота крутится qwen3.
//   openai (llama-server /v1/...)        — эта нода (desktop): боевая gemma-4-26b, включается
//                                          через LLM_BACKEND=openai в ecosystem.config.js.
// Дефолт менять НЕЛЬЗЯ: src/ — общий код флота, он деплоится на все ноды.
// format:'json' просит модель вернуть JSON — у бэкендов разные имена, нормализуем здесь.
const isOAI = () => cfg.backend === 'openai';

async function chat(messages, { model, format, temperature = 0.2 } = {}) {
  const oai = isOAI();
  // Модель поднимается по требованию (в простое VRAM свободна). Только для локального llama-server.
  if (oai && /^https?:\/\/(127\.0\.0\.1|localhost):/.test(cfg.llmUrl)) {
    await require('../agent/server').ensure({ log: (m) => console.log(`[модель] ${m}`) });
  }
  const url = oai ? `${cfg.llmUrl}/chat/completions` : `${cfg.llmUrl}/api/chat`;
  const body = oai
    ? { model: model || cfg.model, messages, temperature, max_tokens: cfg.maxTokens }
    : { model: model || cfg.model, messages, stream: false, format, options: { temperature } };
  if (oai && format === 'json') body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${cfg.backend} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (oai ? j.choices?.[0]?.message?.content : j.message?.content) ?? '';
}

module.exports = { chat };
