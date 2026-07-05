#!/usr/bin/env node
// Durable agent-bus inbox-персистер: BLPOP inbox → дописывает строку в лог-файл (+ stdout для pm2-логов).
// Запускается под pm2 (always-on, переживает Claude-сессии и рестарты). Живая Claude-сессия
// НЕ читает Redis напрямую, а tail'ит этот лог через Monitor → real-time в сессии + ничего не теряется офлайн.
// ВАЖНО: единственный потребитель Redis-inbox = этот персистер. Не запускай параллельно BLPOP-watcher/MCP `inbox`.
// ENV: REDIS_URL (обяз.) · AGENT_ID (по умолч. hostname) · AGENT_BUS_LOG (по умолч. ~/.agent-bus/<id>.log)
const os = require('os'), fs = require('fs'), path = require('path');
const IORedis = require('ioredis');

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = (process.env.AGENT_ID || os.hostname()).trim();
const KEY = 'agents:inbox:' + ID;
const LOG = process.env.AGENT_BUS_LOG || path.join(os.homedir(), '.agent-bus', ID + '.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const br = new IORedis(URL, { maxRetriesPerRequest: null });
br.on('error', (e) => process.stderr.write('[persist] redis: ' + e.message + '\n'));

function emit(line) { process.stdout.write(line + '\n'); try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {} }
emit(`▶ persist up — ${KEY} → ${LOG}`);

(async () => {
  for (;;) {
    try {
      const res = await br.blpop(KEY, 5); // [key,value] | null
      if (!res) continue;
      let m; try { m = JSON.parse(res[1]); } catch (_) { m = { text: res[1] }; }
      const tag = m.kind === 'broadcast' ? ' (broadcast)' : '';
      emit(`📨 ${new Date().toISOString()} ${m.from || '?'}${tag}: ${m.text || ''}`);
    } catch (e) {
      process.stderr.write('[persist] ' + e.message + '\n');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();
