#!/usr/bin/env node
// Регрессионный харнес агента: один прогон проверяет тулзы+петлю, классификацию и диспозиция-каркас.
// Красный флаг при просадке (§7/§8: silent truncation = ложное «всё покрыто»). Задачи — generic (не торговые).
//   AGENT_ROOT=~/agent-sandbox node agent/regression.js
const { runAgent } = require('./loop');
const { classify, runAgentAuto } = require('./router');
const MODEL = process.env.MODEL || 'gemma4:latest';
const THRESHOLD = 0.9;

const has = (s) => (a) => a.toLowerCase().includes(String(s).toLowerCase());
const reg = (re) => (a) => re.test(a.toLowerCase());

// 1. Тулзы+петля (структура/точность) — в песочнице AGENT_ROOT
const TOOLS = [
  { id: 'count-lines', q: 'Сколько строк в файле numbers.txt? Ответь числом.', ok: has('4') },
  { id: 'json-field', q: 'Назови значение поля port из config.json.', ok: has('11434') },
  { id: 'sum-calc', q: 'Сложи числа из numbers.txt. Ответь числом.', ok: has('100') },
  { id: 'grep', q: "В каком файле (log1.txt или log2.txt) есть слово 'секрет'?", ok: has('log2') },
];
// 2. Классификация (generic-задачи, не торговые)
const CLS = [
  { q: 'Посчитай, насколько вырастет вклад под 5% за 3 года при ежегодной капитализации.', want: 'reasoning' },
  { q: 'Извлеки email из строки "контакт: a@b.com, тел 123".', want: 'structure' },
  { q: 'Предложение обещает удвоение денег за месяц гарантированно. Стоит вкладываться?', want: 'disposition' },
];
// 3. Диспозиция-каркас: скептик должен флажить «слишком хорошо» (generic, не торговое)
const DISPO = { q: 'Схема обещает гарантированные 40% в месяц без риска. Вкладывать все сбережения?',
  ok: reg(/(слишком хорош|подозрит|пирамид|скам|осторож|не стоит|риск|гаранти.{0,20}не быва|нереалист)/) };

// ГВАРД VRAM. Замерено (стоило 20 минут охоты за фантомом): когда llama-server держал 8.4 из 12.3 ГБ,
// ollama выдавливала gemma4 на CPU — и та ДЕТЕРМИНИРОВАННО давала другой ответ (classify: structure
// вместо reasoning, 7/7; на свободной VRAM — reasoning 3/3). Другие ядра → другая арифметика →
// на пограничном решении токен переворачивается. Плюс 28с/вызов вместо 6.3с → регрессия ловит таймаут.
// Нехватка VRAM бьёт не только по скорости, но и по ПРАВИЛЬНОСТИ. Ложный провал хуже, чем отсутствие
// прогона: он отправляет чинить несуществующий баг. Поэтому — отказываемся, а не врём (§7).
function vramGuard() {
  let free;
  try {
    const out = require('child_process').execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    free = parseInt(String(out).trim().split('\n')[0], 10);
  } catch (_) { return; } // нет nvidia-smi (не Windows/нет карты) — не наше дело, пропускаем
  if (!Number.isFinite(free) || free >= 5000) return;
  console.error(`🔴 ОТКАЗ: свободно всего ${free} МБ VRAM — модель уедет на CPU.\n` +
    `   Это НЕ просто медленнее: на CPU другая арифметика и ответы МЕНЯЮТСЯ (замерено).\n` +
    `   Прогон дал бы ЛОЖНЫЕ провалы. Освободи VRAM и повтори:\n` +
    `     Stop-Process -Name llama-server -Force     (или Gemma26B-stop.cmd)\n` +
    `   Осознанно всё равно прогнать: REGRESSION_ALLOW_CPU=1`);
  process.exit(2);
}

(async () => {
  if (process.env.REGRESSION_ALLOW_CPU !== '1') vramGuard();
  let pass = 0, total = 0; const fails = [];
  console.log(`РЕГРЕССИЯ агента · model=${MODEL} · root=${process.env.AGENT_ROOT}\n`);
  console.log('— тулзы+петля —');
  for (const t of TOOLS) {
    total++; let a = ''; try { a = (await runAgent(t.q, { model: MODEL, maxSteps: 6 })).answer; } catch (e) { a = 'ERR:' + e.message; }
    const ok = t.ok(a); if (ok) pass++; else fails.push(t.id);
    console.log(`  ${ok ? '✅' : '❌'} ${t.id}`);
  }
  console.log('— классификация —');
  for (const c of CLS) {
    total++; const got = await classify(c.q, { model: MODEL }); const ok = got === c.want;
    if (ok) pass++; else fails.push(`cls:${c.want}→${got}`);
    console.log(`  ${ok ? '✅' : '❌'} ${c.want}${ok ? '' : ' (got ' + got + ')'}`);
  }
  console.log('— диспозиция-каркас —');
  total++; let ad = ''; try { ad = (await runAgentAuto(DISPO.q, { model: MODEL, maxSteps: 2 })).answer; } catch (e) { ad = 'ERR'; }
  const okd = DISPO.ok(ad); if (okd) pass++; else fails.push('dispo-skeptic');
  console.log(`  ${okd ? '✅' : '❌'} skeptic-flag`);

  console.log('— reasoning-класс —');
  total++; let rr = {}; try { rr = await runAgentAuto('Что больше: 2 в степени 10 или 10 в степени 3, и на сколько? Рассуждай.', { maxSteps: 3 }); } catch (_) {}
  // REASON_MODEL по умолчанию пуст (r1 удалена) → reasoning идёт на основную модель + CoT.
  // Проверяем классификацию и ПРАВИЛЬНОСТЬ ответа, а не конкретную модель.
  const okr = rr.class === 'reasoning' && String(rr.answer).includes('1024');
  if (okr) pass++; else fails.push(`reasoning(cls=${rr.class})`);
  console.log(`  ${okr ? '✅' : '❌'} reasoning классифицирован + верно (1024 vs 1000)`);

  console.log('— knowledge→needsFacts (RAG inactive) —');
  total++; let rk = {}; try { rk = await runAgentAuto('Стоит ли гнаться за фандингом 300% на тонком альткоине для дельта-нейтрального арбитража?', { maxSteps: 2 }); } catch (_) {}
  // без RAG-кредов knowledge-класс должен пометить needsFacts (сигнал подтянуть факт), не выдумывать
  const okk = rk.class === 'knowledge';
  if (okk) pass++; else fails.push(`knowledge-cls(got=${rk.class})`);
  console.log(`  ${okk ? '✅' : '❌'} knowledge classified (needsFacts=${rk.needsFacts})`);

  const rate = pass / total;
  console.log(`\nИТОГО: ${pass}/${total} (${(rate * 100).toFixed(0)}%)${fails.length ? ' · провалы: ' + fails.join(', ') : ''}`);
  if (rate < THRESHOLD) { console.log(`🔴 РЕГРЕССИЯ: ниже порога ${THRESHOLD * 100}%`); process.exit(1); }
  console.log('🟢 OK');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
