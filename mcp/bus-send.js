#!/usr/bin/env node
// Подписанная отправка в agent-bus БЕЗ MCP-тула (для сессий со старым MCP, скриптов, cron).
// Подписывает приватным ключом (~/.agent-bus/agent.key) → получатель проверит (✓).
//   AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-send.js <to|all> <текст…>
const os = require('os');
const IORedis = require('ioredis');
const keys = require('./keys');

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = (process.env.AGENT_ID || os.hostname()).trim();
const to = process.argv[2];
const text = process.argv.slice(3).join(' ');
if (!to || !text) { console.error('usage: AGENT_ID=<id> REDIS_URL=<url> node mcp/bus-send.js <to|all> <текст>'); process.exit(1); }

const PRESENCE = 'agents:presence:', INBOX = 'agents:inbox:';
const r = new IORedis(URL, { maxRetriesPerRequest: null });
async function online() { const out = []; for (const k of await r.keys(PRESENCE + '*')) { const v = await r.get(k); if (v) try { out.push(JSON.parse(v).id); } catch (_) {} } return out; }
async function deliver(dst, rec) { const k = INBOX + dst; await r.rpush(k, JSON.stringify(rec)); await r.ltrim(k, -500, -1); await r.expire(k, 7 * 24 * 3600); }

(async () => {
  const ts = Date.now();
  if (to === 'all') {
    const base = { from: ID, text, kind: 'broadcast', ts }; base.sig = keys.sign(base);
    const list = (await online()).filter((x) => x !== ID);
    for (const d of list) await deliver(d, { ...base, to: d });
    console.log(`broadcast → ${list.length}: ${list.join(', ') || '(никого)'} ${base.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  } else {
    const rec = { from: ID, to, text, kind: 'direct', ts }; rec.sig = keys.sign(rec);
    await deliver(to, rec);
    console.log(`→ ${to}: отправлено ${rec.sig ? '(signed ✓)' : '(⚠ без ключа)'}`);
  }
  await r.quit();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
