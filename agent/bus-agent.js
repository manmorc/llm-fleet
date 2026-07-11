#!/usr/bin/env node
// Живой слушатель автономного агента desktop-local на agent-bus.
// Держит presence, BLPOP'ит свой inbox, прогоняет задачу через tool-use петлю (loop.js),
// шлёт подписанный ответ отправителю. Рисковые действия — через надзор (supervisor.js).
// ENV: REDIS_URL · AGENT_ID=desktop-local · AGENT_PRIVKEY_FILE=~/.agent-bus/desktop-local.key
//      AGENT_SUPERVISOR=bus · AGENT_ALLOW_RISKY=1 · AGENT_ROOT · MODEL · OLLAMA_URL
const os = require('os');
const IORedis = require('ioredis');
const keys = require('../mcp/keys');
const { runAgent } = require('./loop');

const URL = process.env.REDIS_URL;
const ID = (process.env.AGENT_ID || 'desktop-local').trim();
const LABEL = process.env.AGENT_LABEL || 'local-agent (gpu, supervised)';
const MODEL = process.env.MODEL || 'gemma4:latest';
if (!URL) { console.error('нужен REDIS_URL'); process.exit(1); }

const PRESENCE = 'agents:presence:', INBOX = 'agents:inbox:';
const r = new IORedis(URL, { maxRetriesPerRequest: null });
const br = new IORedis(URL, { maxRetriesPerRequest: null }); // отдельное соединение под BLPOP

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function beat() {
  try { await r.set(PRESENCE + ID, JSON.stringify({ id: ID, label: LABEL, host: os.hostname(), ts: Date.now() }), 'EX', 30); }
  catch (e) { log('beat fail', e.message); }
}
async function deliver(to, rec) { const k = INBOX + to; await r.rpush(k, JSON.stringify(rec)); await r.ltrim(k, -500, -1); await r.expire(k, 7 * 24 * 3600); }
async function reply(to, text) { const rec = { from: ID, to, text, kind: 'direct', ts: Date.now() }; rec.sig = keys.sign(rec); await deliver(to, rec); }

async function handle(m) {
  const from = m.from || 'unknown';
  const v = keys.verify(m);                 // 'ok' | 'unsigned' | 'unknown-key' | 'BAD'
  const task = (m.text || '').trim();
  if (!task) return;
  log(`📥 task от ${from} [${v}]: ${task.slice(0, 100)}`);
  // Подпись верифицирует КТО прислал; надзор (supervisor) гейтит ЧТО рисковое выполнится. Оба слоя.
  await reply(from, `🟢 desktop-local принял задачу (модель ${MODEL}, надзор=${process.env.AGENT_SUPERVISOR || 'deny'}), работаю…`);
  try {
    const res = await runAgent(task, { model: MODEL, onEvent: (e) => {
      if (e.type === 'call') log(`  → ${e.name}(${JSON.stringify(e.args).slice(0, 120)})`);
      else if (e.type === 'result') log(`  ← ${String(e.result).replace(/\n/g, ' ').slice(0, 120)}`);
    } });
    await reply(from, `✅ desktop-local готово (${res.steps} шаг):\n${res.answer}`);
    log(`✔ done → ${from} (${res.steps} шаг)`);
  } catch (e) {
    await reply(from, `⚠ desktop-local ошибка: ${e.message}`);
    log('✖ ERR', e.message);
  }
}

(async () => {
  await beat();
  setInterval(beat, 10000);
  log(`▶ desktop-local up · model=${MODEL} · supervisor=${process.env.AGENT_SUPERVISOR || 'deny'} · risky=${process.env.AGENT_ALLOW_RISKY === '1' ? 'ON' : 'off'} · root=${process.env.AGENT_ROOT || process.cwd()}`);
  for (;;) {
    try {
      const res = await br.blpop(INBOX + ID, 5);
      if (!res) continue;
      let m; try { m = JSON.parse(res[1]); } catch (_) { m = { text: res[1] }; }
      if (m.kind === 'approval-request' || m.kind === 'approval') continue; // не задачи
      await handle(m);
    } catch (e) { log('loop err', e.message); await new Promise((x) => setTimeout(x, 2000)); }
  }
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  try { await r.del(PRESENCE + ID); await r.quit(); await br.quit(); } catch (_) {}
  process.exit(0);
});
