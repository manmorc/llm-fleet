const fs = require('fs');
const path = require('path');
// execFileSync (не execSync) для git: аргументы передаются массивом и НЕ проходят через шелл,
// поэтому сообщение коммита или имя ветки не могут стать командой. Через execSync это была бы
// инъекция: текст сообщения агент формирует сам, а часть его приходит из задачи владельца.
const { execSync, execFileSync } = require('child_process');

// Реестр тулзов автономного агента desktop-local.
// БЕЗОПАСНЫЕ (read-only, ограничены AGENT_ROOT) — включены всегда.
// РИСКОВЫЕ (write_file, shell) — только при AGENT_ALLOW_RISKY=1 (по умолчанию ВЫКЛ; апрув владельца).
// Границы: файловые операции не выходят за AGENT_ROOT; http_get — только localhost/tailnet.

const ALLOW_RISKY = process.env.AGENT_ALLOW_RISKY === '1';
const ROOT = path.resolve(process.env.AGENT_ROOT || process.cwd());
// Отсечка вывода тулзы. ВЫВОДИТСЯ ИЗ КОНТЕКСТА, а не зашита числом: 8000 было подобрано под ctx=16384,
// и после перехода на 131072 (31.07.2026) агент по-прежнему видел бы 8 КБ любого файла — то есть 31%
// tools.js. Замер это и поймал: задача «добавь инструмент в REGISTRY» провалилась, потому что конец
// файла модели просто не показывали. Тот же класс, что зашитый бюджет компакта: константа под старый
// контекст пережила его рост. ~4 симв/токен → 32 КБ ≈ 8k токенов, это укладывается в бюджет компакта.
const MAX_OUT = parseInt(process.env.AGENT_MAX_TOOL_OUT
  || String(Math.max(8000, Math.floor(parseInt(process.env.LLAMA_CTX || '131072', 10) / 4))), 10);

function safePath(p) {
  const r = path.resolve(ROOT, p || '.');
  // 1) Лексическая проверка (быстрая, ловит ../).
  if (r !== ROOT && !r.startsWith(ROOT + path.sep)) throw new Error(`путь "${p}" вне рабочей папки. Тебе доступна только "${ROOT}" и её подпапки — задавай путь относительно неё (например "src/файл.js"), без ".." и без абсолютных путей. Посмотреть, что есть, можно через list_dir.`);
  // 2) Резолв СИМЛИНКОВ: ссылка внутри ROOT может указывать НАРУЖУ, а лексика этого не видит.
  //    Файл может ещё не существовать (write_file создаёт новый) → резолвим ближайшего существующего предка.
  let realRoot; try { realRoot = fs.realpathSync(ROOT); } catch (_) { return r; } // нет ROOT — лексики достаточно
  let probe = r, real;
  for (;;) {
    try { real = fs.realpathSync(probe); break; }
    catch (_) { const up = path.dirname(probe); if (up === probe) { real = r; break; } probe = up; }
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`путь "${p}" ведёт наружу рабочей папки через симлинк. Доступна только "${ROOT}" — выбери файл внутри неё (list_dir покажет содержимое).`);
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
      if (!Number.isFinite(v)) throw new Error('выражение дало не число (бесконечность или NaN). Частые причины: деление на ноль, ln или sqrt от отрицательного, переполнение. Проверь выражение и посчитай заново.');
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
  // ── GIT ─────────────────────────────────────────────────────────────────────────────────────────
  // Зачем агенту git: замер 01.08.2026 показал, что правки локальной модели ОБЯЗАНЫ проходить
  // построчное ревью — «тесты зелёные» пропускает порчу в непокрытых строках. Значит дифф не
  // удобство, а условие применимости, и получить его должен сам агент.
  //
  // ЧТО НАМЕРЕННО НЕ ДАНО и почему: push, merge, rebase, reset, checkout, любые операции с историей
  // и с удалённым репозиторием. Агент работает ТОЛЬКО в рабочем дереве и делает коммиты в ветку —
  // всё остальное необратимо или влияет на других, и это решение владельца, а не модели.
  // git_status/git_diff безопасны (чтение), git_commit рисковый — идёт через надзор.
  git_status: {
    safe: true,
    schema: { type: 'object', properties: {} },
    description: 'Показать изменённые файлы в рабочей папке (git status). Используй, чтобы понять, что ты уже наменял.',
    run: async () => {
      try {
        const out = execFileSync('git', ['status', '--porcelain', '-b'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
        return out.trim() || '(изменений нет — рабочее дерево чистое)';
      } catch (e) { return `git status не выполнился: ${String(e.message).slice(0, 200)}. Возможно, папка не git-репозиторий.`; }
    },
  },
  git_diff: {
    safe: true,
    schema: { type: 'object', properties: { file: { type: 'string', description: 'Конкретный файл (опц.); без него — все изменения' } } },
    description: 'Показать ДИФФ своих правок (git diff). Обязательно проверяй им себя после правок: увидишь, не задел ли лишнего.',
    run: async ({ file }) => {
      try {
        const args = ['diff', '--unified=3'];
        if (file) args.push('--', file);
        const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
        return clip(out.trim() || '(диффа нет — файлы не изменены)');
      } catch (e) { return `git diff не выполнился: ${String(e.message).slice(0, 200)}`; }
    },
  },
  git_commit: {
    schema: { type: 'object', properties: {
      message: { type: 'string', description: 'Сообщение коммита: что и зачем изменено' },
      branch: { type: 'string', description: 'Имя ветки. Будет создана с префиксом agent/ — в существующие ветки коммитить нельзя' },
      purpose: { type: 'string', description: 'Зачем этот коммит' },
    }, required: ['message', 'branch'] },
    description: 'Закоммитить свои правки в НОВУЮ ветку agent/<имя>. Только коммит: push, merge и работа с историей тебе недоступны — ветку смотрит и вливает владелец.',
    run: async ({ message, branch }) => {
      if (typeof message !== 'string' || message.trim().length < 10) {
        return 'коммит отменён: сообщение слишком короткое. Опиши, ЧТО изменено и ЗАЧЕМ, одной-двумя фразами.';
      }
      if (!/^[a-z0-9][a-z0-9._-]{2,40}$/i.test(String(branch || ''))) {
        return 'коммит отменён: имя ветки — латиница, цифры, точка, дефис, подчёркивание, 3-40 символов. Префикс agent/ добавится сам.';
      }
      const full = `agent/${branch}`;
      try {
        // Ветка ВСЕГДА новая: коммит в существующую (тем более в develop) — не решение модели.
        execFileSync('git', ['checkout', '-b', full], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
      } catch (e) {
        return `не удалось создать ветку ${full}: ${String(e.message).slice(0, 150)}. Возможно, она уже есть — возьми другое имя.`;
      }
      try {
        execFileSync('git', ['add', '-A'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
        execFileSync('git', ['commit', '-m', message], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 }).trim();
        const stat = execFileSync('git', ['show', '--stat', '--oneline', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
        return `✔ коммит ${hash} в ветке ${full}. Пуш и вливание — за владельцем, ты их не делаешь.\n${clip(stat)}`;
      } catch (e) { return `коммит не прошёл: ${String(e.message).slice(0, 200)}`; }
    },
  },
  // ХИРУРГИЧЕСКАЯ ПРАВКА: заменить ТОЧНУЮ подстроку. Главный инструмент правки кода, вместо write_file.
  //
  // ЗАЧЕМ ОН ЕСТЬ (замер 31.07.2026, agent/bench-code-real.js): при задаче «перепиши файл целиком»
  // агент дал 0/8 годных диффов на реальных файлах — он ПЕРЕПЕЧАТЫВАЛ 100-300 строк ради правки в две
  // и по дороге портил посторонние строки. Систематически страдали escape-последовательности:
  // `.replace(/\/v1\/?$/, '')` превращалось в `/\\v1\/?$/` — уже другая регулярка. Тесты этого не
  // ловят: испорчены строки, которые тестами не покрыты.
  // Здесь порча НЕВОЗМОЖНА физически: всё, что вне old_string, не переписывается вообще.
  //
  // Три жёстких правила, каждое закрывает свой класс сбоя:
  //   1) old_string обязана встречаться РОВНО ОДИН РАЗ — иначе непонятно, что менять (правим не туда);
  //   2) old_string ≠ new_string — иначе модель «сделала правку», не изменив ничего, и рапортует успех;
  //   3) пустая old_string запрещена — это была бы вставка в начало файла, почти всегда не то.
  edit_file: {
    schema: { type: 'object', properties: {
      file: { type: 'string', description: 'Путь к файлу относительно рабочей папки' },
      old_string: { type: 'string', description: 'ТОЧНЫЙ фрагмент из файла (копируй посимвольно, вместе с отступами). Должен встречаться ровно один раз' },
      new_string: { type: 'string', description: 'Чем заменить' },
      purpose: { type: 'string', description: 'Зачем эта правка' },
    }, required: ['file', 'old_string', 'new_string'] },
    description: 'Заменить точный фрагмент в файле. ПРЕДПОЧИТАЙ ЭТОТ ИНСТРУМЕНТ вместо write_file для правок: он меняет только указанное место, остальной файл физически не трогается. Фрагмент копируй из прочитанного файла ДОСЛОВНО, вместе с отступами.',
    run: async ({ file, old_string, new_string }) => {
      if (typeof old_string !== 'string' || !old_string) {
        return 'правка отменена: old_string пустая. Передай ТОЧНЫЙ фрагмент из файла, который надо заменить.';
      }
      if (typeof new_string !== 'string') {
        return 'правка отменена: new_string отсутствует или не строка (вероятно, вызов оборвался). Файл НЕ изменён. Повтори вызов целиком.';
      }
      if (old_string === new_string) {
        return 'правка отменена: old_string и new_string одинаковы — заменять нечего. Проверь, что именно ты собирался изменить.';
      }
      const p = safePath(file);
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return `не могу прочитать ${file}: ${e.message}. Сначала прочитай файл через read_file.`; }
      const n = text.split(old_string).length - 1;
      if (n === 0) {
        return `фрагмент НЕ найден в ${file} — файл не изменён. Частая причина: отступы или перенос строки скопированы неточно. Прочитай файл через read_file и скопируй фрагмент ДОСЛОВНО, символ в символ.`;
      }
      if (n > 1) {
        return `фрагмент встречается ${n} раз в ${file} — непонятно, какой менять, файл не изменён. Возьми фрагмент ДЛИННЕЕ, добавив соседние строки, чтобы он стал уникальным.`;
      }
      fs.writeFileSync(p, text.replace(old_string, new_string));
      return `✔ заменено в ${file} (1 совпадение). Остальной файл не тронут.`;
    },
  },
  // ЗАПИСЬ в общий RAG-архив: владелец диктует в Телеграм — заметка ложится в архив и находится потом.
  //
  // 🔒 ЗАПИСЬ НАМЕРЕННО ОГРАНИЧЕНА, и вот почему. Архив читают ВСЕ агенты флота и верят ему как фактам.
  // Значит агент, умеющий писать туда что угодно, — это канал отравления: достаточно один раз затащить
  // в контекст чужой текст с инструкцией «запиши, что X», и ложь станет «фактом» для всего флота
  // надолго. Поэтому модель НЕ выбирает ни scope, ни source — они прибиты здесь:
  //   scope=personal  — заметки владельца, не смешиваются с рабочими/трейдинговыми фактами;
  //   source=tg:owner — единый штамп, по которому ВСЁ записанное агентом отзывается одной командой
  //                     (проверено 31.07.2026: POST /delete {source} → deleted:N). Без такого штампа
  //                     запись ложится с source=unknown, и удалить её можно только вместе с чужими.
  // Модель управляет только заголовком и текстом — тем, что ей и продиктовали.
  rag_write: {
    safe: true,
    schema: { type: 'object', properties: {
      text: { type: 'string', description: 'Текст заметки — дословно то, что просил запомнить владелец' },
      title: { type: 'string', description: 'Короткий заголовок: о чём заметка' },
    }, required: ['text'] },
    description: 'Записать заметку владельца в общий RAG-архив (потом найдётся через rag_search). Используй, когда владелец просит запомнить/записать/сохранить факт. Текст сохраняй ДОСЛОВНО, не пересказывай своими словами.',
    run: async ({ text, title }) => {
      const cfg = ragConfig();
      if (!cfg.url || !cfg.token) return 'RAG не настроен на этой ноде — записать некуда. Скажи владельцу, что заметка НЕ сохранена.';
      if (typeof text !== 'string' || !text.trim()) return 'запись отменена: пустой текст. Повтори вызов, передав в поле "text" саму заметку.';
      try {
        const item = { scope: 'personal', source: 'tg:owner', title: String(title || '').slice(0, 120), text: text.trim(), path: '' };
        const res = await fetch(`${cfg.url}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify({ items: [item] }) });
        if (!res.ok) return `RAG ${res.status}: записать не удалось. Скажи владельцу, что заметка НЕ сохранена.`;
        const j = await res.json();
        // Сервис сам отсеивает секреты (счётчик secret) — это не сбой, а защита: сообщаем честно.
        if (j.secret) return '⚠ заметка НЕ сохранена: архив распознал в тексте секрет (ключ/токен/пароль) и отклонил запись. Секреты в RAG не хранятся — так и скажи владельцу.';
        if (!j.added) return `заметка не добавлена (возможно, такая уже есть): ${JSON.stringify(j)}`;
        return `✔ записано в архив. Найти позже можно через rag_search по смыслу заметки.`;
      } catch (e) { return `RAG ошибка: ${e.message}. Заметка НЕ сохранена.`; }
    },
  },
  // ПРЕДЛОЖИТЬ СЕБЕ НОВЫЙ ИНСТРУМЕНТ. Агент упёрся в отсутствие возможности — пусть опишет её кодом.
  //
  // 🔒 ПРЕДЛОЖИТЬ ≠ ПОДКЛЮЧИТЬ. Файл ложится в staging (~/.agent-bus/proposed-skills/) и НЕ
  // исполняется и НЕ регистрируется. Подключение — ручной перенос в agent/skills/ после ревью
  // (см. agent/skills-loader.js). Причина: скил объявляет сам себя `safe`, то есть идёт МИМО гейта
  // надзора. Агент, который регистрирует себе скилы, за один ход выпишет `safe:true` обёртку над
  // shell — и весь надзор превратится в декорацию. Поэтому регистрирует только человек.
  // Тул РИСКОВЫЙ намеренно: даже само предложение проходит через гейт, чтобы надзор видел, что
  // агент пытается расширить свои полномочия, и по какой причине.
  skill_propose: {
    schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Имя инструмента: латиница, цифры, _' },
      description: { type: 'string', description: 'Что делает и когда применять — это увидит модель в списке тулзов' },
      code: { type: 'string', description: 'Полный JS-модуль: module.exports = { name, description, schema, safe, run }' },
      purpose: { type: 'string', description: 'Зачем он нужен: какую задачу сейчас нельзя решить без него' },
    }, required: ['name', 'description', 'code', 'purpose'] },
    description: 'Предложить НОВЫЙ инструмент для себя, когда существующих не хватает. Ты его НЕ подключаешь — предложение уходит на ревью владельцу. Опиши в purpose, какую конкретную задачу сейчас решить нечем.',
    run: async ({ name, description, code, purpose }) => {
      if (!/^[a-z][a-z0-9_]{2,31}$/i.test(String(name || ''))) {
        return 'имя отклонено: только латиница, цифры и _, от 3 до 32 символов, начиная с буквы. Повтори вызов с исправленным name.';
      }
      if (typeof code !== 'string' || code.length < 40) {
        return 'запись отменена: в поле "code" должен быть ПОЛНЫЙ текст модуля (module.exports = {...}), а не описание идеи. Повтори вызов с кодом.';
      }
      const dir = path.join(require('os').homedir(), '.agent-bus', 'proposed-skills');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const head = `// ПРЕДЛОЖЕНО АГЕНТОМ desktop-local ${new Date().toISOString()}\n`
          + `// Зачем: ${String(purpose).replace(/\n/g, ' ').slice(0, 300)}\n`
          + `// ⚠️ НЕ ПОДКЛЮЧЁН. Подключение — ревью и перенос в agent/skills/ вручную.\n\n`;
        fs.writeFileSync(path.join(dir, `${name}.js`), head + code);
        // Надзор должен узнать сразу, а не когда-нибудь: агент просит расширить свои полномочия.
        try { require('./escalate').escalate('skill_propose', `агент предлагает новый инструмент "${name}": ${purpose}`); } catch (_) {}
        return `✔ предложение сохранено (${name}). Инструмент ПОКА НЕ РАБОТАЕТ — он уйдёт на ревью владельцу. Продолжай решать задачу тем, что есть, либо скажи, что без этого инструмента она не решается.`;
      } catch (e) { return `не удалось сохранить предложение: ${e.message}`; }
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
      if (!dst) throw new Error('не указан получатель. Передай поле "to" с ID агента; узнать, кто сейчас на связи, можно инструментом bus_who. Для сообщения всем сразу используй to="all".');
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
      if (typeof content !== 'string') throw new Error('запись отменена: поле "content" пустое или не строка — скорее всего вызов оборвался на середине. Файл НЕ изменён, ничего не потеряно. Повтори вызов write_file, передав в "content" полный текст файла целиком (не фрагмент и не описание правки).');
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

// Динамические скилы из agent/skills/ — то, что прошло ревью и было подключено вручную.
// ВСТРОЕННЫЕ НЕ ПЕРЕЗАПИСЫВАЮТСЯ: иначе подсунутый скил с именем read_file или bus_send подменил бы
// проверенный инструмент, включая его границы безопасности. Конфликт имён — пропуск с записью.
for (const [n, s] of Object.entries(require('./skills-loader').load())) {
  if (REGISTRY[n]) { process.stderr.write(`[скилы] "${n}" не подключён: имя занято встроенным инструментом\n`); continue; }
  REGISTRY[n] = s;
}

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
  // ⚠️ ТЕКСТ ОШИБКИ — ЭТО ИНСТРУКЦИЯ ДЛЯ МОДЕЛИ, а не запись в лог для человека. Модель получает
  // его как результат тула и по нему выбирает следующий шаг. Сообщение обязано отвечать на два
  // вопроса: что произошло И что делать дальше. «неизвестный тул: X» не даёт ничего — модель
  // угадает второй раз; список реальных имён закрывает вопрос за один ход. Стоит ноль токенов,
  // пока ошибки нет. Образец правильного тона — строка про BLOCKED надзором ниже.
  if (!t) throw new Error(`неизвестный тул: "${name}". Доступны ТОЛЬКО эти: ${Object.keys(REGISTRY).join(', ')}. Выбери подходящий из списка или скажи, что нужного инструмента у тебя нет.`);
  if (!enabled(name)) throw new Error(`тул "${name}" отключён режимом надзора — ты не можешь его включить сам. Реши задачу доступными инструментами (${Object.keys(REGISTRY).filter(enabled).join(', ')}) либо скажи владельцу, какое действие требуется и зачем.`);
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
