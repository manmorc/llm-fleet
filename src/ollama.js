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
  const content = (oai ? j.choices?.[0]?.message?.content : j.message?.content) ?? '';

  // ПУСТОЙ ОТВЕТ БОЛЬШЕ НЕ ВЫДАЁТСЯ ЗА ОТВЕТ.
  // Здесь стояло `?? ''`, и это был тихий сбой: модель упиралась в потолок токенов, content
  // приходил пустым, а вызывающий получал валидную с виду пустую строку. linux-prestige на этом
  // 04.08 сделал неверный вывод «локальная модель не тянет задачи, где нужно суждение» — хотя
  // молчала не модель, молчал наш клиент.
  //
  // МЕХАНИЗМ. У думающей модели размышление и ответ делят ОДИН бюджет max_tokens (8192).
  // Длинный промпт судьи → длинное размышление → бюджет исчерпан ДО первого знака ответа,
  // finish_reason='length', content=''. Отсюда и повторяемость на одном и том же документе:
  // это не случайность, а детерминированная длина рассуждения.
  //
  // Пустоту нельзя отличить от ответа ПО СОДЕРЖИМОМУ — только по finish_reason. Поэтому
  // разбираем причину и говорим её словами: получатель не должен гадать.
  const finish = oai ? j.choices?.[0]?.finish_reason : (j.done_reason || null);
  if (!String(content).trim()) {
    const used = j.usage ? ` (промпт ${j.usage.prompt_tokens}, сгенерировано ${j.usage.completion_tokens} из ${cfg.maxTokens})` : '';
    if (finish === 'length')
      throw new Error(`модель упёрлась в потолок max_tokens=${cfg.maxTokens} и не начала ответ${used}`
        + ' — размышление съело весь бюджет. Лечится увеличением LLM_MAX_TOKENS либо более коротким промптом.');
    throw new Error(`модель вернула ПУСТОЙ ответ, finish_reason=${finish || 'неизвестен'}${used}`);
  }
  // Обрыв на середине — тоже не успех: ответ выглядит целым, но это огрызок.
  if (finish === 'length')
    throw new Error(`ответ ОБОРВАН на потолке max_tokens=${cfg.maxTokens} (получено ${String(content).length} знаков)`
      + ' — это не полный ответ. Увеличьте LLM_MAX_TOKENS или сократите задачу.');
  return content;
}

module.exports = { chat };
