// Провайдер-нейтральная консервативная оценка токенов (борроу из Personal_Assistant budget.py).
// Без модель-специфичного токенайзера: ~3 символа на токен. Для гварда контекста в петле.
const CHARS_PER_TOKEN = 3;

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function messagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || '') + estimateTokens(m.tool_calls || ''), 0);
}

// Компакция: если оценка превышает бюджет — выкидываем САМЫЕ СТАРЫЕ tool-результаты
// (сохраняя system[0], первый user и последние keepRecent сообщений). Возвращает новый массив.
function compact(messages, { budgetTokens = 12000, keepRecent = 6 } = {}) {
  if (messagesTokens(messages) <= budgetTokens) return messages;
  const head = messages.slice(0, 2);              // system + первый user
  const tail = messages.slice(-keepRecent);
  const middle = messages.slice(2, -keepRecent);
  // из середины убираем tool-результаты первыми (они самые объёмные и наименее нужны позже)
  const kept = middle.filter((m) => m.role !== 'tool');
  let out = [...head, ...kept, ...tail];
  // если всё ещё много — режем и оставшуюся середину
  while (messagesTokens(out) > budgetTokens && out.length > head.length + tail.length) {
    out.splice(head.length, 1);
  }
  return out;
}

module.exports = { estimateTokens, messagesTokens, compact, CHARS_PER_TOKEN };
