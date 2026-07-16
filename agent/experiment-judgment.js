#!/usr/bin/env node
// Эксперимент: может ли ХАРНЕС (test-time compute) + reasoning-модель поднять СУЖДЕНИЕ локалки?
// Сетка модель × техника (A direct / B CoT / C self-consistency / D self-reflection) × задача.
// Вывод — в файл для судейства (судья инсайта — Claude). Метрика — не числа, а ИНСАЙТ/СКЕПСИС/НЮАНС.
//   MODELS="deepseek-r1:14b" TECHS="A,D" node agent/experiment-judgment.js
const fs = require('fs');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OUT = process.env.OUT || 'C:/Users/makei/AppData/Local/Temp/claude/C--Users-makei/1abb7bdb-3e21-4fb2-8261-1c876f75c423/scratchpad/experiment-results.txt';
const MODELS = (process.env.MODELS || 'deepseek-r1:14b').split(',').map((s) => s.trim());
const TECHS = (process.env.TECHS || 'A,D').split(',').map((s) => s.trim());
const TASKIDS = (process.env.TASKS || 'T1,T2,T4,T5').split(',').map((s) => s.trim());

const TASKS = {
  T1: 'При доходности ~8% годовых net, насколько реинвест (компаундинг) поднимает эффективный годовой процент при помесячном и почасовом реинвесте, и где реально возникает выгода реинвеста?',
  T2: 'Владелец торгует руками через UI биржи на том же аккаунте, что и автономные торговые движки; ручные сделки съедают маржу движков. Может ли софт-ограничение в приложении это предотвратить? Обоснуй и предложи единственно надёжное решение.',
  T4: 'Торговая стратегия показывает 80% win-rate на бэктесте за 2 года и +140% доходности. Запускать ли её в реальную торговлю? Что проверить ПЕРВЫМ делом?',
  T5: 'Фандинг-рейт на альткоине 300% годовых, на BTC 11% годовых. Куда завести дельта-нейтральный арбитраж ради максимума доходности?',
  // T5R — тот же вопрос, но с ИНЖЕКТОМ факта (симуляция RAG-retrieve). Causal A/B: знаниевое лечится фактом?
  T5R: 'ИЗВЕСТНЫЕ ФАКТЫ (учитывай их): Высокий фандинг-рейт на альткоине обычно ТРАНЗИЕНТЕН — быстро возвращается к среднему. У тонкого альткоина тонкий/отсутствующий спот-рынок для хеджа (дельта-нейтраль не собрать) и тонкий открытый интерес (нельзя влить размер), выше риск ликвидации/гэпа. Ликвидная корзина BTC/ETH даёт реально СНИМАЕМУЮ доходность. Высокий заголовочный фандинг ≠ высокая снимаемая доходность.\n\nВОПРОС: Фандинг-рейт на альткоине 300% годовых, на BTC 11% годовых. Куда завести дельта-нейтральный арбитраж ради максимума доходности?',
  // T5RS — факт + СКЕПТИК-рамка (тест interaction: перевернёт ли phi4, который на факте одном не флипнул).
  T5RS: 'ИЗВЕСТНЫЕ ФАКТЫ: Высокий фандинг-рейт на альткоине обычно ТРАНЗИЕНТЕН (возвращается к среднему). У тонкого альткоина нет/тонкий спот-рынок для хеджа (дельта-нейтраль не собрать) и тонкий открытый интерес (размер не влить), выше риск ликвидации/гэпа. Ликвидная корзина BTC/ETH даёт реально СНИМАЕМУЮ доходность. Заголовочный фандинг ≠ снимаемая доходность.\nУСТАНОВКА: Будь СКЕПТИЧЕН к заголовочным цифрам. Если факты указывают, что высокая цифра — ловушка или инструмент непригоден, твоя задача — прямо РЕКОМЕНДОВАТЬ ИЗБЕГАТЬ, а не оптимизировать вокруг неё.\n\nВОПРОС: Фандинг-рейт на альткоине 300% годовых, на BTC 11% годовых. Куда завести дельта-нейтральный арбитраж ради максимума доходности?',
};

async function raw(model, messages, temperature = 0.2) {
  const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature } }) });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = await res.json();
  return j.message?.content ?? '';
}
// финальный ответ без <think>…</think> (reasoning-модели вписывают мысли туда)
const strip = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

async function techA(model, task) { return strip(await raw(model, [{ role: 'user', content: task }])); }
async function techB(model, task) {
  return strip(await raw(model, [{ role: 'user', content: task + '\n\nРассуждай пошагово, разбери допущения и подводные камни, затем дай финальный вывод.' }]));
}
async function techC(model, task) {
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push(strip(await raw(model, [{ role: 'user', content: task }], 0.7)));
  const synth = await raw(model, [{ role: 'user', content: `Вопрос: ${task}\n\nВот 5 независимых попыток ответа:\n${samples.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')}\n\nСинтезируй ОДИН лучший консенсусный ответ, взяв самое обоснованное и отбросив слабое/наивное.` }]);
  return strip(synth);
}
async function techD(model, task) {
  const a1 = strip(await raw(model, [{ role: 'user', content: task }]));
  const crit = strip(await raw(model, [{ role: 'user', content: `Вопрос: ${task}\n\nОтвет для оценки:\n${a1}\n\nКритически оцени этот ответ: какие слабости, что упущено, нет ли наивного энтузиазма, переоценки выгоды или пропущенных рисков/ловушек? Будь скептичен и конкретен.` }]));
  const a2 = strip(await raw(model, [{ role: 'user', content: `Вопрос: ${task}\n\nЧерновой ответ:\n${a1}\n\nКритика:\n${crit}\n\nПерепиши УЛУЧШЕННЫЙ финальный ответ с учётом критики.` }]));
  return a2;
}
const TECH = { A: techA, B: techB, C: techC, D: techD };

(async () => {
  fs.writeFileSync(OUT, `ЭКСПЕРИМЕНТ СУЖДЕНИЯ — ${new Date().toISOString()}\nмодели: ${MODELS.join(', ')} · техники: ${TECHS.join(', ')} · задачи: ${TASKIDS.join(', ')}\n`);
  for (const model of MODELS) {
    for (const tid of TASKIDS) {
      for (const tech of TECHS) {
        const t0 = Date.now();
        let ans; try { ans = await TECH[tech](model, TASKS[tid]); } catch (e) { ans = 'ERR: ' + e.message; }
        const ms = Date.now() - t0;
        const block = `\n${'='.repeat(70)}\n### ${model} · ${tid} · тех.${tech} · ${(ms / 1000).toFixed(1)}с\n${'='.repeat(70)}\n${ans}\n`;
        fs.appendFileSync(OUT, block);
        console.log(`✔ ${model} ${tid} ${tech} — ${(ms / 1000).toFixed(1)}с (${ans.length} симв.)`);
      }
    }
  }
  console.log(`\nРезультаты → ${OUT}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
