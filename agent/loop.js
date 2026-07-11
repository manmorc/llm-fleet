const tools = require('./tools');

// Tool-use петля (ReAct-стиль) поверх локального ollama-модели.
// Пока модель зовёт тулзы — выполняем и возвращаем результат в диалог; выходим на финальном ответе
// или по достижении maxSteps. Модель: gemma4:latest подтверждённо умеет tool_calls (см. probe).

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const SYS = `Ты — автономный агент desktop-local во флоте llm-fleet, работаешь на локальной GPU-модели.
У тебя есть инструменты (tools) — вызывай их для фактов/действий, не выдумывай. После получения
результатов инструментов дай краткий итоговый ответ на русском. Если задача решена — отвечай без вызова тулзов.
ВАЖНО: для ТОЧНЫХ операций всегда используй инструменты, а не устный счёт — считать строки только через
count_lines, арифметику только через calc (модель ошибается в счёте/математике). Файловые операции ограничены
рабочей папкой. Рисковые действия могут быть недоступны — тогда сообщи об этом честно.`;

async function chatTools(messages, { model, temperature = 0.2 } = {}) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: tools.schemas(), stream: false, options: { temperature } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.message || { role: 'assistant', content: '' };
}

// Выполнить задачу. Возвращает { answer, steps, trace[] }. trace — для отладки/аудита (§7 честность).
async function runAgent(task, { model = 'gemma4:latest', maxSteps = 6, onEvent } = {}) {
  const messages = [{ role: 'system', content: SYS }, { role: 'user', content: String(task) }];
  const trace = [];
  const emit = (e) => { trace.push(e); if (onEvent) onEvent(e); };

  for (let step = 0; step < maxSteps; step++) {
    const msg = await chatTools(messages, { model });
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      emit({ type: 'final', step, content: msg.content });
      return { answer: msg.content || '', steps: step + 1, trace };
    }
    for (const c of calls) {
      const name = c.function?.name;
      const args = c.function?.arguments || {};
      emit({ type: 'call', step, name, args });
      let result;
      try { result = await tools.exec(name, args); }
      catch (e) { result = `ERROR: ${e.message}`; }
      emit({ type: 'result', step, name, result: String(result).slice(0, 500) });
      // ollama принимает role:'tool'; имя тула кладём и в поле, и в контент (совместимость разных версий)
      messages.push({ role: 'tool', tool_name: name, content: `[${name}] ${result}` });
    }
  }
  emit({ type: 'exhausted', steps: maxSteps });
  return { answer: '(достигнут лимит шагов без финального ответа)', steps: maxSteps, trace };
}

module.exports = { runAgent, SYS };
