const tools = require('./tools');

// Tool-use петля (ReAct-стиль) поверх локального ollama-модели.
// Пока модель зовёт тулзы — выполняем и возвращаем результат в диалог; выходим на финальном ответе
// или по достижении maxSteps. Модель: gemma4:latest подтверждённо умеет tool_calls (см. probe).

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const SYS = `Ты — автономный агент desktop-local во флоте llm-fleet, работаешь на локальной GPU-модели.
У тебя есть инструменты (tools) — вызывай их для фактов/действий, не выдумывай. После получения
результатов инструментов дай краткий итоговый ответ на русском. Если задача решена — отвечай без вызова тулзов.
ВАЖНО: для ТОЧНЫХ операций всегда используй инструменты, а не устный счёт — считать строки только через
count_lines, любую арифметику/проценты/степени только через calc (модель ошибается в счёте/математике;
никогда не выдумывай числовой результат — посчитай его calc). При структурном выводе (JSON и т.п.) НОРМАЛИЗУЙ
числа в числовой формат: «63.5к»→63500, «66k»→66000, убирай префиксы вроде «<»/«~», диапазон «63.5-64к»→[63500,64000].
Файловые операции ограничены рабочей папкой. Рисковые действия могут быть недоступны — тогда сообщи об этом честно.`;

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

// Скептик-каркас для диспозиции/знаниевого суждения (доказано бенчмарком: факт+скептик флипает
// даже упрямые модели, см. BENCHMARK/эксперимент). Применять когда задача — домен-судейская.
const SKEPTIC = `\nУСТАНОВКА (суждение): будь СКЕПТИЧЕН к заголовочным цифрам и «слишком хорошим» показателям.
Если известные факты указывают, что высокая цифра — ловушка, а инструмент/стратегия непригодны — прямо
РЕКОМЕНДУЙ ИЗБЕГАТЬ, не оптимизируй вокруг неё. Высокий заголовочный показатель ≠ реальный результат.`;

// Выполнить задачу. opts.facts (строка/массив) — инжект фактов из RAG (знаниевое суждение).
// opts.skeptic — включить скептик-каркас (диспозиция). Вместе = judgment-mode (проверенный причинно).
// Возвращает { answer, steps, trace[] }. trace — для отладки/аудита (§7 честность).
async function runAgent(task, { model = 'gemma4:latest', maxSteps = 6, onEvent, facts, skeptic } = {}) {
  const sys = SYS + (skeptic ? SKEPTIC : '');
  const factBlock = facts ? `ИЗВЕСТНЫЕ ФАКТЫ (учитывай их при ответе):\n${Array.isArray(facts) ? facts.map((f, i) => `[${i + 1}] ${f}`).join('\n') : facts}\n\nЗАДАЧА: ` : '';
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: factBlock + String(task) }];
  const trace = [];
  const emit = (e) => { trace.push(e); if (onEvent) onEvent(e); };
  const seen = new Map(); // сигнатура вызова → счётчик (защита от зацикливания)

  // выполнить тул с 1 retry на транзиентную ошибку (не на BLOCKED — это осознанный отказ надзора)
  async function execWithRetry(name, args) {
    try { return await tools.exec(name, args); }
    catch (e) {
      try { return await tools.exec(name, args); }
      catch (e2) { return `ERROR: ${e2.message}`; }
    }
  }

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
      const sig = name + ':' + JSON.stringify(args);
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);
      emit({ type: 'call', step, name, args });
      let result;
      if (n > 2) {
        // третий+ идентичный вызов — почти наверняка зацикливание; не жжём инференс, направляем модель
        result = `ПОВТОР: этот вызов уже сделан ${n - 1} раз(а) с тем же результатом. НЕ повторяй — используй полученные данные и дай финальный ответ.`;
      } else {
        result = await execWithRetry(name, args);
      }
      emit({ type: 'result', step, name, result: String(result).slice(0, 500) });
      // ollama принимает role:'tool'; имя тула кладём и в поле, и в контент (совместимость разных версий)
      messages.push({ role: 'tool', tool_name: name, content: `[${name}] ${result}` });
    }
  }
  // Исчерпаны шаги — финальный вызов БЕЗ тулзов, чтобы модель дала ответ из собранного (а не заглушка)
  emit({ type: 'exhausted', steps: maxSteps });
  messages.push({ role: 'user', content: 'Лимит инструментов исчерпан. Дай лучший финальный ответ на основе уже собранных данных, без вызова инструментов.' });
  let finalMsg;
  try { finalMsg = await chatTools(messages, { model }); } catch (_) { finalMsg = { content: '' }; }
  return { answer: finalMsg.content || '(достигнут лимит шагов)', steps: maxSteps, trace };
}

module.exports = { runAgent, SYS };
