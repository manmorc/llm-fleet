require('dotenv').config();
const os = require('os');
const path = require('path');

// Вся конфигурация воркера — из ENV (.env пишется install.sh). Минимум обязательного: REDIS_URL.
module.exports = {
  redisUrl:        process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  queue:           process.env.QUEUE || 'llm-tasks',
  controlChannel:  process.env.CONTROL_CHANNEL || 'fleet:control',
  workerKeyPrefix: 'fleet:worker:',
  model:           process.env.MODEL || 'qwen2.5:7b',
  ollamaUrl:       process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  concurrency:     parseInt(process.env.CONCURRENCY || '2', 10),
  workerId:        process.env.WORKER_ID || os.hostname(),
  pm2Name:         process.env.PM2_NAME || 'llm-fleet',
  repoDir:         path.resolve(__dirname, '..'),
  heartbeatTtl:    30,      // сек: запись о воркере живёт 30с, обновляется каждые 10с
  heartbeatEvery:  10000,
};
