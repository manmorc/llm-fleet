require('dotenv').config();
const os = require('os');
const path = require('path');
const fs = require('fs');

// REDIS_URL из ~/.agent-bus/fleet.env, если его нет в окружении.
// Тот же дефект, что был в mcp/bus-send.js: pm2-сервисы получают URL из ecosystem, а ручной
// запуск (bin/fleet.js, скрипты, cron) — нет, и код молча уходил на localhost:6379, где Redis
// нет ни на одной ноде флота. С ioredis это не ошибка, а ВЕЧНЫЙ РЕТРАЙ: `fleet submit` висел,
// пока его не убивали снаружи, печатая ECONNREFUSED сотнями строк. Проверено на себе 04.08.
// Файл лежит вне репозитория (там пароль) и есть на всех нодах — читатель общий, значение локальное.
function fromFleetEnv(key) {
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}

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

// Дефолт модели зависит от бэкенда: на openai-ноде (llama-server) — gpt-oss, иначе ollama-модель.
// Иначе на desktop без явного MODEL воркер слал бы model:'qwen2.5:7b' — llama-server игнорирует имя
// и отдаёт загруженную модель (тихо не та), а heartbeat рекламировал бы флоту qwen2.5:7b.
// Согласовано с loop.js (там тот же принцип).
const _backend = process.env.LLM_BACKEND || 'ollama';
const model = process.env.MODEL || (_backend === 'openai' ? 'gpt-oss' : 'qwen2.5:7b');
const tier  = tierFor(model, process.env.TIER);

// QUEUE — DEPRECATED явный override (старая одиночная llm-tasks без префикса). По умолчанию — очередь тира.
const legacyQueue = process.env.QUEUE;

// Вся конфигурация воркера — из ENV (.env пишется install.sh). Минимум обязательного: REDIS_URL.
module.exports = {
  // Фолбэк на localhost оставлен ПОСЛЕДНИМ и осознанно: на ноде без fleet.env (свежая установка,
  // локальный Redis в разработке) поведение прежнее. Но флотовые ноды теперь попадают в шину.
  redisUrl:        process.env.REDIS_URL || fromFleetEnv('REDIS_URL') || 'redis://127.0.0.1:6379',
  tier,
  // queueName/queuePrefix — то, что отдаём в BullMQ. queue — полное человекочитаемое имя (llm:<tier> или legacy).
  queueName:       legacyQueue || tier,
  queuePrefix:     legacyQueue ? 'bull' : QUEUE_PREFIX,   // legacy llm-tasks жил под дефолтным префиксом 'bull'
  queue:           legacyQueue || queueFor(tier),
  controlChannel:  process.env.CONTROL_CHANNEL || 'fleet:control',
  workerKeyPrefix: 'fleet:worker:',
  model,
  // Бэкенд инференса. ДЕФОЛТ 'ollama' МЕНЯТЬ НЕЛЬЗЯ: src/ — общий код флота, деплоится на все ноды,
  // а на mac/linux крутится ollama+qwen3. Нода desktop включает openai (gpt-oss-20b) через свой
  // ecosystem.config.js — конфигом, а не сменой общего дефолта.
  backend:         process.env.LLM_BACKEND || 'ollama',
  llmUrl:          process.env.LLM_URL || (process.env.LLM_BACKEND === 'openai'
                     ? 'http://127.0.0.1:8081/v1'
                     : (process.env.OLLAMA_URL || 'http://127.0.0.1:11434')),
  ollamaUrl:       process.env.OLLAMA_URL || 'http://127.0.0.1:11434',   // legacy-читатели
  // max_tokens — ПОТОЛОК, а не цель (модель заканчивает сама). У думающих моделей размышление
  // и ответ делят ОДИН бюджет: мало → ответ пустой (finish=length). Замерено: 8192 достаточно.
  maxTokens:       parseInt(process.env.LLM_MAX_TOKENS || '8192', 10),
  concurrency:     parseInt(process.env.CONCURRENCY || '2', 10),
  workerId:        process.env.WORKER_ID || os.hostname(),
  pm2Name:         process.env.PM2_NAME || 'llm-fleet',
  repoDir:         path.resolve(__dirname, '..'),
  heartbeatTtl:    30,      // сек: запись о воркере живёт 30с, обновляется каждые 10с
  heartbeatEvery:  10000,
  // Утилиты тиров — переиспользуются в bin/fleet.js.
  TIERS, QUEUE_PREFIX, queueFor, tierFor,
};
