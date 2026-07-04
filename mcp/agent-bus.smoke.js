// Smoke-тест agent-bus MCP: spawn сервера как агент, гоняем JSON-RPC по stdio.
// Использование: node mcp/agent-bus.smoke.js <AGENT_ID> <script.json-inline>
// Здесь — сценарий: initialize → tools/list → who → send → broadcast → inbox.
const { spawn } = require('child_process');
const path = require('path');

const AGENT_ID = process.argv[2] || 'tester';
const calls = JSON.parse(process.argv[3] || '[]'); // [{name,arguments}]

const srv = spawn('node', [path.join(__dirname, 'agent-bus.js')], {
  env: { ...process.env, AGENT_ID },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let id = 0; const pending = new Map(); let buf = '';
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
function rpc(method, params) {
  const myId = ++id;
  return new Promise((res) => { pending.set(myId, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n'); });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log(`[${AGENT_ID}] initialize → server=${init.result.serverInfo.name} v${init.result.serverInfo.version}, proto=${init.result.protocolVersion}`);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rpc('tools/list', {});
  console.log(`[${AGENT_ID}] tools/list → ${tl.result.tools.map(t => t.name).join(', ')}`);
  await sleep(150); // дать presence распространиться
  for (const c of calls) {
    const r = await rpc('tools/call', { name: c.name, arguments: c.arguments || {} });
    const text = r.result.content.map(x => x.text).join('');
    console.log(`[${AGENT_ID}] ${c.name}(${JSON.stringify(c.arguments || {})}) →\n     ${text.replace(/\n/g, '\n     ')}`);
  }
  srv.stdin.end();
  await sleep(100);
  srv.kill('SIGINT');
  process.exit(0);
})();
