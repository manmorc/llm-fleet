// ПУСТОЙ ОТВЕТ ОБЯЗАН БЫТЬ ОШИБКОЙ, А НЕ ОТВЕТОМ.
//
// Регрессия на реальный сбой 04.08.2026: `?? ''` в src/ollama.js отдавал пустую строку как
// валидный ответ, когда модель упиралась в потолок max_tokens. linux-prestige получил пустоту
// и сделал вывод «локальная модель не тянет задачи, где нужно суждение» — молчала не модель,
// молчал клиент.
//
// ДВА ТЕСТА, И ВТОРОЙ ОБЯЗАТЕЛЕН. Один отрицательный тест не доказывает ничего: он одинаково
// зелёный и при работающей проверке, и при сломанной модели, и при выключенном сервере — всюду
// «ошибка есть». Поэтому рядом стоит ПОЛОЖИТЕЛЬНЫЙ БЛИЗНЕЦ на том же промпте и том же сервере:
// он показывает, что при достаточном бюджете ответ ЕСТЬ. Только пара различает «проверка ловит
// переполнение» от «здесь вообще ничего не работает».
//
// Запуск (модель должна быть поднята):  node src/ollama.empty.test.js
const path = require('path');

const PROMPT = 'Оцени гипотезу и дай развёрнутый вердикт: рост числа складов у ритейлера '
  + 'предсказывает рост выручки в следующем квартале. Разбери механизм, назови, какие данные '
  + 'нужны для проверки, и объясни, где вывод может оказаться ложным.';

// Каждый прогон — свежий модуль: cfg.maxTokens читается один раз при загрузке.
function load(maxTokens) {
  for (const m of ['./config', './ollama', '../agent/server']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
  process.env.LLM_MAX_TOKENS = String(maxTokens);
  process.env.LLM_BACKEND = 'openai';
  process.env.LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8081/v1';
  return require('./ollama');
}

(async () => {
  const results = [];

  // ── 1. ОТРИЦАТЕЛЬНЫЙ: крошечный бюджет → размышление съедает его до первого знака ответа.
  //     Ожидаем ВНЯТНУЮ ошибку, а не пустую строку.
  {
    const { chat } = load(48);
    let verdict;
    try {
      const out = await chat([{ role: 'user', content: PROMPT }]);
      verdict = { ok: false, why: `вернулся ответ вместо ошибки: ${JSON.stringify(String(out).slice(0, 80))}` };
    } catch (e) {
      const msg = e.message || '';
      // Мало «упало» — важно, чтобы упало ПО ТОЙ ПРИЧИНЕ и объяснило, что делать.
      const named = /max_tokens|потолок|ПУСТОЙ/i.test(msg);
      verdict = named ? { ok: true, why: msg.slice(0, 120) }
                      : { ok: false, why: `упало, но не по делу: ${msg.slice(0, 160)}` };
    }
    results.push(['потолок токенов → внятная ошибка', verdict]);
  }

  // ── 2. ПОЛОЖИТЕЛЬНЫЙ БЛИЗНЕЦ: тот же промпт, нормальный бюджет → настоящий ответ.
  //     Без него первый тест зелёный даже на выключенном сервере.
  {
    const { chat } = load(8192);
    let verdict;
    try {
      const out = await chat([{ role: 'user', content: PROMPT }]);
      verdict = String(out).trim().length > 40
        ? { ok: true, why: `${String(out).trim().length} знаков` }
        : { ok: false, why: `ответ подозрительно короткий: ${JSON.stringify(String(out).slice(0, 80))}` };
    } catch (e) {
      verdict = { ok: false, why: `при достаточном бюджете НЕ ДОЛЖНО падать: ${(e.message || '').slice(0, 160)}` };
    }
    results.push(['нормальный бюджет → настоящий ответ', verdict]);
  }

  console.log('');
  let bad = 0;
  for (const [name, v] of results) {
    console.log(`  ${v.ok ? '✓' : '✗'} ${name}\n      ${v.why}`);
    if (!v.ok) bad++;
  }
  console.log('');
  console.log(bad ? `ПРОВАЛ: ${bad} из ${results.length}` : `ВСЁ ЗЕЛЕНО: ${results.length} из ${results.length}`);
  process.exit(bad ? 1 : 0);
})();
