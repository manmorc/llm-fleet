#!/usr/bin/env node
// Ингестер файлов → RAG. Работает с ЛЮБОЙ машины: POST в RAG-сервис (единый store на linux).
// Использование: node ingest-files.js <scope> <dir> [--ext md,txt,mdx] [--source <label>]
//   node ingest-files.js work ~/WebstormProjects/control_plane --ext md --source control_plane
// ENV: RAG_URL (http://<magicdns>:8077), RAG_TOKEN
const fs = require('fs'), path = require('path');
const RAG_URL = process.env.RAG_URL || 'http://127.0.0.1:8077';
const TOKEN = process.env.RAG_TOKEN || '';

const [scope, dir, ...rest] = process.argv.slice(2);
if (!scope || !dir) { console.error('usage: node ingest-files.js <scope> <dir> [--ext md,txt] [--source label]'); process.exit(1); }
const getOpt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const exts = (getOpt('--ext', 'md,txt,markdown')).split(',').map((e) => '.' + e.replace(/^\./, ''));
const source = getOpt('--source', path.basename(dir));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv']);

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.isDirectory() && e.name !== '.claude') continue;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), acc); }
    else if (exts.includes(path.extname(e.name).toLowerCase())) acc.push(path.join(d, e.name));
  }
  return acc;
}

async function post(items) {
  const r = await fetch(RAG_URL + '/ingest', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ items }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

(async () => {
  const root = dir.replace(/^~/, require('os').homedir());
  const files = walk(root);
  console.log(`Файлов: ${files.length} (scope=${scope}, source=${source}, ext=${exts.join(',')}) → ${RAG_URL}`);
  let tot = { added: 0, skipped: 0, secret: 0 };
  for (let i = 0; i < files.length; i += 20) {
    const batch = files.slice(i, i + 20).map((f) => ({
      scope, source, path: f.replace(root, '').replace(/^\//, ''),
      title: path.basename(f), text: fs.readFileSync(f, 'utf8'), ts: fs.statSync(f).mtimeMs,
    })).filter((it) => it.text.trim());
    if (!batch.length) continue;
    const r = await post(batch);
    tot.added += r.added; tot.skipped += r.skipped; tot.secret += r.secret;
    process.stdout.write(`\r  ${Math.min(i + 20, files.length)}/${files.length} · +${tot.added} chunks, dup ${tot.skipped}, secret-skip ${tot.secret}   `);
  }
  console.log(`\nГотово: +${tot.added} чанков, дублей ${tot.skipped}, секретов отфильтровано ${tot.secret}.`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
