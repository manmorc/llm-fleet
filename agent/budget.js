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
// Бюджет ВЫВОДИТСЯ ИЗ КОНТЕКСТА МОДЕЛИ, а не зашит числом. Раньше стояло 7000 — подобрано под
// ctx=16384. При переходе на 131072 (31.07.2026) этот потолок остался бы прежним, и поднятие
// контекста не дало бы агенту ровно ничего: компакт продолжал бы резать историю на семи тысячах.
// Класс «деплой без обновления всех потребителей общего параметра» — параметр сменился в server.js,
// а зависящее от него число осталось.
// Резерв: ответ (AGENT_MAX_TOKENS) + системный промпт со схемами инструментов + запас на недооценку.
// Коэффициент 0.85 — потому что оценка токенов приблизительная и обязана ошибаться в безопасную сторону.
const CTX = parseInt(process.env.LLAMA_CTX || '131072', 10);
const RESERVE = parseInt(process.env.AGENT_MAX_TOKENS || '8192', 10) + 6000;
const DEFAULT_BUDGET = Math.max(4000, Math.floor((CTX - RESERVE) * 0.85));

function compact(messages, { budgetTokens = DEFAULT_BUDGET, keepRecentTurns = 14 } = {}) {
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

// ── ТОЧНЫЙ СЧЁТ ЧЕРЕЗ ТОКЕНАЙЗЕР МОДЕЛИ ──────────────────────────────────────────────────────
// Эвристика выше завышает от 8% до 92% (замер 31.07.2026 против /tokenize самого llama-server):
//   русская проза +43% · код JS +8% · JSON-результат тула +92% · системный промпт +13%
// Хуже всего — ровно на tool-результатах, ради которых компакт и писался: он выбрасывал историю
// почти вдвое раньше, чем нужно. Токенайзера в JS нет, но llama.cpp отдаёт /tokenize по HTTP —
// точный счёт доступен без смены языка.
//
// КАЛИБРОВКА, а не потокенный запрос: токенизировать каждое сообщение — это N вызовов на шаг.
// Вместо этого ОДИН вызов на всю историю даёт точный ИТОГ, из него выводим коэффициент завышения
// и растягиваем на него бюджет. Относительные веса сообщений (кого дропать первым) берём у
// эвристики — там важен порядок, а не абсолют.
const TOKENIZE_URL = (process.env.AGENT_API_URL || 'http://127.0.0.1:8081/v1').replace(/\/v1\/?$/, '') + '/tokenize';

async function exactTokens(text, timeoutMs = 4000) {
  const r = await fetch(TOKENIZE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ content: text }),
  });
  if (!r.ok) throw new Error(`tokenize ${r.status}`);
  return ((await r.json()).tokens || []).length;
}

// Компакция с точным счётом. НИКОГДА не бросает: если модель выгружена или эндпоинта нет —
// молча падаем на эвристику (она консервативна, то есть ошибается в безопасную сторону).
async function compactAsync(messages, opts = {}) {
  const budgetTokens = opts.budgetTokens || DEFAULT_BUDGET;
  try {
    const est = messagesTokens(messages);
    if (est <= budgetTokens) return messages;        // заведомо влезаем — вызов не нужен вовсе
    const text = messages.map((m) => (m.content || '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n');
    const exact = await exactTokens(text);
    if (!exact) return compact(messages, opts);
    const inflation = est / exact;                   // во сколько раз эвристика завышает ИМЕННО эту историю
    if (exact <= budgetTokens) return messages;      // по факту влезаем — эвристика паниковала зря
    return compact(messages, { ...opts, budgetTokens: Math.floor(budgetTokens * inflation) });
  } catch (_) {
    return compact(messages, opts);                  // сервер недоступен — работаем как раньше
  }
}

module.exports = { estimateTokens, messagesTokens, compact, compactAsync, exactTokens, CHARS_PER_TOKEN, DEFAULT_BUDGET };
