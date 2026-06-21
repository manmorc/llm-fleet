const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const os = require('os');
const { execSync } = require('child_process');
const cfg = require('./config');
const skills = require('./skills');
const { chat } = require('./ollama');
const { setupControl } = require('./control');
const { version } = require('./version');

// Один воркер на машину: тянет задачи из очереди СВОЕГО тира (llm:<tier>, Routing v2),
// исполняет соответствующий скил (job.name === skill), шлёт heartbeat и слушает control-канал.
// Балансировка внутри тира — самой очередью (pull/work-stealing).

// VRAM узла (GB) для heartbeat: только NVIDIA dGPU через nvidia-smi; иначе null (не определяем).
function detectVram() {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n')[0].trim();
    const mib = parseInt(out, 10);
    if (Number.isFinite(mib) && mib > 0) return Math.round(mib / 1024);
  } catch (_) {}
  return null;
}
const vram = detectVram();

const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker(cfg.queueName, async (job) => {
  const skill = skills.get(job.name);
  if (!skill) throw new Error(`Неизвестный скил: ${job.name} (есть: ${skills.list().join(', ')})`);
  // ctx даёт скилу унифицированный доступ к модели — скилы не зависят от транспорта
  return skill.run(job.data, { model: job.data?._model || cfg.model, chat });
}, { connection, concurrency: cfg.concurrency, prefix: cfg.queuePrefix });

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
    skills: skills.list(), busy, concurrency: cfg.concurrency, paused: worker.isPaused(),
    tier: cfg.tier, vram, ts: Date.now(),
  };
  await hb.set(cfg.workerKeyPrefix + cfg.workerId, JSON.stringify(info), 'EX', cfg.heartbeatTtl).catch(() => {});
}
heartbeat();
setInterval(heartbeat, cfg.heartbeatEvery);

setupControl(worker, { heartbeat });

console.log(`llm-fleet worker "${cfg.workerId}" up — tier=${cfg.tier} queue=${cfg.queue} model=${cfg.model} version=${version()} concurrency=${cfg.concurrency}${vram ? ` vram=${vram}GB` : ''}`);

// Грейсфул-шатдаун: доделать активные задачи (pm2 stop/restart шлёт SIGINT)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await worker.close(); await hb.del(cfg.workerKeyPrefix + cfg.workerId); } catch (_) {}
    process.exit(0);
  });
}
