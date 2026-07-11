#!/usr/bin/env node
// Решение надзора по заявке агента (bus-режим). Кладёт allow|deny в agents:approvals:<reqId>.
//   REDIS_URL=... node agent/approve.js <reqId> allow|deny
const IORedis = require('ioredis');
const URL = process.env.REDIS_URL;
const id = process.argv[2];
const decision = (process.argv[3] || '').toLowerCase();
if (!URL || !id || !['allow', 'deny'].includes(decision)) {
  console.error('usage: REDIS_URL=... node agent/approve.js <reqId> allow|deny'); process.exit(1);
}
(async () => {
  const r = new IORedis(URL, { maxRetriesPerRequest: null });
  const key = 'agents:approvals:' + id;
  await r.rpush(key, decision);
  await r.expire(key, 3600);
  console.log(`решение "${decision}" → ${key}`);
  await r.quit();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
