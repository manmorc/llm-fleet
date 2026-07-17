const { runAgent, chatTools, DEFAULT_MODEL } = require('./loop');

// Само-управляемый judgment-mode: классифицируем задачу и АВТО-применяем доказанный каркас
// (карта суждения: reasoning→CoT; disposition→skeptic; knowledge→факты+skeptic; structure→как есть).
// Классификатор — дешёвый вызов ТОЙ ЖЕ модели, что и петля (через chatTools), с JSON-выводом.

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
    const m = await chatTools([{ role: 'user', content: String(task) + '\n\nРассуждай пошагово, разбери допущения и подводные камни, затем дай чёткий финальный вывод.' }],
      { model, noTools: true });
    return (m.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (e) { return null; }
}

// Классификатор идёт через chatTools (тот же бэкенд и та же модель, что и петля), а НЕ прибит
// к ollama: иначе для одной задачи поднимаются ДВЕ модели (боевая 26B + gemma4 только ради
// classify), дерутся за 12 ГБ VRAM, и проигравшая уезжает на CPU, НЕЗАМЕТНО начиная отвечать
// иначе (замер: structure вместо reasoning 7/7). Одна модель за раз — по умолчанию, а не по
// правилу, которое надо помнить.
async function classify(task, { model = DEFAULT_MODEL } = {}) {
  try {
    // noThink: json_object-грамматика и так не даёт модели эмитить <think> — оставлять думалку «включённой»
    // значит ловить конфликт (сервер эмитит мысли → ломает грамматику ЛИБО грамматика душит рассуждение).
    // Классификация в 4 корзины few-shot-промптом думалки не требует. Явно выключаем — детерминированно и без конфликта.
    const m = await chatTools([{ role: 'system', content: CLS_SYS }, { role: 'user', content: String(task).slice(0, 2000) }],
      { model, temperature: 0, json: true, noTools: true, noThink: true });
    const cls = JSON.parse(m.content || '{}').class;
    return ['reasoning', 'knowledge', 'disposition', 'structure'].includes(cls) ? cls : 'structure';
  } catch (_) { return 'structure'; }
}

// Авто-прогон: классифицирует → выставляет facts/skeptic/CoT по классу → runAgent.
// facts (если есть) прокидываются; для knowledge без фактов ставим needsFacts=true в результат
// (сигнал вызывающему: подтяни RAG — карта суждения доказала, что знаниевое лечится фактом).
async function runAgentAuto(task, { model = DEFAULT_MODEL, facts, maxSteps = 8, onEvent } = {}) {
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
  // ДУМАЛКУ НЕ ТРОГАЕМ НИГДЕ — она сама себя ограничивает лучше любого потолка.
  // Свип бюджета на 6 свежих задачах (moe-serve/BENCHMARK.md): 0 → 4/6 · 128 → 4/6 · 256 → 6/6, но
  // одна задача 193с и finish=length (обрубок мысли выплеснулся в ответ) · 512 → 6/6 · -1 → 6/6.
  // При -1 модель думает ~350 токенов САМА. Любой потолок либо выше этого (no-op), либо ниже (ломает).
  // Экономить нечего. Цена думалки: +33% правильности (4/6→6/6) за 8.5с — цель владельца это качество,
  // а не секунды. Прежняя правка (noThink на structure) откачена: экономила 8с ценой риска, которого
  // никто не просил, а классификатор УЖЕ ошибался (reasoning→structure) — ошибка + выкл думалка = двойной провал.
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
