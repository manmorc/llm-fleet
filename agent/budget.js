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
