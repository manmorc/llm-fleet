// ПРОВЕРКА ОКРУЖЕНИЯ ПЕРЕД ЗАМЕРОМ: спросить у сервера, ЧТО он на самом деле,
// и отказаться считать, если это не то, что заявлено.
//
// ПОВОД. 11.08.2026 замер качества gpt-oss-120b дал 4 из 8 и был подан как «модель хуже».
// На деле сервер работал с контекстом 8192, тогда как сравниваемая с ним 20B — со 131072.
// В логе прямым текстом: «failed to find free space in the KV cache». Потолок вывода инструментов
// при этом считался от переменной LLAMA_CTX=131072 и равнялся 32768 знакам — агент честно клал в
// контекст файл, которому там не было места. Провалы выглядели как «модель поленилась»: один вызов
// инструмента, восемьдесят секунд. Мы измерили мою конфигурацию и чуть не записали её в свойства
// модели.
//
// Проверять надо ФАКТ У СЕРВЕРА, а не переменную окружения: именно расхождение между тем, что мы
// задали, и тем, что получилось, и есть источник таких ошибок. Переменная говорит о намерении,
// сервер — о результате. Тот же принцип, что «успех по факту, а не по отправке команды».
//
// Использование:
//   const { preflight } = require('./preflight');
//   const env = await preflight({ url, expectCtx: 131072 });   // бросит, если не сошлось

async function serverFacts(url, timeoutMs = 20000) {
  const base = String(url).replace(/\/v1\/?$/, '');
  const res = await fetch(`${base}/props`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`сервер ${base} ответил ${res.status} на /props`);
  const j = await res.json();
  const gen = j.default_generation_settings || {};
  return {
    base,
    ctx: gen.n_ctx ?? j.n_ctx ?? null,
    model: j.model_path || j.model || (gen.model || null),
    nSlots: j.total_slots ?? null,
    raw: j,
  };
}

async function preflight({ url, expectCtx = null, expectModelSubstr = null, log = console.log } = {}) {
  let f;
  try { f = await serverFacts(url); }
  catch (e) { throw new Error(`ПРЕДПОЛЁТНАЯ ПРОВЕРКА: сервер ${url} недоступен — ${e.message}`); }

  const name = f.model ? String(f.model).split(/[\\/]/).pop() : '(имя не сообщено)';
  log(`окружение: ${f.base} · модель ${name} · контекст ${f.ctx} · слотов ${f.nSlots}`);

  const problems = [];
  if (expectCtx && f.ctx !== expectCtx) {
    problems.push(`контекст сервера ${f.ctx}, ожидался ${expectCtx}`
      + ` — сравнение с другой моделью на другом контексте НЕДЕЙСТВИТЕЛЬНО`);
  }
  if (expectModelSubstr && !String(f.model || '').toLowerCase().includes(String(expectModelSubstr).toLowerCase())) {
    problems.push(`модель «${name}» не содержит «${expectModelSubstr}» — считаем не то, что думаем`);
  }
  // Потолок вывода инструмента живёт в tools.js и считается от LLAMA_CTX. Если переменная
  // расходится с фактическим контекстом сервера, агент будет класть в промпт больше, чем влезает,
  // и получать переполнение KV — молча, в виде плохих ответов.
  const envCtx = parseInt(process.env.LLAMA_CTX || '131072', 10);
  if (f.ctx && envCtx !== f.ctx) {
    problems.push(`LLAMA_CTX=${envCtx} не совпадает с контекстом сервера ${f.ctx}`
      + ` — потолок вывода инструментов рассчитан не на тот размер`);
  }

  if (problems.length) {
    throw new Error('ПРЕДПОЛЁТНАЯ ПРОВЕРКА НЕ ПРОЙДЕНА:\n  • ' + problems.join('\n  • ')
      + '\n  Замер остановлен: лучше не получить числа, чем получить неверные.');
  }
  log('предполётная проверка пройдена ✓');
  return f;
}

module.exports = { preflight, serverFacts };
