const { runAgent } = require('./loop');

// Само-управляемый judgment-mode: классифицируем задачу и АВТО-применяем доказанный каркас
// (карта суждения: reasoning→CoT; disposition→skeptic; knowledge→факты+skeptic; structure→как есть).
// Классификатор — дешёвый вызов локальной модели с JSON-выводом.
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const CLS_SYS = `Классифицируй задачу в РОВНО ОДИН класс и верни СТРОГО JSON {"class":"...","why":"..."}. Ключевой критерий — ЧЕГО не хватает для правильного ответа:
- "reasoning": ответ ВЫЧИСЛИМ логикой/математикой ИЗ ДАННЫХ В ВОПРОСЕ, внешние факты не нужны. Пример: «насколько 8% compound поднимает эффективную ставку помесячно/почасово» — чистый расчёт.
- "knowledge": нужен ВНЕШНИЙ доменный ФАКТ, НЕ выводимый из вопроса (механика рынка/инструмента, «почему X — ловушка»). Пример: «фандинг альта 300% — куда арбитраж» (нужно знать, что такой фандинг транзиентен/нехеджируем).
- "disposition": оценить предложение/стратегию, где нужен СКЕПСИС к заманчивой цифре («слишком хорошо»). Пример: «80% win-rate на бэктесте — запускать?».
- "structure": парсинг/извлечение/форматирование/подсчёт по данным/файлам/JSON.
Различай reasoning (посчитать из вопроса) и knowledge (нужен факт извне). Только JSON.

ПРИМЕРЫ:
Q: «Насколько 8% годовых при помесячном реинвесте дают эффективную ставку?» A: {"class":"reasoning","why":"чистый расчёт по формуле из данных вопроса"}
Q: «Стоит ли гнаться за фандингом 300% на альткоине для арбитража?» A: {"class":"knowledge","why":"нужен внешний факт: такой фандинг транзиентен и нехеджируем"}
Q: «Стратегия 80% win-rate на бэктесте — запускать в реал?» A: {"class":"disposition","why":"нужен скепсис к заманчивой цифре, риск overfit"}
Q: «Извлеки поле port из config.json» A: {"class":"structure","why":"извлечение поля из данных"}`;

// Признак, что задача требует данных/тулзов (файлы, папки) — тогда r1 (без tool-calls) не годится.
function needsTools(task) { return /\.(txt|json|md|csv|log)\b|\bфайл|\bпапк|\bдиректор|рабоч.{0,6}папк/i.test(String(task)); }

// Чистое рассуждение reasoning-моделью (r1) БЕЗ тулзов (r1 не делает нативных tool_calls, но силён в логике).
// Отдельная reasoning-модель для само-содержащегося рассуждения. Пусто = выключено (тогда
// reasoning идёт на основную модель + CoT). deepseek-r1 удалена: бенч показал, что она не умеет
// нативные tool_calls, а по суждению её обошла gemma-4-26b (см. moe-serve/BENCHMARK.md).
const REASON_MODEL = process.env.REASON_MODEL || '';
async function reason(task, { model = REASON_MODEL } = {}) {
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: String(task) + '\n\nРассуждай пошагово, разбери допущения и подводные камни, затем дай чёткий финальный вывод.' }], stream: false, options: { temperature: 0.2 } }) });
    const j = await res.json();
    return (j.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (e) { return null; }
}

async function classify(task, { model = 'gemma4:latest' } = {}) {
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: CLS_SYS }, { role: 'user', content: String(task).slice(0, 2000) }], format: 'json', stream: false, options: { temperature: 0 } }) });
    const j = await res.json();
    const cls = JSON.parse(j.message?.content || '{}').class;
    return ['reasoning', 'knowledge', 'disposition', 'structure'].includes(cls) ? cls : 'structure';
  } catch (_) { return 'structure'; }
}

// Авто-прогон: классифицирует → выставляет facts/skeptic/CoT по классу → runAgent.
// facts (если есть) прокидываются; для knowledge без фактов ставим needsFacts=true в результат
// (сигнал вызывающему: подтяни RAG — карта суждения доказала, что знаниевое лечится фактом).
async function runAgentAuto(task, { model = 'gemma4:latest', facts, maxSteps = 8, onEvent } = {}) {
  const cls = await classify(task, { model });
  if (onEvent) onEvent({ type: 'class', class: cls });
  // Model-routing: reasoning без нужды в данных → отдельная reasoning-модель (если задана).
  if (REASON_MODEL && cls === 'reasoning' && !needsTools(task) && !facts) {
    const ans = await reason(task);
    if (ans) { if (onEvent) onEvent({ type: 'route', model: REASON_MODEL, mode: 'pure-reason' }); return { answer: ans, steps: 1, trace: [], class: cls, needsFacts: false, model: REASON_MODEL }; }
    // r1 недоступен → fallback на gemma+CoT ниже
  }
  const opts = { model, maxSteps, onEvent, facts };
  let effTask = task;
  let needsFacts = false;
  if (cls === 'disposition') opts.skeptic = true;
  else if (cls === 'reasoning') effTask = String(task) + '\n\n(Рассуждай пошагово, разбери допущения, потом финальный вывод.)';
  else if (cls === 'knowledge') {
    opts.skeptic = true; // знание×диспозиция: факт+скептик
    if (!facts) {
      // авто-подтяжка факта из RAG (делает знаниевый фикс автономным). Если RAG не настроен — needsFacts=true.
      const tools = require('./tools');
      const rag = await tools.exec('rag_search', { query: String(task).slice(0, 300) }).catch(() => '');
      if (rag && !/RAG не настроен|не найдено|RAG \d|RAG ошибка/.test(rag)) { opts.facts = rag; if (onEvent) onEvent({ type: 'rag', hit: true }); }
      else needsFacts = true;
    }
  }
  const r = await runAgent(effTask, opts);
  return { ...r, class: cls, needsFacts, model };
}

module.exports = { classify, runAgentAuto };
