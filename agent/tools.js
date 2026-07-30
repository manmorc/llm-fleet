const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Реестр тулзов автономного агента desktop-local.
// БЕЗОПАСНЫЕ (read-only, ограничены AGENT_ROOT) — включены всегда.
// РИСКОВЫЕ (write_file, shell) — только при AGENT_ALLOW_RISKY=1 (по умолчанию ВЫКЛ; апрув владельца).
// Границы: файловые операции не выходят за AGENT_ROOT; http_get — только localhost/tailnet.

const ALLOW_RISKY = process.env.AGENT_ALLOW_RISKY === '1';
const ROOT = path.resolve(process.env.AGENT_ROOT || process.cwd());
const MAX_OUT = 8000; // отсечка вывода тула, чтобы не раздувать контекст

function safePath(p) {
  const r = path.resolve(ROOT, p || '.');
  // 1) Лексическая проверка (быстрая, ловит ../).
  if (r !== ROOT && !r.startsWith(ROOT + path.sep)) throw new Error(`путь вне AGENT_ROOT: ${p}`);
  // 2) Резолв СИМЛИНКОВ: ссылка внутри ROOT может указывать НАРУЖУ, а лексика этого не видит.
  //    Файл может ещё не существовать (write_file создаёт новый) → резолвим ближайшего существующего предка.
  let realRoot; try { realRoot = fs.realpathSync(ROOT); } catch (_) { return r; } // нет ROOT — лексики достаточно
  let probe = r, real;
  for (;;) {
    try { real = fs.realpathSync(probe); break; }
    catch (_) { const up = path.dirname(probe); if (up === probe) { real = r; break; } probe = up; }
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`путь вне AGENT_ROOT (симлинк наружу?): ${p}`);
  return r;
}
function clip(s) { s = String(s); return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[обрезано, всего ${s.length} симв.]` : s; }

// Креды RAG — лениво из env или ~/.rag/rag.env (секрет локально, не дублируем). Present-but-inactive если нет.
function ragConfig() {
  let url = process.env.RAG_URL, token = process.env.RAG_TOKEN;
  if (!url || !token) {
    try {
      const env = fs.readFileSync(path.join(require('os').homedir(), '.rag', 'rag.env'), 'utf8');
      for (const line of env.split(/\r?\n/)) { const m = line.match(/^\s*(RAG_URL|RAG_TOKEN)\s*=\s*(.+?)\s*$/); if (m) { if (m[1] === 'RAG_URL') url = url || m[2]; else token = token || m[2]; } }
    } catch (_) {}
  }
  return { url: (url || '').replace(/\/$/, ''), token };
}

const REGISTRY = {
  list_dir: {
    safe: true,
    schema: { type: 'object', properties: { dir: { type: 'string', description: 'Путь относительно AGENT_ROOT (по умолч. .)' } } },
    description: 'Список файлов/папок в директории (в пределах AGENT_ROOT).',
    run: ({ dir = '.' }) => fs.readdirSync(safePath(dir), { withFileTypes: true })
      .slice(0, 300).map(d => (d.isDirectory() ? d.name + '/' : d.name)).join('\n') || '(пусто)',
  },
  read_file: {
    safe: true,
    schema: { type: 'object', properties: { file: { type: 'string', description: 'Путь к файлу относительно AGENT_ROOT' } }, required: ['file'] },
    description: 'Прочитать текстовый файл (в пределах AGENT_ROOT).',
    run: ({ file }) => clip(fs.readFileSync(safePath(file), 'utf8')),
  },
  count_lines: {
    safe: true,
    schema: { type: 'object', properties: { file: { type: 'string', description: 'Путь к файлу относительно AGENT_ROOT' } }, required: ['file'] },
    description: 'Точное число строк в файле (детерминированно). Используй ВМЕСТО ручного подсчёта — модель считает ненадёжно.',
    run: ({ file }) => { const c = fs.readFileSync(safePath(file), 'utf8'); if (!c.length) return '0'; return String(c.replace(/\r?\n$/, '').split(/\r?\n/).length); },
  },
  calc: {
    safe: true,
    schema: { type: 'object', properties: { expr: { type: 'string', description: 'Матвыражение: + - * / ^ (степень), скобки, функции exp() pow() sqrt() ln(), константа e. Напр. "(1+0.08/12)^12-1" или "exp(0.08)-1"' } }, required: ['expr'] },
    description: 'Посчитать математику ТОЧНО (арифметика, степени, exp/pow/sqrt/ln). Используй ВМЕСТО устного счёта — модель ошибается в математике, особенно в степенях/процентах.',
    run: ({ expr }) => {
      const e = String(expr).trim();
      const stripped = e.replace(/\b(exp|pow|sqrt|ln|e)\b/gi, '').trim();
      if (!/^[\d\s+\-*/^().,]*$/.test(stripped)) throw new Error('только числа, + - * / ^, скобки и функции exp/pow/sqrt/ln/e');
      const js = e.replace(/\^/g, '**').replace(/\bexp\b/gi, 'Math.exp').replace(/\bpow\b/gi, 'Math.pow').replace(/\bsqrt\b/gi, 'Math.sqrt').replace(/\bln\b/gi, 'Math.log').replace(/\be\b/gi, 'Math.E');
      const v = Function(`"use strict";return (${js})`)();
      if (!Number.isFinite(v)) throw new Error('нечисловой результат');
      return String(v);
    },
  },
  grep_file: {
    safe: true,
    schema: { type: 'object', properties: { file: { type: 'string' }, needle: { type: 'string', description: 'Подстрока для поиска' } }, required: ['file', 'needle'] },
    description: 'Найти строки в файле, содержащие подстроку (детерминированный поиск в контенте, без регистра). Используй ВМЕСТО чтения всего файла и ручного поиска.',
    run: ({ file, needle }) => {
      const lines = fs.readFileSync(safePath(file), 'utf8').split(/\r?\n/);
      const hits = lines.map((l, i) => ({ l, i: i + 1 })).filter((x) => x.l.toLowerCase().includes(String(needle).toLowerCase()));
      return hits.length ? clip(hits.map((h) => `${h.i}: ${h.l}`).join('\n')) : `(нет строк с "${needle}")`;
    },
  },
  json_query: {
    safe: true,
    schema: { type: 'object', properties: { file: { type: 'string' }, path: { type: 'string', description: 'Путь к полю через точку, напр. "service" или "config.port" или "items.0"' } }, required: ['file', 'path'] },
    description: 'Извлечь значение поля из JSON-файла точно по пути (dot-нотация, индексы массива числом). Используй ВМЕСТО чтения и ручного парсинга JSON.',
    run: ({ file, path: p }) => {
      let v = JSON.parse(fs.readFileSync(safePath(file), 'utf8'));
      for (const key of String(p).split('.')) { if (v == null) break; v = v[key]; }
      if (v === undefined) return `(поле "${p}" не найдено)`;
      return typeof v === 'object' ? clip(JSON.stringify(v)) : String(v);
    },
  },
  http_get: {
    safe: true,
    schema: { type: 'object', properties: { url: { type: 'string', description: 'URL (только localhost или tailnet 100.x)' } }, required: ['url'] },
    description: 'HTTP GET к localhost/tailnet (напр. локальный API). Внешние хосты запрещены.',
    run: async ({ url }) => {
      const u = new URL(url);
      // Tailnet CGNAT — это 100.64.0.0/10 (второй октет 64..127), а НЕ весь 100.0.0.0/8:
      // startsWith('100.') пускал бы публичные адреса вроде 100.20.x.x (AWS). Проверяем диапазон.
      const m = u.hostname.match(/^100\.(\d+)\./);
      const isTailnet = (m && +m[1] >= 64 && +m[1] <= 127) || u.hostname.endsWith('.ts.net');
      const ok = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || isTailnet;
      if (!ok) throw new Error(`хост запрещён: ${u.hostname} (только localhost/tailnet)`);
      // redirect:'error' — иначе разрешённый localhost мог 302-редиректить на внешний хост,
      // и мы бы вытащили его тело в обход allow-листа (проверяется только исходный hostname).
      const res = await fetch(url, { redirect: 'error' });
      return clip(`[${res.status}] ` + (await res.text()));
    },
  },
  self_test: {
    safe: true,
    schema: { type: 'object', properties: {} },
    description: 'Прогнать регрессионный тест агента (проверить, что харнес не сломан после изменения кода). Обязательно вызывай ПОСЛЕ правки своего кода. Возвращает pass/fail.',
    run: () => {
      const repo = path.join(__dirname, '..');
      try {
        const out = execSync(`node "${path.join(__dirname, 'regression.js')}"`, { cwd: repo, env: { ...process.env, AGENT_ROOT: path.join(require('os').homedir(), 'agent-sandbox') }, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        return clip(out.slice(-700));
      } catch (e) { return '🔴 РЕГРЕССИЯ УПАЛА (откати изменение!):\n' + String((e.stdout && e.stdout.toString()) || e.message).slice(-700); }
    },
  },
  rag_search: {
    safe: true,
    schema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string', description: 'work|personal|agent|trading|principles (опц.)' } }, required: ['query'] },
    description: 'Найти релевантные ФАКТЫ в общем RAG-архиве флота (семантический поиск). Используй для знаниевых вопросов (доменные механики/специфика), которых можешь не знать — не выдумывай.',
    run: async ({ query, scope }) => {
      const cfg = ragConfig();
      if (!cfg.url || !cfg.token) return 'RAG не настроен на этой ноде (нет ~/.rag/rag.env с RAG_URL/RAG_TOKEN). Факты недоступны — ответь по своим знаниям, честно пометив неуверенность.';
      try {
        const res = await fetch(`${cfg.url}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify({ query, scope, k: 5 }) });
        if (!res.ok) return `RAG ${res.status} (поиск недоступен)`;
        const j = await res.json();
        const items = j.results || j.matches || j.hits || (Array.isArray(j) ? j : []);
        if (!items.length) return '(RAG: релевантных фактов не найдено)';
        return clip(items.map((it, i) => `[${i + 1}] ${it.text || it.content || it.chunk || JSON.stringify(it)}`).join('\n'));
      } catch (e) { return `RAG ошибка: ${e.message}`; }
    },
  },
  // Связь с ДРУГИМИ МАШИНАМИ флота через agent-bus. Отправка подписывается Ed25519-ключом ноды,
  // получатель видит ✓ — это и есть цепочка доверия шины. Ответ придёт асинхронно (в inbox ноды),
  // здесь мы его НЕ ждём: агент отправляет и продолжает, ответ прочитает владелец/сессия из лога.
  // safe: отправка сообщения — не деструктивное действие; ключ подписи наружу не уходит.
  bus_send: {
    safe: true,
    schema: { type: 'object', properties: {
      to: { type: 'string', description: 'кому: linux-prestige | mac-artyom | desktop-tt4i69c | all (broadcast)' },
      text: { type: 'string', description: 'текст сообщения' },
    }, required: ['to', 'text'] },
    description: 'Написать ДРУГОЙ МАШИНЕ флота (linux-prestige, mac-artyom) или всем (all) через agent-bus. Используй, когда задача требует данных/действий с другой ноды: спросить статус, попросить факт, скоординировать работу. Ответ придёт асинхронно, здесь его не жди.',
    run: async ({ to, text }) => {
      const dst = String(to || '').trim();
      if (!dst) throw new Error('нужен получатель (to)');
      const out = execSync(
        `node "${path.join(__dirname, '..', 'mcp', 'bus-send.js')}" ${dst} ${JSON.stringify(String(text))}`,
        { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: path.join(__dirname, '..') });
      return clip(out.trim() || `отправлено → ${dst}`);
    },
  },
  // Кто из машин флота сейчас онлайн (presence в Redis). Нужно, чтобы агент не слал в пустоту.
  bus_who: {
    safe: true,
    schema: { type: 'object', properties: {} },
    description: 'Показать, какие машины флота сейчас онлайн (presence). Проверь перед bus_send, что адресат на связи.',
    run: () => {
      const out = execSync(`node "${path.join(__dirname, '..', 'mcp', 'bus-send.js')}" --who`,
        { encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: path.join(__dirname, '..') });
      return clip(out.trim() || '(нет данных)');
    },
  },
  // ── РИСКОВЫЕ (за флагом) ──────────────────────────────────────────────
  write_file: {
    safe: false,
    schema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' }, purpose: { type: 'string', description: 'Короткая цель действия (для надзора)' } }, required: ['file', 'content'] },
    description: 'Записать файл (в пределах AGENT_ROOT). РИСКОВЫЙ — требует AGENT_ALLOW_RISKY=1. Укажи purpose.',
    run: ({ file, content }) => {
      // content ОБЯЗАН быть строкой ДО записи. Иначе: модель обрывает tool-call на max_tokens →
      // safeJson даёт {} → content=undefined → String(undefined)='undefined' затирал бы файл (в self-dev —
      // исходник самого агента), и только ПОТОМ падал на content.length. Проверяем до записи, не после.
      if (typeof content !== 'string') throw new Error('write_file: content отсутствует или не строка (вероятно, tool-call оборван) — запись отменена');
      fs.writeFileSync(safePath(file), content);
      return `записано ${file} (${content.length} симв.)`;
    },
  },
  shell: {
    safe: false,
    schema: { type: 'object', properties: { cmd: { type: 'string' }, purpose: { type: 'string', description: 'Короткая цель команды (для надзора)' } }, required: ['cmd'] },
    description: 'Выполнить shell-команду в AGENT_ROOT. РИСКОВЫЙ — требует AGENT_ALLOW_RISKY=1. Укажи purpose.',
    run: ({ cmd }) => { const out = execSync(cmd, { cwd: ROOT, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); return out.length > 3000 ? out.slice(0, 3000) + `\n…[вывод обрезан, всего ${out.length} симв.]` : out; },
  },
};

function enabled(name) { const t = REGISTRY[name]; return t && (t.safe || ALLOW_RISKY); }

// Схемы включённых тулзов в формате ollama/OpenAI (для поля tools в /api/chat).
function schemas() {
  return Object.entries(REGISTRY).filter(([n]) => enabled(n)).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.schema },
  }));
}

async function exec(name, args) {
  const t = REGISTRY[name];
  if (!t) throw new Error(`неизвестный тул: ${name}`);
  if (!enabled(name)) throw new Error(`тул "${name}" выключен (рисковый; нужен AGENT_ALLOW_RISKY=1 + апрув владельца)`);
  if (t.safe) return await t.run(args || {});
  // Рисковый тул → надзор (гейт + аудит), результат верифицируется пост-фактум.
  const supervisor = require('./supervisor');
  const g = await supervisor.gate({ tool: name, args, reason: (args && (args.purpose || args.reason)) || undefined });
  if (!g.allowed) return `⛔ BLOCKED надзором: ${g.reason}. Действие не выполнено — предложи безопасную альтернативу или объясни необходимость.`;
  try {
    const out = await t.run(args || {});
    supervisor.recordResult(g.id, name, true, out);
    return out;
  } catch (e) {
    supervisor.recordResult(g.id, name, false, e.message);
    throw e;
  }
}

module.exports = { schemas, exec, enabled, REGISTRY, ROOT, ALLOW_RISKY, safePath };
