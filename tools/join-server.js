#!/usr/bin/env node
// Раздаёт bootstrap-скрипт присоединения к флоту ПО ВНУТРЕННЕЙ СЕТИ (Tailscale/VPN).
// Скрипт генерится на лету из env (REDIS_URL с паролем берётся из окружения хоста, а НЕ из
// публичного репо). Привязка к Tailscale-IP (JOIN_HOST) → доступно только пирам сети, не наружу.
//
// Запуск на всегда-онлайн машине:
//   JOIN_REDIS_URL='redis://:PASS@100.65.89.101:6379' JOIN_HOST=100.65.89.101 node tools/join-server.js
// Присоединение машины, уже находящейся в VPN — ОДНОЙ командой. ДВА РАЗНЫХ адреса — две разные вещи:
//   ВОРКЕР флота (Ollama + модель + очередь):   curl -fsSL http://100.65.89.101:8088      | bash
//   он же под windows:                          irm http://100.65.89.101:8088/ps1 | iex   (или ?os=win)
//   УЗЕЛ ШИНЫ agent-bus (связь Claude-агентов): curl -fsSL http://100.65.89.101:8088/bus  | bash
// Воркеру нужен GPU и модель; узлу шины — ключ подписи и MCP-блок в конфиге Claude. Машина может быть
// тем, другим или обоими сразу, в любом порядке (оба bootstrap'а работают с одним клоном репозитория).
const http = require('http');
const path = require('path');
const fs = require('fs');

const REDIS_URL   = process.env.JOIN_REDIS_URL || process.env.REDIS_URL;
const MODEL       = process.env.JOIN_MODEL || process.env.MODEL || '';   // пусто → install.* сам подберёт по железу
const TIER        = process.env.JOIN_TIER || process.env.TIER || '';     // пусто → install.* выведет тир из MODEL/лестницы
const OLLAMA_URL  = process.env.JOIN_OLLAMA_URL || 'http://127.0.0.1:11434';
// Онбординг флота — develop-based (см. ONBOARDING §2: clone -b develop). install.ps1 есть только на develop;
// install.sh на develop свежее (MODEL_LADDER). Референс — develop для консистентности one-liner ⇄ ручного онбординга.
const INSTALL     = process.env.JOIN_INSTALL_URL || 'https://raw.githubusercontent.com/manmorc/llm-fleet/develop/install.sh';
const INSTALL_PS1 = process.env.JOIN_INSTALL_PS1_URL || 'https://raw.githubusercontent.com/manmorc/llm-fleet/develop/install.ps1';
// Bootstrap шины отдаём ТЕЛОМ с диска хаба, а не ссылкой на GitHub raw.
// Причина — не удобство: `curl -fsSL <404> | bash` завершается кодом 0 и НИЧЕГО не делает. Агент на
// новой машине увидел бы «команда выполнена без ошибок» там, где не выполнилось ничего. Отдавая файл
// сами, мы (а) не зависим от того, что хаб успел запушить, (б) можем ответить внятной ошибкой.
const INSTALL_BUS_FILE = process.env.JOIN_INSTALL_BUS_FILE || path.resolve(__dirname, '..', 'install-bus.sh');
// Каталог llm-fleet НА ХАБЕ — подставляется в печатаемую новичку команду признания, чтобы владельцу
// не приходилось вспоминать путь. Только для текста подсказки; на новичка никак не влияет.
const HUB_DIR = process.env.JOIN_HUB_DIR || path.resolve(__dirname, '..');
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

// Bootstrap ШИНЫ: те же принципы (секрет из env хоста, не из репо), но ставит не воркера, а узел
// agent-bus. Реестр доверия не трогает — новичок печатает свой публичный ключ и команду признания.
// Собирается на каждый запрос: правку install-bus.sh на хабе видно сразу, без рестарта раздатчика.
function busBootstrap() {
  let body;
  try { body = fs.readFileSync(INSTALL_BUS_FILE, 'utf8'); }
  catch (e) {
    return `#!/usr/bin/env bash\necho "✗ раздатчик не нашёл ${INSTALL_BUS_FILE} на хабе (${e.code}) — ставить нечего" >&2\nexit 1\n`;
  }
  return `#!/usr/bin/env bash
# Сгенерировано раздатчиком llm-fleet: окружение хаба + тело install-bus.sh (одним куском, чтобы
# не зависеть от второй сетевой загрузки, которая может тихо вернуть пустоту).
export REDIS_URL='${REDIS_URL}'
export HUB_DIR='${HUB_DIR}'
echo "▶ join agent-bus (хаб: ${HUB_DIR})"
${body}`;
}

// Windows-узел шины отдельным bootstrap'ом пока не раздаём — вместо тихой отдачи bash-скрипта,
// который в PowerShell не выполнится, говорим прямо и отправляем к ручной процедуре.
const busWinNote = `# Узел шины под Windows раздатчиком пока не автоматизирован.
# Bash-скрипт в PowerShell не выполнится, поэтому подставлять его сюда молча — хуже, чем отказать.
# Пройди ручную процедуру: ONBOARDING.md §3 (keygen → claude mcp add agent-bus → персистер → доктор).
`;

function route(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const win = url.pathname.endsWith('/ps1') || url.searchParams.get('os') === 'win';
  const bus = url.pathname === '/bus' || url.pathname.startsWith('/bus/');
  return { win, bus };
}

http.createServer((req, res) => {
  const { win, bus } = route(req);
  if (bus) {
    res.writeHead(200, { 'Content-Type': win ? 'text/plain; charset=utf-8' : 'text/x-shellscript' });
    res.end(win ? busWinNote : busBootstrap());
  } else if (win) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ps1Bootstrap);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
    res.end(bashBootstrap);
  }
}).listen(PORT, HOST, () => {
  console.log(`join-server: http://${HOST}:${PORT}  → bootstrap (redis встроен из env)`);
  console.log(`  воркер mac/linux:  curl -fsSL http://${HOST}:${PORT}     | bash`);
  console.log(`  воркер windows:    irm http://${HOST}:${PORT}/ps1 | iex`);
  console.log(`  узел шины:         curl -fsSL http://${HOST}:${PORT}/bus | bash   (хаб: ${HUB_DIR})`);
});
