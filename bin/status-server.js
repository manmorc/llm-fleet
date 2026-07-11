#!/usr/bin/env node
// Живой статус-дашборд GPU-ноды флота (UI-продукт). HTTP на localhost (по умолч. :7799),
// авто-refresh. Собирает: pm2-процессы, GPU (nvidia-smi), ollama-модели, presence шины,
// heartbeat воркера, хвост аудита надзора. Запуск: REDIS_URL=... node bin/status-server.js
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
let IORedis; try { IORedis = require('ioredis'); } catch (_) {}

const PORT = parseInt(process.env.STATUS_PORT || '7799', 10);
const REDIS_URL = process.env.REDIS_URL;

function sh(cmd) { try { return execSync(cmd, { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { return ''; } }

function pm2() {
  try { return JSON.parse(sh('pm2 jlist')).map((p) => ({ name: p.name, status: p.pm2_env.status, mem: Math.round(p.monit.memory / 1e6), restarts: p.pm2_env.restart_time })); }
  catch (_) { return []; }
}
function gpu() {
  const o = sh('nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits');
  if (!o) return null;
  const [name, used, total, util, temp] = o.split(',').map((s) => s.trim());
  return { name, used: +used, total: +total, util: +util, temp: +temp };
}
function models() {
  return sh('ollama list').split('\n').slice(1).filter(Boolean).map((l) => { const [name, , size, unit] = l.split(/\s+/); return { name, size: `${size} ${unit}` }; });
}
function auditTail() {
  try { return fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'desktop-local.audit.log'), 'utf8').trim().split('\n').slice(-6).map((l) => JSON.parse(l)); } catch (_) { return []; }
}
async function busState() {
  if (!IORedis || !REDIS_URL) return { agents: [], workers: [] };
  const r = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true, connectTimeout: 4000 });
  try {
    await r.connect();
    const agents = [];
    for (const k of await r.keys('agents:presence:*')) { try { agents.push(JSON.parse(await r.get(k))); } catch (_) {} }
    const workers = [];
    for (const k of await r.keys('fleet:worker:*')) { try { workers.push(JSON.parse(await r.get(k))); } catch (_) {} }
    return { agents, workers };
  } catch (_) { return { agents: [], workers: [] }; } finally { try { await r.quit(); } catch (_) {} }
}

async function collect() {
  const [bus] = await Promise.all([busState()]);
  return { host: os.hostname(), ts: new Date().toISOString(), pm2: pm2(), gpu: gpu(), models: models(), audit: auditTail(), ...bus };
}

function render(d) {
  const pill = (s) => `<span class="pill ${s === 'online' ? 'ok' : 'bad'}">${s}</span>`;
  const gpuPct = d.gpu ? Math.round((d.gpu.used / d.gpu.total) * 100) : 0;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet · ${d.host}</title><meta http-equiv="refresh" content="10">
<style>
:root{--bg:#0e1116;--card:#171b22;--bd:#242a33;--fg:#e6edf3;--mut:#8b949e;--ok:#2ea043;--bad:#d1242f;--acc:#3b82f6}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:1000px;margin:0 auto;padding:20px}h1{font-size:18px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0 0 10px}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bd)}.row:last-child{border:0}
.pill{font-size:11px;padding:1px 8px;border-radius:20px}.pill.ok{background:rgba(46,160,67,.15);color:#3fb950}.pill.bad{background:rgba(209,36,47,.15);color:#f85149}
.bar{height:8px;background:var(--bd);border-radius:5px;overflow:hidden;margin-top:6px}.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#8b5cf6)}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:var(--mut)}code{color:var(--fg)}
.mut{color:var(--mut)}
</style></head><body><div class="wrap">
<h1>🖥️ Fleet GPU-нода · ${d.host}</h1><div class="sub">обновлено ${d.ts} · авто-refresh 10с</div>
<div class="grid">
<div class="card"><h2>Процессы (pm2)</h2>${d.pm2.map((p) => `<div class="row"><span>${p.name} <span class="mono">↺${p.restarts}</span></span><span>${pill(p.status)} <span class="mut">${p.mem}MB</span></span></div>`).join('') || '<div class="mut">—</div>'}</div>
<div class="card"><h2>GPU</h2>${d.gpu ? `<div class="row"><span>${d.gpu.name}</span></div>
<div class="row"><span>VRAM</span><span>${d.gpu.used} / ${d.gpu.total} MiB (${gpuPct}%)</span></div><div class="bar"><i style="width:${gpuPct}%"></i></div>
<div class="row"><span>Загрузка / t°</span><span>${d.gpu.util}% · ${d.gpu.temp}°C</span></div>` : '<div class="mut">нет GPU</div>'}</div>
<div class="card"><h2>Агенты на шине (${d.agents.length})</h2>${d.agents.map((a) => `<div class="row"><span>${a.id}</span><span class="mut">${a.label || ''}</span></div>`).join('') || '<div class="mut">—</div>'}</div>
<div class="card"><h2>LLM-воркеры</h2>${d.workers.map((w) => `<div class="row"><span>${w.id}</span><span class="mut">${w.tier} · ${w.model} · ${w.busy}/${w.concurrency}</span></div>`).join('') || '<div class="mut">—</div>'}</div>
<div class="card"><h2>Модели (ollama)</h2>${d.models.map((m) => `<div class="row"><span>${m.name}</span><span class="mut">${m.size}</span></div>`).join('') || '<div class="mut">—</div>'}</div>
<div class="card"><h2>Аудит надзора (agent)</h2>${d.audit.map((a) => `<div class="row"><span class="mono">${a.phase}</span><span class="mut mono">${a.tool || ''}</span></div>`).join('') || '<div class="mut">пусто</div>'}</div>
</div></div></body></html>`;
}

function serve() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(await collect())); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(render(await collect()));
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`status-dashboard → http://127.0.0.1:${PORT} (localhost only)`));
  return server;
}

module.exports = { collect, render, serve };
if (require.main === module) serve(); // слушаем только при прямом запуске
