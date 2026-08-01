#!/usr/bin/env node
// Стримит входящие agent-bus сообщения для AGENT_ID построчно (по одному событию на сообщение).
// Для real-time: запускается под Monitor/фоном, BLPOP блокирующе ждёт новые сообщения в inbox.
// ВНИМАНИЕ: BLPOP забирает сообщение из списка → пока watcher работает, НЕ зови MCP-тулзу `inbox`
// (иначе конкуренция за чтение). Watcher — единственный потребитель inbox в реальном времени.
// ENV: REDIS_URL (обяз.) · AGENT_ID (по умолчанию hostname)
const os = require('os');
const IORedis = require('ioredis');
const { flatten } = require('./agent-bus.persist'); // тот же экранировщик переносов, что у персистера

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = (process.env.AGENT_ID || os.hostname()).trim();
const KEY = 'agents:inbox:' + ID;

const out = (s) => process.stdout.write(s + '\n');
const br = new IORedis(URL, { maxRetriesPerRequest: null });
br.on('error', (e) => process.stderr.write('[watch] redis error: ' + e.message + '\n'));

out(`▶ agent-bus watcher up — ${KEY}`);
(async () => {
  for (;;) {
    try {
      const res = await br.blpop(KEY, 5); // [key, value] | null (таймаут)
      if (!res) continue;
      let m; try { m = JSON.parse(res[1]); } catch (_) { m = { text: res[1] }; }
      const tag = m.kind === 'broadcast' ? ' (broadcast)' : '';
      // ОДНО СООБЩЕНИЕ = ОДНА СТРОКА (тот же инцидент 02.08.2026, что и в персистере): вотчер —
      // построчный стрим, и сырой текст с переносами превращал одно событие в несколько строк,
      // из которых читатель брал первую. Переносы экранируем видимым маркером ⏎.
      out(`📨 ${m.from || '?'}${tag}: ${flatten(m.text)}`);
    } catch (e) {
      process.stderr.write('[watch] ' + e.message + '\n');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();
