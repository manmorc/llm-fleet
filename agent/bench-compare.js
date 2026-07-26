#!/usr/bin/env node
// Сравнение двух локальных моделей на ОДНИХ И ТЕХ ЖЕ задачах: качество + скорость.
// Запускать по одной модели за раз (две в 12 ГБ VRAM не влезут):
//   BENCH_URL=http://127.0.0.1:8081/v1 BENCH_MODEL=gemma26b   node agent/bench-compare.js gemma
//   BENCH_URL=http://127.0.0.1:8081/v1 BENCH_MODEL=gpt-oss-20b node agent/bench-compare.js gptoss
// Результат — JSON в agent/bench-results/<tag>.json, сравнение — bench-compare.js --diff
//
// Задачи СВЕЖИЕ (не из интернета): интернет-головоломки модели помнят, и тогда меряется
// память, а не рассуждение (доказано на бите-и-мяче — гемма брала её и без думалки).
const fs = require('fs');
const path = require('path');

const URL = process.env.BENCH_URL || 'http://127.0.0.1:8081/v1';
const MODEL = process.env.BENCH_MODEL || 'gemma26b';
const TAG = process.argv[2] || 'run';
const OUT_DIR = path.join(__dirname, 'bench-results');

// ── Задачи. Каждая — с однозначной проверкой (число/ключевые слова), без вкусовщины.
const TASKS = [
  // — многошаговый счёт (те же, на которых мерили свип думалки геммы)
  { id: 'станки', kind: 'calc', want: 506,
    q: 'В цехе 4 станка, каждый делает 23 детали в час. Смена длится 7 часов, но 2 станка простояли первые 3 часа. Сколько деталей выпущено за смену? Ответь числом.' },
  { id: 'книги', kind: 'calc', want: 9,
    q: 'Ящик с 6 книгами весит 4.2 кг. Пустой ящик весит 0.6 кг. Сколько килограммов весят 15 таких книг? Ответь числом.' },
  { id: 'скидка', kind: 'calc', want: 3965.76,
    q: 'Товар стоит 4800 рублей. Сначала дают скидку 15%, затем ещё 10% от уже сниженной цены. На финальную сумму начисляется налог 8%. Сколько платить? Ответь числом.' },
  { id: 'трубы', kind: 'calc', want: 2.4,
    q: 'Труба A наполняет бассейн за 6 часов, труба B — за 4 часа. За сколько часов они наполнят его вместе? Ответь числом.' },
  { id: 'поезд', kind: 'calc', want: 80,
    q: 'Поезд едет 240 км: первые 90 км со скоростью 60 км/ч, остальные — со скоростью 100 км/ч. Какова средняя скорость на всём пути в км/ч? Ответь числом.' },
  { id: 'возраст', kind: 'calc', want: 18,
    q: 'Отцу 42 года, сыну 12. Через сколько лет отец будет ровно вдвое старше сына? Ответь числом.' },

  // — суждение/скепсис (то, где 8B давала 0/3, а 26B — 3/3)
  { id: 'скепсис-винрейт', kind: 'regex',
    want: /(оверфит|переобуч|подгон|слишком корот|out-of-sample|вне выборк|комисси|проскальзыв|не стоит|осторож)/i,
    q: 'Стратегия показала 85% прибыльных сделок на бэктесте за 3 месяца, просадка 4%. Разработчик продаёт доступ за 500$. Стоит ли покупать? Дай короткий обоснованный вывод.' },
  { id: 'скепсис-гарантия', kind: 'regex',
    want: /(пирамид|скам|мошен|слишком хорош|не быва|подозрит|нереалист|не стоит|обман)/i,
    q: 'Схема обещает гарантированные 40% в месяц без риска, деньги можно забрать в любой момент. Вкладывать все сбережения?' },

  // — «Car Wash Test»: здравый смысл против шаблона. Виральный тест (март 2026), на котором
  //   провалились GPT-4/Claude/Gemini и наша gemma-26b: «50 метров» запускает эвристику
  //   «близко → пешком», и модель оптимизирует ДИСТАНЦИЮ вместо ВЫПОЛНИМОСТИ задачи.
  //   Проверяем не слово «ехать», а САМ ИНСАЙТ: без машины мыть будет нечего.
  { id: 'мойка-инсайт', kind: 'regex',
    want: /(машин[ауы][^.]{0,80}(должна быть|нужн|надо|пригнать|перегнать|окажется|останется|оставите|не будет))|(нечего (будет )?мыть)|(не сможете (её |ее )?помыть)|(без машины)|(мыть будет нечего)/i,
    q: 'Я хочу помыть свою машину. Автомойка находится в 50 метрах от дома. Мне пойти пешком или поехать?' },
  // страховка от ложного зачёта: если модель ПРЯМО советует идти пешком — это провал,
  // даже если где-то в тексте мелькнули нужные слова.
  { id: 'мойка-не-пешком', kind: 'notregex',
    want: /(логичнее|лучше|разумнее|проще|советую|рекоменду|стоит|оптимальн)[^.]{0,40}(пойти |идти )?пешком|пешком[^.]{0,30}(логичнее|лучше|разумнее|оптимальн)/i,
    q: 'Я хочу помыть свою машину. Автомойка находится в 50 метрах от дома. Мне пойти пешком или поехать?' },

  // — следование формату (важно для роутера/структурных задач харнеса)
  { id: 'json-формат', kind: 'json', want: { city: 'Мадрид', temp: 28 },
    q: 'Верни СТРОГО JSON без пояснений: {"city": "...", "temp": число}. Данные: в Мадриде 28 градусов.' },

  // — русский язык без дрейфа (боль linux-ассистента на 8B: уходила в китайский)
  { id: 'русский-краткость', kind: 'lang',
    q: 'Ответь ОДНИМ предложением по-русски: чем отличается оперативная память от постоянной?' },
];

const post = async (body, timeoutMs = 180000) => {
  const t0 = Date.now();
  const r = await fetch(`${URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return { j, ms: Date.now() - t0 };
};

// Числовая сверка с допуском: ищем ЛЮБОЕ число в ответе, совпадающее с эталоном.
function hasNumber(text, want) {
  const nums = (String(text).replace(/\s|&nbsp;/g, '').match(/-?\d+(?:[.,]\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(',', '.')));
  return nums.some((n) => Math.abs(n - want) < Math.max(0.01, Math.abs(want) * 0.002));
}

function check(t, text) {
  if (t.kind === 'calc') return hasNumber(text, t.want);
  if (t.kind === 'regex') return t.want.test(String(text));
  if (t.kind === 'notregex') return !t.want.test(String(text));   // провал = встретился шаблон
  if (t.kind === 'json') {
    try {
      const m = String(text).match(/\{[\s\S]*\}/);
      const o = JSON.parse(m ? m[0] : text);
      return String(o.city || '').toLowerCase().includes('мадрид') && Number(o.temp) === 28;
    } catch (_) { return false; }
  }
  if (t.kind === 'lang') {           // ответ должен быть по-русски и коротким
    const s = String(text);
    const cyr = (s.match(/[а-яё]/gi) || []).length;
    const lat = (s.match(/[a-z]/gi) || []).length;
    return cyr > 20 && cyr / (cyr + lat + 1) > 0.8;
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`БЕНЧ · model=${MODEL} · url=${URL} · tag=${TAG}\n`);

  // Поднять модель, если она выгружена idle-watchdog'ом. Голый fetch её не поднимает —
  // это делает наш server.ensure(). Работает только для локального llama-server на 8081.
  if (process.env.BENCH_NO_ENSURE !== '1' && /127\.0\.0\.1:8081/.test(URL)) {
    try { await require('./server').ensure({ log: (m) => console.log('  [модель] ' + m) }); }
    catch (e) { console.log('  ensure: ' + e.message); }
  }
  // Прогрев с ретраями: холодный старт модели ~12-15с, одиночный fetch сдаётся раньше и
  // роняет весь бенч (ловили). Ждём готовности до 3 минут, потом уже меряем.
  process.stdout.write('  прогрев (жду загрузку модели)… ');
  let warm = false;
  for (let i = 0; i < 30 && !warm; i++) {
    try { await post({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }, 20000); warm = true; }
    catch (_) { await new Promise((r) => setTimeout(r, 5000)); }
  }
  if (!warm) { console.log('модель не поднялась за 3 мин'); process.exit(1); }
  console.log('ок');

  const rows = [];
  for (const t of TASKS) {
    let ok = false, ms = 0, tok = 0, ans = '', think = 0, fin = '';
    try {
      const { j, ms: took } = await post({
        model: MODEL, temperature: 0.2, max_tokens: 8192,
        messages: [{ role: 'user', content: t.q }],
      });
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      ans = m.content || '';
      think = (m.reasoning_content || '').length;
      tok = (j.usage && j.usage.completion_tokens) || 0;
      fin = (j.choices && j.choices[0] && j.choices[0].finish_reason) || '';
      ms = took;
      ok = check(t, ans);
    } catch (e) { ans = 'ERR: ' + e.message; }
    const tps = ms > 0 ? (tok / (ms / 1000)) : 0;
    rows.push({ id: t.id, ok, ms, tok, tps: +tps.toFixed(1), think, fin, ans: ans.slice(0, 300) });
    console.log(`  ${ok ? '✅' : '❌'} ${t.id.padEnd(18)} ${(ms / 1000).toFixed(1).padStart(6)}с · ${String(tok).padStart(4)} ток · ${tps.toFixed(1).padStart(5)} t/s · думала ${String(think).padStart(5)} симв`);
  }

  const pass = rows.filter((r) => r.ok).length;
  const avgTps = rows.filter((r) => r.tps > 0).reduce((s, r) => s + r.tps, 0) / (rows.filter((r) => r.tps > 0).length || 1);
  const totalSec = rows.reduce((s, r) => s + r.ms, 0) / 1000;
  const summary = { tag: TAG, model: MODEL, pass, total: rows.length, avgTps: +avgTps.toFixed(1), totalSec: +totalSec.toFixed(1), rows };

  fs.writeFileSync(path.join(OUT_DIR, `${TAG}.json`), JSON.stringify(summary, null, 2));
  console.log(`\n  ИТОГО: ${pass}/${rows.length} верно · средняя скорость ${avgTps.toFixed(1)} t/s · суммарно ${totalSec.toFixed(0)}с`);
  console.log(`  сохранено: agent/bench-results/${TAG}.json`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
