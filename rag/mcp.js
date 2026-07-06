#!/usr/bin/env node
// Тонкий MCP-клиент к RAG-сервису (на каждой машине). Тулзы archive_search / archive_ingest → HTTP на linux.
// Store НЕ здесь — только вызовы по Tailscale. ENV: RAG_URL (http://<magicdns>:8077), RAG_TOKEN.
const RAG_URL = process.env.RAG_URL || 'http://127.0.0.1:8077';
const TOKEN = process.env.RAG_TOKEN || '';
const log = (...a) => process.stderr.write('[rag-mcp] ' + a.join(' ') + '\n');

async function api(path, payload) {
  const r = await fetch(RAG_URL + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const TOOLS = [
  { name: 'archive_search', description: 'Семантический поиск по личному/рабочему архиву (RAG). Возвращает релевантные фрагменты с источником.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Запрос на естественном языке' },
      scope: { type: 'string', description: 'Фильтр: personal|work|agent|trading (опц.)' },
      k: { type: 'number', description: 'Сколько фрагментов (по умолч. 6)' } }, required: ['query'], additionalProperties: false } },
  { name: 'archive_ingest', description: 'Добавить заметку/итог в архив (индексируется для будущего поиска). Секреты не слать — фильтруются, но лучше не включать.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Текст для сохранения' },
      title: { type: 'string' }, scope: { type: 'string', description: 'personal|work|agent|trading' },
      source: { type: 'string', description: 'Метка источника, напр. session:mac-2026-07-06' } }, required: ['text'], additionalProperties: false } },
];

async function call(name, a) {
  a = a || {};
  if (name === 'archive_search') {
    const { results } = await api('/search', { query: a.query, scope: a.scope, k: a.k || 6 });
    if (!results.length) return 'Ничего не найдено.';
    return results.map((r, i) => `${i + 1}. [${r.score}] ${r.scope}/${r.source}${r.title ? ' · ' + r.title : ''}\n   ${r.text.replace(/\n/g, '\n   ').slice(0, 600)}`).join('\n\n');
  }
  if (name === 'archive_ingest') {
    const r = await api('/ingest', { items: [{ text: a.text, title: a.title, scope: a.scope || 'personal', source: a.source || 'manual', ts: Date.now() }] });
    return `Добавлено чанков: ${r.added} (пропущено дублей: ${r.skipped}, секретов отфильтровано: ${r.secret}).`;
  }
  throw new Error('unknown tool: ' + name);
}

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(m) {
  const { id, method, params } = m;
  if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rag-archive', version: '0.1.0' }, instructions: 'archive_search — искать в личном/рабочем архиве; archive_ingest — сохранить заметку. Store на home-server (linux) по Tailscale.' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try { return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await call(params && params.name, params && params.arguments) }] } }); }
    catch (e) { return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Ошибка: ' + e.message }], isError: true } }); }
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } Promise.resolve(handle(m)).catch((e) => log(e.message)); } });
process.stdin.on('end', () => process.exit(0));
log(`up — RAG_URL=${RAG_URL} auth=${TOKEN ? 'on' : 'off'}`);
