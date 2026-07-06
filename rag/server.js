#!/usr/bin/env node
// RAG HTTP-сервис (крутится на linux home-server). Store только здесь; mac/win ходят по Tailscale.
// Эндпоинты: GET /health · POST /search {query,scope?,k?} · POST /ingest {items:[{scope,source,path,title,text,ts}]}
// Авторизация: Bearer RAG_TOKEN (шина/сеть → токен обязателен). ENV: RAG_TOKEN, RAG_PORT(8077), RAG_DB, OLLAMA_URL.
const http = require('http');
const { openDb, ingest, search } = require('./lib');

const PORT = parseInt(process.env.RAG_PORT || '8077', 10);
// Хардинг: bind по умолчанию localhost; для кросс-машинного — RAG_BIND=<tailscale-IP> (НЕ 0.0.0.0,
// чтобы роуминг-ноут не торчал на LAN/публичном WiFi). Токен ОБЯЗАТЕЛЕН (fail-closed) — сервис не стартует без него.
const BIND = process.env.RAG_BIND || '127.0.0.1';
const TOKEN = process.env.RAG_TOKEN || '';
if (!TOKEN) { console.error('FATAL: RAG_TOKEN обязателен (fail-closed). Задай RAG_TOKEN и перезапусти.'); process.exit(1); }
const db = openDb();

function body(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
}
const send = (r, code, obj) => { r.writeHead(code, { 'content-type': 'application/json' }); r.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/search') {
      const { query, scope, k } = await body(req);
      if (!query) return send(res, 400, { error: 'query required' });
      return send(res, 200, { results: await search(db, query, { scope, k: k || 6 }) });
    }
    if (req.method === 'POST' && req.url === '/ingest') {
      const { items } = await body(req);
      if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'items[] required' });
      return send(res, 200, await ingest(db, items));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});
server.listen(PORT, BIND, () => console.log(`rag-server on ${BIND}:${PORT} db=${require('./lib').DB_PATH} auth=on`));
