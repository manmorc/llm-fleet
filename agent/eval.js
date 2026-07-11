#!/usr/bin/env node
// Eval моделей под задачи агента desktop-local (§7 строгость: полная выборка, null-контроли).
// Категории: A) tool-call точность (нужный тул+аргументы), B) сдержанность (НЕ звать тул на болтовню),
// C) parseSignal (структурный JSON, вкл. null-контроль — заведомо-НЕ-сигнал должен дать isSignal=false).
//   node agent/eval.js [model1 model2 ...]   (по умолчанию — 3 кандидата)
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['gemma4:latest', 'qwen2.5-coder:7b', 'llama3.1:8b'];

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: 'Погода в городе', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } },
  { type: 'function', function: { name: 'add', description: 'Сложить два числа', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } } },
];
// A: ожидаем вызов tool с аргументами. B: ожидаем ОТСУТСТВИЕ вызова.
const CALL = [
  { q: 'Какая погода в Париже?', tool: 'get_weather', args: { location: /париж/i } },
  { q: 'Погода в Берлине сейчас?', tool: 'get_weather', args: { location: /берлин/i } },
  { q: 'Посчитай инструментом: 17 плюс 25.', tool: 'add', args: { a: 17, b: 25 } },
  { q: 'Сложи 100 и 250 через инструмент.', tool: 'add', args: { a: 100, b: 250 } },
  { q: 'Прочитай файл notes.txt.', tool: 'read_file', args: { file: /notes\.txt/i } },
];
const RESTRAIN = ['Привет, как дела?', 'Расскажи короткую шутку.', 'Что ты умеешь?'];

const SIG_SYS = `Ты — парсер торговых сигналов. Верни СТРОГО JSON: {"isSignal":boolean,"asset":string,"side":"long"|"short"|"none","confidence":integer}. isSignal=false если это НЕ конкретный призыв к входу. Только JSON.`;
const SIGNAL = [
  { t: 'BTC long entry 65000 sl 63000 tp 70000 x10', want: { isSignal: true, side: 'long' } },
  { t: 'ETH short от 3500, стоп 3600, цель 3200', want: { isSignal: true, side: 'short' } },
  { t: 'Ребята, рынок сегодня волатильный, будьте осторожны', want: { isSignal: false } }, // null-контроль
  { t: 'Двину стоп в безубыток по своей позиции', want: { isSignal: false } },              // null-контроль
];

async function chat(model, messages, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0 }, ...opts }) });
  const j = await res.json();
  return { msg: j.message || {}, ms: Date.now() - t0 };
}
function argOk(got, want) {
  for (const k of Object.keys(want)) {
    const w = want[k], g = got?.[k];
    if (w instanceof RegExp) { if (!w.test(String(g ?? ''))) return false; }
    else if (Number(g) !== Number(w) && String(g) !== String(w)) return false;
  }
  return true;
}

async function evalModel(model) {
  let a = 0, b = 0, c = 0, lat = [];
  // A: tool-call
  for (const t of CALL) {
    const { msg, ms } = await chat(model, [{ role: 'user', content: t.q }], { tools: TOOLS });
    lat.push(ms);
    const call = (msg.tool_calls || [])[0];
    if (call?.function?.name === t.tool && argOk(call.function.arguments, t.args)) a++;
  }
  // B: restraint
  for (const q of RESTRAIN) {
    const { msg, ms } = await chat(model, [{ role: 'user', content: q }], { tools: TOOLS });
    lat.push(ms);
    if (!(msg.tool_calls || []).length) b++;
  }
  // C: parseSignal
  for (const s of SIGNAL) {
    const { msg, ms } = await chat(model, [{ role: 'system', content: SIG_SYS }, { role: 'user', content: s.t }], { format: 'json' });
    lat.push(ms);
    try { const j = JSON.parse(msg.content); if (argOk(j, s.want)) c++; } catch (_) {}
  }
  const avg = Math.round(lat.reduce((x, y) => x + y, 0) / lat.length);
  return { model, call: `${a}/${CALL.length}`, restraint: `${b}/${RESTRAIN.length}`, signal: `${c}/${SIGNAL.length}`,
    score: a + b + c, max: CALL.length + RESTRAIN.length + SIGNAL.length, avgMs: avg };
}

(async () => {
  console.log(`Eval моделей (t=0). Категории: CALL(${CALL.length}) RESTRAINT(${RESTRAIN.length}) SIGNAL(${SIGNAL.length}, 2 null-контроля)\n`);
  const rows = [];
  for (const m of MODELS) { process.stdout.write(`  ${m} … `); const r = await evalModel(m); rows.push(r); console.log(`score ${r.score}/${r.max}`); }
  rows.sort((x, y) => y.score - x.score);
  console.log('\nМОДЕЛЬ                 CALL   RESTR  SIGNAL  ИТОГО  ~лат');
  for (const r of rows) console.log(`${r.model.padEnd(22)} ${r.call.padEnd(6)} ${r.restraint.padEnd(6)} ${r.signal.padEnd(7)} ${(r.score + '/' + r.max).padEnd(6)} ${r.avgMs}ms`);
  console.log(`\n🏆 Лучшая: ${rows[0].model} (${rows[0].score}/${rows[0].max})`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
