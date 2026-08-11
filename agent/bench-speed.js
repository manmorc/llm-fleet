// ЗАМЕР СКОРОСТИ МОДЕЛИ НА ЭТОМ ЖЕЛЕЗЕ: время до первого токена и токены в секунду.
//
// Меряем ТРИ разных режима, потому что для модели, которая не влезает в память, это три разные
// физики, и одна усреднённая цифра врёт:
//   ХОЛОДНЫЙ  — дисковый кэш пуст, эксперты читаются с SSD. Худший случай, он же первый запрос дня.
//   ТЁПЛЫЙ    — тот же запрос повторно: горячие эксперты уже в кэше. Лучший случай.
//   ДЛИННЫЙ   — промпт как в агентском харнесе (системный промпт + схемы инструментов ≈ 3.3к токенов).
//               Здесь важно не tok/s, а ОЖИДАНИЕ ПЕРВОГО ТОКЕНА: при обработке промпта пачкой
//               задействуется широкое объединение экспертов, и читается заметная часть модели.
//
// Числа берём из ответа самого сервера (timings), а не из своего секундомера: он отделяет обработку
// промпта от генерации, а секундомер снаружи их складывает и превращает в кашу.
//
// Запуск: node agent/bench-speed.js [--url http://127.0.0.1:8082] [--tokens 64] [--label имя]
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const URL = arg('--url', 'http://127.0.0.1:8082');
const NTOK = parseInt(arg('--tokens', '64'), 10);
const LABEL = arg('--label', 'модель');

const SHORT = 'Напиши функцию на JavaScript, которая переворачивает строку. Только код.';
// Длинный промпт набираем осмысленным текстом, а не повтором одной фразы: повтор сжимается
// вниманием иначе и занижает нагрузку на маршрутизатор экспертов.
const LONG = (() => {
  const para = [
    'Ты инженер, сопровождающий распределённую систему из нескольких машин.',
    'Доступны инструменты: чтение файла, запись файла, поиск по содержимому, запуск команд оболочки,',
    'проверка состояния репозитория, отправка сообщений другим узлам, поиск в базе знаний.',
    'Каждый инструмент принимает объект с полями и возвращает текст либо ошибку с причиной.',
    'Правила работы: сначала прочитай, потом правь; правку делай в одном месте за раз;',
    'после изменения обязательно проверь запуском тестов; о неудаче сообщай честно с числами.',
    'Ошибки не проглатывай: пустой результат не является ответом, у отказа должна быть названа причина.',
    'Не выходи за пределы рабочего каталога, не трогай ключи и учётные данные.',
  ].join(' ');
  let s = '';
  while (s.length < 13000) s += para + ' ';
  return s + '\n\nВопрос: перечисли три правила из инструкции выше, которые касаются проверки результата.';
})();

async function run(prompt, note) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${URL}/completion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, n_predict: NTOK, temperature: 0.2, cache_prompt: false }),
    });
  } catch (e) { return { note, error: e.message }; }
  if (!res.ok) return { note, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
  const j = await res.json();
  const t = j.timings || {};
  return {
    note,
    wallSec: (Date.now() - t0) / 1000,
    promptTokens: t.prompt_n,
    ttftSec: t.prompt_ms !== undefined ? t.prompt_ms / 1000 : null,
    promptTps: t.prompt_per_second,
    genTokens: t.predicted_n,
    genSec: t.predicted_ms !== undefined ? t.predicted_ms / 1000 : null,
    tps: t.predicted_per_second,
    sample: (j.content || '').replace(/\s+/g, ' ').slice(0, 70),
  };
}

const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

(async () => {
  console.log(`\n${'═'.repeat(72)}\n${LABEL} · ${URL}\n${'═'.repeat(72)}`);
  const out = [];

  process.stdout.write('  холодный (короткий промпт)… ');
  const cold = await run(SHORT, 'холодный');
  out.push(cold);
  console.log(cold.error ? `ОШИБКА: ${cold.error}` : `${fmt(cold.tps)} ток/с`);

  process.stdout.write('  тёплый (тот же промпт)…     ');
  const warm = await run(SHORT, 'тёплый');
  out.push(warm);
  console.log(warm.error ? `ОШИБКА: ${warm.error}` : `${fmt(warm.tps)} ток/с`);

  process.stdout.write('  длинный промпт (~3.3к ток)… ');
  const long = await run(LONG, 'длинный');
  out.push(long);
  console.log(long.error ? `ОШИБКА: ${long.error}` : `первый токен через ${fmt(long.ttftSec, 1)} с`);

  console.log('');
  console.log('  режим      промпт(ток)  до 1-го токена  обработка(ток/с)  генерация(ток/с)');
  for (const r of out) {
    if (r.error) { console.log(`  ${r.note.padEnd(11)}ОШИБКА: ${r.error}`); continue; }
    console.log(`  ${r.note.padEnd(11)}${String(r.promptTokens).padStart(8)}`
      + `${fmt(r.ttftSec, 1).padStart(16)} с`
      + `${fmt(r.promptTps, 1).padStart(17)}`
      + `${fmt(r.tps, 2).padStart(18)}`);
  }
  console.log('');
  for (const r of out) if (!r.error) console.log(`  [${r.note}] ${r.sample}`);
  console.log('');
})();
