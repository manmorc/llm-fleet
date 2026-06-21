#!/usr/bin/env node
// Раздаёт bootstrap-скрипт присоединения к флоту ПО ВНУТРЕННЕЙ СЕТИ (Tailscale/VPN).
// Скрипт генерится на лету из env (REDIS_URL с паролем берётся из окружения хоста, а НЕ из
// публичного репо). Привязка к Tailscale-IP (JOIN_HOST) → доступно только пирам сети, не наружу.
//
// Запуск на всегда-онлайн машине:
//   JOIN_REDIS_URL='redis://:PASS@100.65.89.101:6379' JOIN_HOST=100.65.89.101 node tools/join-server.js
// Присоединение машины, уже находящейся в VPN — ОДНОЙ командой:
//   curl -fsSL http://100.65.89.101:8088 | bash
const http = require('http');

const REDIS_URL  = process.env.JOIN_REDIS_URL || process.env.REDIS_URL;
const MODEL      = process.env.JOIN_MODEL || process.env.MODEL || 'qwen2.5:7b';
const OLLAMA_URL = process.env.JOIN_OLLAMA_URL || 'http://127.0.0.1:11434';
const INSTALL    = process.env.JOIN_INSTALL_URL || 'https://raw.githubusercontent.com/manmorc/llm-fleet/main/install.sh';
const HOST = process.env.JOIN_HOST || '0.0.0.0';     // ставь Tailscale-IP, чтобы не торчать наружу
const PORT = parseInt(process.env.JOIN_PORT || '8088', 10);

if (!REDIS_URL) { console.error('✗ задай JOIN_REDIS_URL (redis://:PASS@<tailscale-ip>:6379)'); process.exit(1); }

const bootstrap = `#!/usr/bin/env bash
set -euo pipefail
echo "▶ join llm-fleet"
curl -fsSL ${INSTALL} | REDIS_URL='${REDIS_URL}' MODEL='${MODEL}' OLLAMA_URL='${OLLAMA_URL}' bash
`;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
  res.end(bootstrap);
}).listen(PORT, HOST, () => {
  console.log(`join-server: http://${HOST}:${PORT}  → bootstrap (redis встроен из env)`);
  console.log(`присоединить машину из VPN:  curl -fsSL http://${HOST}:${PORT} | bash`);
});
