#!/usr/bin/env node
// CLI управления флотом. Запускать с любой машины, видящей Redis.
//   fleet status                          — кто онлайн (тир/версия/модель/занятость) + счётчики очередей по тирам
//   fleet broadcast <cmd> [json]          — команда всем (ping|reload|drain|resume|update|set-model|rollback)
//   fleet submit <skill> <json> [tier]    — поставить задачу в очередь тира llm:<tier> (по умолчанию fast)
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
      // Счётчики задач по очередям тиров (Routing v2): llm:strong|fast|embed.
      // Очередь = prefix 'llm' + имя=<tier> → Redis-ключи llm:<tier>:*.
      const { Queue } = require('bullmq');
      console.log('ОЧЕРЕДИ (по тирам):');
      for (const tier of cfg.TIERS) {
        const q = new Queue(tier, { connection: new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null }), prefix: cfg.QUEUE_PREFIX });
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        console.log(`  ${cfg.queueFor(tier)}\twait=${c.waiting}\tactive=${c.active}\tdelayed=${c.delayed}\tfailed=${c.failed}`);
        await q.close();
      }
      const keys = await r.keys(cfg.workerKeyPrefix + '*');
      if (!keys.length) return done('\nНет онлайн-воркеров.');
      console.log('\nID\tТИР\tМОДЕЛЬ\tVRAM\tВЕРСИЯ\tЗАНЯТ\tПАУЗА\tСКИЛЫ');
      for (const k of keys) {
        const w = JSON.parse((await r.get(k)) || '{}');
        console.log(`${w.id}\t${w.tier || '-'}\t${w.model}\t${w.vram ? w.vram + 'GB' : '-'}\tv${w.version}\t${w.busy}/${w.concurrency}\t${w.paused}\t${(w.skills || []).join(',')}`);
      }
    } else if (cmd === 'broadcast') {
      await r.connect();
      const payload = JSON.stringify({ cmd: args[0], args: tryJson(args[1]) || {} });
      const n = await r.publish(cfg.controlChannel, payload);
      return done(`Отправлено ${args[0]} → получили ${n} воркер(ов): ${payload}`);
    } else if (cmd === 'submit') {
      const { Queue } = require('bullmq');
      // 3-й аргумент — тир назначения (llm:<tier>); по умолчанию fast.
      const tier = cfg.TIERS.includes(args[2]) ? args[2] : 'fast';
      const q = new Queue(tier, { connection: new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null }), prefix: cfg.QUEUE_PREFIX });
      const job = await q.add(args[0], tryJson(args[1]) || {}, { removeOnComplete: 200, removeOnFail: 200 });
      console.log(`Задача поставлена: #${job.id} ${args[0]} → ${cfg.queueFor(tier)}`);
      await q.close();
      return done();
    } else {
      return done(`Использование:
  fleet status
  fleet broadcast <ping|reload|drain|resume|update|set-model|rollback> [json]
  fleet submit <skill> <json> [tier]      # tier ∈ strong|fast|embed (по умолчанию fast)
Примеры:
  fleet broadcast set-model '{"model":"qwen2.5:14b"}'
  fleet broadcast update
  fleet submit parseSignal '{"text":"BTC long entry 65000 sl 63000 tp 70000"}' fast
  fleet submit chat '{"prompt":"привет"}' strong`);
    }
  } catch (e) { console.error('ERR', e.message); }
  await done();
})();
