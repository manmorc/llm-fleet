#!/usr/bin/env node
// ЕЖЕДНЕВНОЕ РЕТРО РАБОТЫ С АГЕНТАМИ — директива владельца 31.07.2026, подтверждена им лично:
// «анализировать дневные сессии и оптимизировать работу — какие ошибки были и как их больше
// не совершать, что делали долго, а могли намного быстрее, плюс смотреть и менять/удалять
// что мешало — и улучшать, каждый день».
//
// ⚠️ ЛИМИТЫ (PRINCIPLES §9): это cron, ЗОВУЩИЙ Claude — та самая категория, что выжгла недельные
// лимиты владельца. Разрешено ИСКЛЮЧЕНИЕМ «узкая раз-в-сутки задача по ЯВНОЙ просьбе владельца».
// Поэтому жёстко: РОВНО раз в сутки, с ограничением объёма, и с ранним выходом, если разбирать нечего.
// Никаких «дожать ещё разок» — это прямой путь обратно к выжженным лимитам.
//
// Разбирает ТОЛЬКО транскрипты ЭТОЙ машины (~/.claude/projects/**/*.jsonl), за прошедшие сутки.
// Стандарт классов ошибок — общефлотский RETRO STANDARD v1.1 (сведён с linux-prestige).
//
// Запуск: node agent/daily-retro.js [--dry]
//   --dry — показать, что бы отправилось в Claude, но НЕ запускать его (проверка без расхода лимитов)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const STATE = path.join(os.homedir(), '.agent-bus', 'retro.state.json');
const WINDOW_MS = 24 * 3600 * 1000;
const MAX_CHARS = 60000;          // потолок выжимки: не тащим в Claude мегабайты
const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');

const log = (m) => console.log(`${new Date().toISOString()} [retro] ${m}`);

// Защита от повторного запуска в те же сутки (планировщик может дёрнуть дважды после сна/ребута).
function alreadyRanToday() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return s.last && (Date.now() - s.last) < 20 * 3600 * 1000;
  } catch (_) { return false; }
}
function markRan() { try { fs.writeFileSync(STATE, JSON.stringify({ last: Date.now() })); } catch (_) {} }

// Собираем реплики за сутки: только текст user/assistant, без tool-результатов (они раздувают объём,
// а сигнал об ошибках — в формулировках владельца и в моих выводах).
function collect() {
  const since = Date.now() - WINDOW_MS;
  const out = [];
  let files = [];
  try {
    for (const proj of fs.readdirSync(PROJECTS)) {
      const dir = path.join(PROJECTS, proj);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs >= since) files.push({ proj, p });
      }
    }
  } catch (_) {}

  for (const { proj, p } of files) {
    let lines = [];
    try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch (_) { continue; }
    for (const line of lines) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const ts = Date.parse(o.timestamp || '') || 0;
      if (ts && ts < since) continue;
      let role = null, text = '';
      if (o.type === 'user' && o.message) {
        role = 'ВЛАДЕЛЕЦ';
        text = typeof o.message.content === 'string' ? o.message.content
          : ((o.message.content || []).find((c) => c.type === 'text') || {}).text || '';
      } else if (o.type === 'assistant' && o.message) {
        role = 'АГЕНТ';
        text = ((o.message.content || []).find((c) => c.type === 'text') || {}).text || '';
      }
      if (!role || !text.trim()) continue;
      if (/^\[SYSTEM NOTIFICATION|^<task-notification|^<system-reminder/.test(text)) continue;
      out.push(`[${proj}] ${role}: ${text.replace(/\s+/g, ' ').slice(0, 1200)}`);
    }
  }
  return out;
}

const PROMPT = `Проведи РЕТРО моей работы за прошедшие сутки по транскриптам ниже.

Стандарт классов ошибок (RETRO STANDARD v1.1, общефлотский):
1) ждал-вместо-делать — остановился ради апрува там, где владельца у машины нет
2) ложный замер — валидатор не проверен на известных примерах, вывод может быть противоположным
3) тихий сбой — «успех» без проверки результата; подкласс «успешно, но деградировало» (скорость/каденция)
4) добавил-инструкций→хуже — усложнение промпта без замера
5) слепая зона мониторинга — метрика собирается в одной точке, а путей входа несколько
6) ложная тревога — красный флаг на неactionable, приучает игнорировать алерты
7) передача между нодами — несамодостаточность (хардкод путей, недостающие зависимости)
8) деплой без перезапуска всех потребителей общего модуля
9) дисплей-честность — подал вывод увереннее, чем позволяют данные (малое n «зелёным»)
10) re-brief — что именно было неясно в задаче владельца
11) незакреплённое знание — заново выяснял то, что уже записано в памяти

ЧТО СДЕЛАТЬ (кратко, по делу, без воды):
A. Найди КОНКРЕТНЫЕ случаи этих классов в транскриптах. Цитируй маркер. Если класса не было — не выдумывай.
B. Что делал ДОЛГО, а можно было быстро? Назови точку, где потерял время, и как срезать в следующий раз.
C. Что МЕШАЛО (правило/настройка/процесс) — предложи изменить или удалить, с обоснованием.
D. Что стоит ЗАКРЕПИТЬ в память (~/.claude/projects/C--Users-makei/memory/) — только то, что не выводится
   из кода и git-истории, и реально пригодится снова.

ПРАВИЛА:
- Негативный результат — результат. Если сутки прошли чисто, так и скажи, не высасывай проблемы.
- Только то, что подтверждается транскриптом. Не домысливай.
- Правки в память делай сам (Write), правки в код — только ПРЕДЛОЖЕНИЕМ, не применяй.
- Не трогай деньги, деплой, внешние публикации.
- В конце — 5 строк итога для владельца в Telegram.

ТРАНСКРИПТЫ ЗА СУТКИ:
`;

(async () => {
  if (!DRY && alreadyRanToday()) { log('уже запускалось за последние 20ч — выхожу (защита от дубля)'); return; }

  const lines = collect();
  if (lines.length < 10) { log(`реплик за сутки: ${lines.length} — разбирать нечего, выхожу без вызова Claude`); return; }

  let body = lines.join('\n');
  if (body.length > MAX_CHARS) body = body.slice(-MAX_CHARS);   // берём ХВОСТ (свежее важнее)
  const full = PROMPT + body;
  log(`собрано реплик: ${lines.length}, символов: ${full.length}`);

  if (DRY) {
    console.log('\n--- DRY: промпт (первые 1500 симв) ---\n');
    console.log(full.slice(0, 1500));
    console.log(`\n--- ... всего ${full.length} симв. Claude НЕ запускался. ---`);
    return;
  }

  markRan();
  try {
    log('запускаю Claude для разбора…');
    const out = execFileSync(CLAUDE, ['-p', full], {
      encoding: 'utf8', timeout: 25 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
      cwd: path.join(os.homedir(), 'llm-fleet'),
    });
    log('ретро завершено');
    const tail = String(out).trim().split('\n').slice(-6).join('\n');
    try {
      const { notify } = require('./notify');
      await notify({ topic: 'ретро за сутки', result: tail.slice(0, 100) || 'без замечаний', ok: true });
    } catch (_) {}
    console.log(out);
  } catch (e) {
    log(`ошибка: ${e.message}`);
    try { require('./escalate').escalate('daily-retro', e.message); } catch (_) {}
  }
})();
