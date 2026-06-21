const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const os = require('os');
const cfg = require('./config');
const skills = require('./skills');
const { chat } = require('./ollama');
const { setupControl } = require('./control');
const { version } = require('./version');

// Один воркер на машину: тянет задачи из очереди, исполняет соответствующий скил (job.name === skill),
// шлёт heartbeat и слушает control-канал. Балансировка — самой очередью (pull/work-stealing).
const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker(cfg.queue, async (job) => {
  const skill = skills.get(job.name);
  if (!skill) throw new Error(`Неизвестный скил: ${job.name} (есть: ${skills.list().join(', ')})`);
  // ctx даёт скилу унифицированный доступ к модели — скилы не зависят от транспорта
  return skill.run(job.data, { model: job.data?._model || cfg.model, chat });
}, { connection, concurrency: cfg.concurrency });

let busy = 0;
worker.on('active',    () => { busy++; });
worker.on('completed', (job) => { busy = Math.max(0, busy - 1); console.log(`[done] ${job.name} #${job.id}`); });
worker.on('failed',    (job, err) => { busy = Math.max(0, busy - 1); console.error(`[fail] ${job?.name} #${job?.id}: ${err.message}`); });
worker.on('error',     (err) => console.error('[worker] error', err.message));

// --- Heartbeat в Redis (TTL): кто онлайн, на какой версии/модели, занятость ---
const hb = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
async function heartbeat() {
  const info = {
    id: cfg.workerId, host: os.hostname(), model: cfg.model, version: version(),
    skills: skills.list(), busy, concurrency: cfg.concurrency, paused: worker.isPaused(), ts: Date.now(),
  };
  await hb.set(cfg.workerKeyPrefix + cfg.workerId, JSON.stringify(info), 'EX', cfg.heartbeatTtl).catch(() => {});
}
heartbeat();
setInterval(heartbeat, cfg.heartbeatEvery);

setupControl(worker, { heartbeat });

console.log(`llm-fleet worker "${cfg.workerId}" up — queue=${cfg.queue} model=${cfg.model} version=${version()} concurrency=${cfg.concurrency}`);

// Грейсфул-шатдаун: доделать активные задачи (pm2 stop/restart шлёт SIGINT)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await worker.close(); await hb.del(cfg.workerKeyPrefix + cfg.workerId); } catch (_) {}
    process.exit(0);
  });
}
