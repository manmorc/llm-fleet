#!/usr/bin/env node
// CLI управления флотом. Запускать с любой машины, видящей Redis.
//   fleet status                          — кто онлайн, версия/модель/занятость
//   fleet broadcast <cmd> [json]          — команда всем (ping|reload|drain|resume|update|set-model|rollback)
//   fleet submit <skill> <json>           — поставить задачу в очередь
const IORedis = require('ioredis');
const cfg = require('../src/config');

const [, , cmd, ...args] = process.argv;
const r = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });

function tryJson(s) { if (!s) return undefined; try { return JSON.parse(s); } catch (_) { return s; } }
async function done(msg) { if (msg) console.log(msg); try { await r.quit(); } catch (_) {} process.exit(0); }

(async () => {
  try {
    if (cmd === 'status') {
      await r.connect();
      const keys = await r.keys(cfg.workerKeyPrefix + '*');
      if (!keys.length) return done('Нет онлайн-воркеров.');
      console.log('ID\tМОДЕЛЬ\tВЕРСИЯ\tЗАНЯТ\tПАУЗА\tСКИЛЫ');
      for (const k of keys) {
        const w = JSON.parse((await r.get(k)) || '{}');
        console.log(`${w.id}\t${w.model}\tv${w.version}\t${w.busy}/${w.concurrency}\t${w.paused}\t${(w.skills || []).join(',')}`);
      }
    } else if (cmd === 'broadcast') {
      await r.connect();
      const payload = JSON.stringify({ cmd: args[0], args: tryJson(args[1]) || {} });
      const n = await r.publish(cfg.controlChannel, payload);
      return done(`Отправлено ${args[0]} → получили ${n} воркер(ов): ${payload}`);
    } else if (cmd === 'submit') {
      const { Queue } = require('bullmq');
      const q = new Queue(cfg.queue, { connection: new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null }) });
      const job = await q.add(args[0], tryJson(args[1]) || {}, { removeOnComplete: 200, removeOnFail: 200 });
      console.log(`Задача поставлена: #${job.id} ${args[0]}`);
      await q.close();
      return done();
    } else {
      return done(`Использование:
  fleet status
  fleet broadcast <ping|reload|drain|resume|update|set-model|rollback> [json]
  fleet submit <skill> <json>
Примеры:
  fleet broadcast set-model '{"model":"qwen2.5:14b"}'
  fleet broadcast update
  fleet submit parseSignal '{"text":"BTC long entry 65000 sl 63000 tp 70000"}'`);
    }
  } catch (e) { console.error('ERR', e.message); }
  await done();
})();
