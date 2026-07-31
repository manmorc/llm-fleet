#!/usr/bin/env node
// Решение надзора по заявке агента (bus-режим). Кладёт allow|deny в agents:approvals:<reqId>.
//   REDIS_URL=... node agent/approve.js <reqId> allow|deny
const fs = require('fs');
const os = require('os');
const path = require('path');
const IORedis = require('ioredis');

// REDIS_URL из env, ИНАЧЕ из ~/.agent-bus/fleet.env — тем же путём, что ecosystem.config.js.
// Без этого фолбэка команду нельзя было выполнить из обычной сессии (env там нет), а именно оттуда
// надзор и отвечает на заявки. Та же поломка, что чинилась в mcp/bus-send.js 31.07.2026.
function fromFleetEnv(key) {
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}
const URL = process.env.REDIS_URL || fromFleetEnv('REDIS_URL');
const id = process.argv[2];
const decision = (process.argv[3] || '').toLowerCase();
if (!URL || !id || !['allow', 'deny'].includes(decision)) {
  console.error('usage: node agent/approve.js <reqId> allow|deny   (REDIS_URL из env или ~/.agent-bus/fleet.env)'); process.exit(1);
}
(async () => {
  // Быстрый отказ вместо вечного ретрая: это одноразовый CLI, висеть ему незачем.
  const r = new IORedis(URL, { maxRetriesPerRequest: 2, connectTimeout: 8000,
    retryStrategy: (t) => (t > 3 ? null : Math.min(t * 500, 1500)) });
  r.on('error', (e) => { console.error('ERR redis:', e.message); process.exit(1); });
  const key = 'agents:approvals:' + id;
  await r.rpush(key, decision);
  await r.expire(key, 3600);
  console.log(`решение "${decision}" → ${key}`);
  await r.quit();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
