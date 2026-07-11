#!/usr/bin/env node
// Раздаёт bootstrap-скрипт присоединения к флоту ПО ВНУТРЕННЕЙ СЕТИ (Tailscale/VPN).
// Скрипт генерится на лету из env (REDIS_URL с паролем берётся из окружения хоста, а НЕ из
// публичного репо). Привязка к Tailscale-IP (JOIN_HOST) → доступно только пирам сети, не наружу.
//
// Запуск на всегда-онлайн машине:
//   JOIN_REDIS_URL='redis://:PASS@100.65.89.101:6379' JOIN_HOST=100.65.89.101 node tools/join-server.js
// Присоединение машины, уже находящейся в VPN — ОДНОЙ командой:
//   mac/linux:  curl -fsSL http://100.65.89.101:8088     | bash
//   windows:    irm http://100.65.89.101:8088/ps1 | iex     (или ?os=win)
const http = require('http');

const REDIS_URL   = process.env.JOIN_REDIS_URL || process.env.REDIS_URL;
const MODEL       = process.env.JOIN_MODEL || process.env.MODEL || '';   // пусто → install.* сам подберёт по железу
const TIER        = process.env.JOIN_TIER || process.env.TIER || '';     // пусто → install.* выведет тир из MODEL/лестницы
const OLLAMA_URL  = process.env.JOIN_OLLAMA_URL || 'http://127.0.0.1:11434';
// Онбординг флота — develop-based (см. ONBOARDING §2: clone -b develop). install.ps1 есть только на develop;
// install.sh на develop свежее (MODEL_LADDER). Референс — develop для консистентности one-liner ⇄ ручного онбординга.
const INSTALL     = process.env.JOIN_INSTALL_URL || 'https://raw.githubusercontent.com/manmorc/llm-fleet/develop/install.sh';
const INSTALL_PS1 = process.env.JOIN_INSTALL_PS1_URL || 'https://raw.githubusercontent.com/manmorc/llm-fleet/develop/install.ps1';
const HOST = process.env.JOIN_HOST || '0.0.0.0';     // ставь Tailscale-IP, чтобы не торчать наружу
const PORT = parseInt(process.env.JOIN_PORT || '8088', 10);

if (!REDIS_URL) { console.error('✗ задай JOIN_REDIS_URL (redis://:PASS@<tailscale-ip>:6379)'); process.exit(1); }

// MODEL/TIER='' → не передаём в install.*, чтобы сработал авто-подбор по железу. Иначе задаём явно.
const bashBootstrap = `#!/usr/bin/env bash
set -euo pipefail
echo "▶ join llm-fleet"
curl -fsSL ${INSTALL} | REDIS_URL='${REDIS_URL}'${MODEL ? ` MODEL='${MODEL}'` : ''}${TIER ? ` TIER='${TIER}'` : ''} OLLAMA_URL='${OLLAMA_URL}' bash
`;

// PS1-вариант для Windows: инжектит те же env и заканчивается iex-запуском install.ps1.
const ps1Bootstrap = `# join llm-fleet (Windows / PowerShell as admin)
$ErrorActionPreference = 'Stop'
Write-Host "> join llm-fleet"
$env:REDIS_URL  = '${REDIS_URL}'
${MODEL ? `$env:MODEL = '${MODEL}'\n` : ''}${TIER ? `$env:TIER = '${TIER}'\n` : ''}$env:OLLAMA_URL = '${OLLAMA_URL}'
irm ${INSTALL_PS1} | iex
`;

function wantsWin(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  return url.pathname === '/ps1' || url.searchParams.get('os') === 'win';
}

http.createServer((req, res) => {
  if (wantsWin(req)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ps1Bootstrap);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
    res.end(bashBootstrap);
  }
}).listen(PORT, HOST, () => {
  console.log(`join-server: http://${HOST}:${PORT}  → bootstrap (redis встроен из env)`);
  console.log(`  mac/linux:  curl -fsSL http://${HOST}:${PORT}     | bash`);
  console.log(`  windows:    irm http://${HOST}:${PORT}/ps1 | iex`);
});
