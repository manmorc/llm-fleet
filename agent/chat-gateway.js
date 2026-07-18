#!/usr/bin/env node
// Веб-шлюз для чата с локальной gemma-26b из браузера (через Tailscale Serve).
// Владелец удалённо → https://desktop-tt4i69c.tail241f5d.ts.net/ → общается с моделькой.
//
// Зачем шлюз, а не голый llama-UI: модель ВЫГРУЖАЕТСЯ на простое (весь llama-server убивается),
// поэтому :8081 в простое недоступен. Шлюз всегда жив (лёгкий, без модели), и на первом сообщении
// БУДИТ модель (server.ensure, ~12-15с), потом проксирует. Idle-unload продолжает работать.
//
// Только tailnet (tailscale serve, НЕ funnel) — доступ как у шины, отдельной авторизации нет.
const http = require('http');
const server = require('./server');

const PORT = parseInt(process.env.GW_PORT || '8090', 10);
const LLAMA = process.env.LLAMA_URL || 'http://127.0.0.1:8081/v1';
const MAX_TOKENS = parseInt(process.env.GW_MAX_TOKENS || '8192', 10);  // потолок: думающей модели нужен запас
const log = (m) => console.log(`${new Date().toISOString()} [chat-gateway] ${m}`);

const PAGE = `<!doctype html><html lang=ru><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Gemma 26B · локальный чат</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0d1117;color:#e6edf3;height:100dvh;display:flex;flex-direction:column}
header{padding:12px 16px;border-bottom:1px solid #21262d;font-weight:600;display:flex;gap:8px;align-items:center}
#dot{width:9px;height:9px;border-radius:50%;background:#3fb950}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:min(680px,92%);padding:10px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
.u{align-self:flex-end;background:#1f6feb;color:#fff;border-bottom-right-radius:4px}
.a{align-self:flex-start;background:#161b22;border:1px solid #21262d;border-bottom-left-radius:4px}
.sys{align-self:center;color:#8b949e;font-size:13px;font-style:italic}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #21262d}
textarea{flex:1;resize:none;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:10px;font:inherit;max-height:140px}
button{background:#238636;color:#fff;border:0;border-radius:10px;padding:0 18px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
</style></head><body>
<header><span id=dot></span> Gemma&nbsp;26B · локальный чат <span id=st style="color:#8b949e;font-weight:400;font-size:13px"></span></header>
<div id=log></div>
<form id=f><textarea id=i rows=1 placeholder="Спроси у модельки… (Enter — отправить, Shift+Enter — перенос)"></textarea><button id=b>➤</button></form>
<script>
const log=document.getElementById('log'),inp=document.getElementById('i'),btn=document.getElementById('b'),st=document.getElementById('st');
const hist=[];
function add(role,text){const d=document.createElement('div');d.className='msg '+(role==='user'?'u':role==='assistant'?'a':'sys');d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
async function send(){
  const text=inp.value.trim();if(!text)return;
  inp.value='';inp.style.height='auto';btn.disabled=true;
  add('user',text);hist.push({role:'user',content:text});
  const wait=add('sys','модель думает… (первый ответ после простоя — до ~30с, поднимаю)');
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:hist})});
    const j=await r.json();wait.remove();
    if(j.error){add('sys','⚠ '+j.error)}
    else{add('assistant',j.content||'(пустой ответ)');hist.push({role:'assistant',content:j.content||''})}
  }catch(e){wait.remove();add('sys','⚠ сеть: '+e.message)}
  btn.disabled=false;inp.focus();
}
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();send()});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
inp.addEventListener('input',()=>{inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,140)+'px'});
</script></body></html>`;

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const srv = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE);
  }
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let messages;
      try { messages = JSON.parse(body).messages; } catch (_) { return sendJson(res, 400, { error: 'плохой JSON' }); }
      if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: 'нет сообщений' });
      try {
        // будим модель (поднимет, если выгружена; штампует активность — не даёт watchdog'у гасить в разговоре)
        await server.ensure({ log: (m) => log(m) });
        const r = await fetch(`${LLAMA}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: server.ALIAS, messages: messages.slice(-40), max_tokens: MAX_TOKENS, temperature: 0.3 }),
        });
        if (!r.ok) return sendJson(res, 502, { error: `модель ${r.status}` });
        const j = await r.json();
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        sendJson(res, 200, { content });
      } catch (e) { sendJson(res, 502, { error: e.message }); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

srv.listen(PORT, '127.0.0.1', () => log(`слушаю 127.0.0.1:${PORT} → проксирую в ${LLAMA} (модель по требованию)`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { srv.close(); process.exit(0); });
