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
  if (r !== ROOT && !r.startsWith(ROOT + path.sep)) throw new Error(`путь вне AGENT_ROOT: ${p}`);
  return r;
}
function clip(s) { s = String(s); return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[обрезано, всего ${s.length} симв.]` : s; }

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
  http_get: {
    safe: true,
    schema: { type: 'object', properties: { url: { type: 'string', description: 'URL (только localhost или tailnet 100.x)' } }, required: ['url'] },
    description: 'HTTP GET к localhost/tailnet (напр. локальный API). Внешние хосты запрещены.',
    run: async ({ url }) => {
      const u = new URL(url);
      const ok = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('100.') || u.hostname.endsWith('.ts.net');
      if (!ok) throw new Error(`хост запрещён: ${u.hostname} (только localhost/tailnet)`);
      const res = await fetch(url);
      return clip(`[${res.status}] ` + (await res.text()));
    },
  },
  // ── РИСКОВЫЕ (за флагом) ──────────────────────────────────────────────
  write_file: {
    safe: false,
    schema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] },
    description: 'Записать файл (в пределах AGENT_ROOT). РИСКОВЫЙ — требует AGENT_ALLOW_RISKY=1.',
    run: ({ file, content }) => { fs.writeFileSync(safePath(file), String(content)); return `записано ${file} (${content.length} симв.)`; },
  },
  shell: {
    safe: false,
    schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    description: 'Выполнить shell-команду в AGENT_ROOT. РИСКОВЫЙ — требует AGENT_ALLOW_RISKY=1.',
    run: ({ cmd }) => clip(execSync(cmd, { cwd: ROOT, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).toString()),
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
  const g = await supervisor.gate({ tool: name, args, reason: (args && args.reason) || undefined });
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
