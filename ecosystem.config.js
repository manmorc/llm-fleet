// pm2-конфиг ноды: воспроизводимый запуск ВСЕХ процессов (персистер + LLM-воркер + автономный агент).
// `pm2 start ecosystem.config.js` поднимает ноду детерминированно (версионируется в репо).
// СЕКРЕТ (REDIS_URL с паролем) — НЕ в репо: берётся из env или локального ~/.agent-bus/fleet.env (вне репо).
// Несекретные настройки (модель/AGENT_ROOT/id/режим надзора) — здесь, читаемо и версионируемо.
const os = require('os');
const fs = require('fs');
const path = require('path');

function localEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.agent-bus', 'fleet.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}
const L = localEnv();
const HOME = os.homedir();
const REDIS_URL = process.env.REDIS_URL || L.REDIS_URL || '';        // секрет — локально
const OLLAMA_URL = process.env.OLLAMA_URL || L.OLLAMA_URL || 'http://127.0.0.1:11434';
const NODE_ID = process.env.FLEET_NODE_ID || L.FLEET_NODE_ID || 'desktop-tt4i69c'; // bus/worker id ноды
// Боевая модель ноды — gemma-4-26b через llama-server (не ollama): по замерам она берёт 3/3 на
// тестах суждения там, где прежняя 8B давала 0/3 (tools/moe-serve/BENCHMARK.md). Поднимается
// ПО ТРЕБОВАНИЮ (agent/server.js), в простое VRAM свободна.
const MODEL = process.env.FLEET_MODEL || L.FLEET_MODEL || 'gemma26b';
const LLM_BACKEND = process.env.LLM_BACKEND || L.LLM_BACKEND || 'openai';
const LLM_URL = process.env.LLM_URL || L.LLM_URL || 'http://127.0.0.1:8081/v1';
const common = { cwd: __dirname, autorestart: true, max_restarts: 50, restart_delay: 3000, time: true };

module.exports = {
  apps: [
    // 1) durable-персистер входящих (единственный потребитель inbox ноды)
    { ...common, name: `agent-bus-${NODE_ID}`, script: 'mcp/agent-bus.persist.js',
      env: { REDIS_URL, AGENT_ID: NODE_ID } },
    // 2) BullMQ LLM-воркер (боевой инференс флота: parseSignal/chat/echo)
    { ...common, name: `llm-worker-${NODE_ID}`, script: 'src/worker.js',
      // LLM_MAX_TOKENS 16384 вместо дефолтных 8192. Причина — сбой 04.08: у думающей модели
      // размышление и ответ делят ОДИН бюджет, и на длинном судейском промпте (3.5 КБ инструкций)
      // бюджет кончался ДО первого знака ответа. Контекст у ноды 131072, так что 16384 — это
      // потолок, а не расход: короткие задачи (разбор новостей) его не заметят. Больше не ставлю
      // сознательно: потолок ограничивает и время худшей задачи, а в 10:15 UTC их прилетает до 515.
      env: { NODE_ENV: 'production', REDIS_URL, MODEL, WORKER_ID: NODE_ID, CONCURRENCY: '1', LLM_BACKEND, LLM_URL, OLLAMA_URL,
             LLM_MAX_TOKENS: process.env.LLM_MAX_TOKENS || L.LLM_MAX_TOKENS || '16384' } },
    // 3) автономный агент desktop-local (tool-use петля + judgment-mode, под надзором)
    { ...common, name: 'desktop-local-agent', script: 'agent/bus-agent.js',
      env: {
        REDIS_URL, MODEL, OLLAMA_URL,
        AGENT_BACKEND: LLM_BACKEND, AGENT_API_URL: LLM_URL,
        AGENT_ID: 'desktop-local',
        AGENT_PRIVKEY_FILE: path.join(HOME, '.agent-bus', 'desktop-local.key'),
        // НАДЗОР ЧЕРЕЗ ШИНУ (решение владельца 31.07.2026: «перепроверять его действия, хоть первую
        // неделю»). Каждое рисковое действие (write_file/shell) уходит заявкой в inbox desktop-tt4i69c
        // → персистер пишет в лог → Monitor будит живую сессию Claude → ответ через agent/approve.js.
        // Агент БЛОКИРУЕТСЯ до решения. Не ответили за таймаут — отказ (fail-closed), а не «пропустить».
        // Жёсткий чёрный список (rm -rf, кража ключей, автозапуск) режет ДО заявки и в любом режиме.
        // Вернуть read-only: AGENT_SUPERVISOR=deny.
        AGENT_SUPERVISOR: process.env.AGENT_SUPERVISOR || L.AGENT_SUPERVISOR || 'bus',
        AGENT_SUPERVISOR_ID: 'desktop-tt4i69c',
        // 10 минут вместо 2: заявка будит сессию через Monitor, и мне нужно реальное время заметить
        // и ответить. Короткий таймаут превращал бы надзор в «отказ по умолчанию» на любой отлучке.
        AGENT_APPROVAL_TIMEOUT: process.env.AGENT_APPROVAL_TIMEOUT || '600000',
        // Без этого рисковые тулзы не попадают даже в список схем — модель их не увидит, и надзору
        // будет нечего гейтить. Гейт (bus) и доступность (risky) — два РАЗНЫХ слоя, нужны оба.
        AGENT_ALLOW_RISKY: process.env.AGENT_ALLOW_RISKY || '1',
        AGENT_ROOT: path.join(HOME, 'agent-sandbox'),
      } },
    // 4) idle-watchdog: гасит gemma-26b на простое, освобождает VRAM (загрузка по требованию — в server.js).
    //    Data-cron ВНУТРИ сервиса: Claude НЕ зовёт, лимиты не тратит (PRINCIPLES §9). idle-таймаут env.
    { ...common, name: 'llama-watchdog', script: 'agent/llama-watchdog.js',
      env: { LLAMA_IDLE_MS: process.env.LLAMA_IDLE_MS || L.LLAMA_IDLE_MS || String(10 * 60 * 1000) } },
    // 6) мост Telegram → локальный агент: пишешь боту @gaymaster3000bot — отвечает агент

    //    с инструментами и памятью диалога. Long polling (машина за NAT). Только владелец.

    { ...common, name: 'tg-bridge', script: 'agent/tg-bridge.js', env: {} },

    // 7) удержание от сна на время работы: пока есть задачи/генерация/разговор по шине —
    //    сбрасываем счётчик простоя Windows; работы нет — отпускаем, и машина засыпает сама.
    //    Раньше сон был отключён «навсегда», и машина не спала вообще. Подробности — agent/keep-awake.js.
    { ...common, name: 'keep-awake', script: 'agent/keep-awake.js', env: {} },
    // 5) веб-шлюз чата: всегда жив, будит модель на первом сообщении, проксирует. Выставлен tailscale serve
    //    на https://desktop-tt4i69c.tail241f5d.ts.net/ — владелец общается с моделькой из браузера удалённо.
    { ...common, name: 'chat-gateway', script: 'agent/chat-gateway.js',
      env: { GW_PORT: process.env.GW_PORT || L.GW_PORT || '8090' } },
  ],
};
