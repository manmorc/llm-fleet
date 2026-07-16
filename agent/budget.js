// Провайдер-нейтральная КОНСЕРВАТИВНАЯ оценка токенов (для гварда контекста в петле).
// ЗАМЕРЕНО на gemma-4-26b (prompt_tokens против длины строки):
//   русская проза  — 2.96 симв/токен
//   английская     — 3.48 симв/токен
//   JSON/структура — 1.43 симв/токен  ← ВДВОЕ плотнее!
// Результаты тулзов — сплошной JSON, поэтому «3» их недооценивала вдвое и компакция срабатывала
// слишком поздно. Гвард обязан ошибаться в БЕЗОПАСНУЮ сторону: лучше переоценить токены и
// компактить раньше, чем недооценить и переполнить контекст. Берём 2.
const CHARS_PER_TOKEN = 2.8;      // проза (рус 2.96 / англ 3.48 — берём нижнюю границу)
const CHARS_PER_TOKEN_DENSE = 1.4; // JSON/структура (замер: 1.43)

// Плотный текст (JSON, код, числа) токенизируется вдвое плотнее прозы. Определяем по доле
// служебных символов: результаты тулзов — почти всегда JSON, и именно они забивают контекст.
function estimateTokens(value) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)) || '';
  if (!text) return 0;
  const punct = (text.match(/[{}[\]",:0-9]/g) || []).length / text.length;
  return Math.ceil(text.length / (punct > 0.15 ? CHARS_PER_TOKEN_DENSE : CHARS_PER_TOKEN));
}

function messagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || '') + estimateTokens(m.tool_calls || ''), 0);
}

// Компакция (conversation-preserving): сохраняем РАЗГОВОР (user/assistant), выкидываем в первую
// очередь старые объёмные TOOL-результаты (после обработки они не нужны). Только если и без них
// не влезаем — дропаем самые старые реплики, сохраняя system[0] и последние keepRecentTurns.
function compact(messages, { budgetTokens = 7000, keepRecentTurns = 14 } = {}) {
  if (messagesTokens(messages) <= budgetTokens) return messages;
  const system = messages[0];
  let rest = messages.slice(1);
  // 1) дропаем СТАРЫЕ tool-сообщения (самые объёмные) с начала, пока не влезем — разговор не трогаем
  for (let i = 0; i < rest.length && messagesTokens([system, ...rest]) > budgetTokens;) {
    if (rest[i].role === 'tool') rest.splice(i, 1);
    else i++;
  }
  // 2) если всё ещё много — дропаем самые старые сообщения, сохраняя последние keepRecentTurns
  while (messagesTokens([system, ...rest]) > budgetTokens && rest.length > keepRecentTurns) {
    rest.shift();
  }
  return [system, ...rest];
}

module.exports = { estimateTokens, messagesTokens, compact, CHARS_PER_TOKEN };
