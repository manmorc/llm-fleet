require('dotenv').config();
const os = require('os');
const path = require('path');

// Тиры (Routing v2): воркеры разнесены по очередям по «силе» модели.
// strong — тяжёлые модели, fast — средние/лёгкие, embed — эмбеддинги (зарезервировано).
const TIERS = ['strong', 'fast', 'embed'];

// Карта модель→тир: какой моделью какой тир обслуживается. Зеркалит лестницу из install.sh.
// Если MODEL нет в карте — по умолчанию fast (см. tierFor).
const MODEL_TIER = {
  'qwen3:32b': 'strong',
  'qwen3:14b': 'fast',
  'qwen3:8b':  'fast',
  'qwen3:4b':  'fast',
  'nomic-embed-text': 'embed',
};

// Тир воркера: явный TIER из env → иначе вывод из MODEL по карте → иначе fast.
function tierFor(model, envTier) {
  if (envTier && TIERS.includes(envTier)) return envTier;
  return MODEL_TIER[model] || 'fast';
}

// Очереди тиров (Routing v2): в Redis ключи лежат под namespace llm:<tier> (llm:strong:*, llm:fast:*, llm:embed:*).
// BullMQ строит ключ как `<prefix>:<queueName>:...` и ЗАПРЕЩАЕТ ':' в имени очереди → выражаем llm:<tier>
// как prefix='llm' + queueName=<tier>. Полное имя очереди (для логов/контрол-центра) — llm:<tier>.
const QUEUE_PREFIX = 'llm';
function queueFor(tier) { return `${QUEUE_PREFIX}:${tier}`; }  // человекочитаемое полное имя

const model = process.env.MODEL || 'qwen2.5:7b';
const tier  = tierFor(model, process.env.TIER);

// QUEUE — DEPRECATED явный override (старая одиночная llm-tasks без префикса). По умолчанию — очередь тира.
const legacyQueue = process.env.QUEUE;

// Вся конфигурация воркера — из ENV (.env пишется install.sh). Минимум обязательного: REDIS_URL.
module.exports = {
  redisUrl:        process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  tier,
  // queueName/queuePrefix — то, что отдаём в BullMQ. queue — полное человекочитаемое имя (llm:<tier> или legacy).
  queueName:       legacyQueue || tier,
  queuePrefix:     legacyQueue ? 'bull' : QUEUE_PREFIX,   // legacy llm-tasks жил под дефолтным префиксом 'bull'
  queue:           legacyQueue || queueFor(tier),
  controlChannel:  process.env.CONTROL_CHANNEL || 'fleet:control',
  workerKeyPrefix: 'fleet:worker:',
  model,
  ollamaUrl:       process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  concurrency:     parseInt(process.env.CONCURRENCY || '2', 10),
  workerId:        process.env.WORKER_ID || os.hostname(),
  pm2Name:         process.env.PM2_NAME || 'llm-fleet',
  repoDir:         path.resolve(__dirname, '..'),
  heartbeatTtl:    30,      // сек: запись о воркере живёт 30с, обновляется каждые 10с
  heartbeatEvery:  10000,
  // Утилиты тиров — переиспользуются в bin/fleet.js.
  TIERS, QUEUE_PREFIX, queueFor, tierFor,
};
