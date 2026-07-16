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
      env: { NODE_ENV: 'production', REDIS_URL, MODEL, WORKER_ID: NODE_ID, CONCURRENCY: '1', LLM_BACKEND, LLM_URL, OLLAMA_URL } },
    // 3) автономный агент desktop-local (tool-use петля + judgment-mode, под надзором)
    { ...common, name: 'desktop-local-agent', script: 'agent/bus-agent.js',
      env: {
        REDIS_URL, MODEL, OLLAMA_URL,
        AGENT_BACKEND: LLM_BACKEND, AGENT_API_URL: LLM_URL,
        AGENT_ID: 'desktop-local',
        AGENT_PRIVKEY_FILE: path.join(HOME, '.agent-bus', 'desktop-local.key'),
        AGENT_SUPERVISOR: process.env.AGENT_SUPERVISOR || L.AGENT_SUPERVISOR || 'deny', // read-only обкатка
        AGENT_ROOT: path.join(HOME, 'agent-sandbox'),
      } },
  ],
};
