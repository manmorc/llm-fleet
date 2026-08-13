#!/usr/bin/env bash
# Подключение машины к ШИНЕ agent-bus одной командой (mac/linux).
#
# Это НЕ install.sh: тот ставит LLM-воркера (Ollama + модель + pm2-воркер очереди) и про шину не знает
# вообще. Здесь — связь между Claude-агентами: ключ подписи, MCP-блок в конфиге Claude, durable-приём.
# Машине не нужен GPU и не нужна Ollama, чтобы быть на шине.
#
# Раздаётся с хаба:  curl -fsSL http://<tailscale-ip>:8088/bus | bash
# (REDIS_URL с паролем подставляет раздатчик tools/join-server.js из своего окружения — в репозитории
#  секрета нет и быть не должно.)
#
# ГРАНИЦА, КОТОРУЮ ЭТОТ СКРИПТ НЕ ПЕРЕСЕКАЕТ: он НЕ вносит себя в реестр mcp/agent-keys.json.
# Подписанное сообщение на шине = полноценная авторизация ⇒ запись в реестр это выдача прав, а не
# настройка связи. Самозапись означала бы, что любая машина, дотянувшаяся до порта раздатчика,
# выписывает себе право командовать остальными. Поэтому скрипт заканчивается публичным ключом и
# ГОТОВОЙ командой признания для владельца — а решение остаётся человеческим.
set -euo pipefail

REPO="${LLM_FLEET_REPO:-https://github.com/manmorc/llm-fleet.git}"
BRANCH="${LLM_FLEET_BRANCH:-develop}"
DIR="${LLM_FLEET_DIR:-$HOME/llm-fleet}"          # тот же каталог, что у install.sh → один клон на воркера и шину
REDIS_URL="${REDIS_URL:-}"
HUB_DIR="${HUB_DIR:-<каталог llm-fleet на хабе>}" # только для печати команды признания
BUS_PERSIST="${BUS_PERSIST:-auto}"                # auto|1|0 — durable-приём под pm2
KEYDIR="$HOME/.agent-bus"

# AGENT_ID: имя узла на шине. Должно быть стабильным (ключ подписи привязан к нему) и уникальным.
default_id() { hostname -s 2>/dev/null || hostname; }
AGENT_ID="${AGENT_ID:-$(default_id | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-' | sed 's/-*$//')}"
AGENT_LABEL="${AGENT_LABEL:-agent}"

say()  { printf '▶ %s\n'  "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ -n "$REDIS_URL" ] || fail "не задан REDIS_URL. Через раздатчик он подставляется сам; вручную:
  REDIS_URL='redis://:<PASS>@<координатор>:6379' bash install-bus.sh"
[ -n "$AGENT_ID" ] || fail "не удалось определить AGENT_ID — задай явно: AGENT_ID=<имя> ..."

say "agent-bus → узел «$AGENT_ID» (роль: $AGENT_LABEL), репозиторий $DIR"

# ── 1. Предусловия ─────────────────────────────────────────────────────────────────────────────
command -v git  >/dev/null || fail "нужен git"
command -v node >/dev/null || fail "нужен Node.js 18+ (нет node в PATH)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "нужен Node.js 18+, установлен $(node -v) (в agent-bus.js используется fetch)"
command -v npm  >/dev/null || fail "нужен npm"

# ── 2. Репозиторий: клон или обновление. Занятый чужим каталог НЕ трогаем ───────────────────────
if [ -d "$DIR/.git" ]; then
  ORIGIN="$(git -C "$DIR" remote get-url origin 2>/dev/null || echo '')"
  case "$ORIGIN" in
    *llm-fleet*) : ;;
    *) fail "каталог $DIR — это git-репозиторий ДРУГОГО проекта (origin: ${ORIGIN:-нет}).
  Ничего не перезаписываю. Задай другой каталог: LLM_FLEET_DIR=<путь> ..." ;;
  esac
  say "обновляю репозиторий"
  git -C "$DIR" pull --ff-only || echo "⚠ git pull не прошёл (локальные правки/расхождение веток) — работаю на том, что есть"
elif [ -e "$DIR" ]; then
  fail "каталог $DIR уже существует и это НЕ git-репозиторий. Ничего не перезаписываю.
  Убери его или задай другой: LLM_FLEET_DIR=<путь> ..."
else
  say "клонирую $REPO ($BRANCH)"
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

# Клон обязан содержать то, чем мы сейчас будем пользоваться. Раздатчик отдаёт ЭТОТ скрипт с диска
# хаба, а репозиторий приезжает с GitHub — если хаб не запушил новые файлы, версии разъедутся.
# Такой разъезд должен быть громким отказом здесь, а не «ошибкой node» через три шага.
for need in mcp/agent-bus.js mcp/claude-config.js mcp/bus-doctor.js mcp/keygen.js; do
  [ -f "$DIR/$need" ] || fail "в ветке $BRANCH нет $need — хаб раздаёт bootstrap новее, чем запушил.
  На хабе выполнить: git -C <llm-fleet> push origin $BRANCH  — и повторить эту команду."
done

say "npm install"
npm install --omit=dev >/dev/null || fail "npm install не прошёл — без ioredis шина не поднимется"

# ── 3. Ключ подписи. Идемпотентно: существующий НЕ трогаем ──────────────────────────────────────
# Перегенерация ключа сломала бы уже выданное доверие (в реестре у владельца лежит старый публичный),
# причём молча: сообщения стали бы BAD у всех получателей. keygen.js сам отказывается без --force —
# мы этот отказ не глушим, а проверяем наличие ключа явно и говорим, что происходит.
if [ -f "$KEYDIR/agent.key" ]; then
  say "ключ подписи уже есть ($KEYDIR/agent.key) — НЕ перегенерирую (это сломало бы выданное доверие)"
else
  say "генерю ключ подписи Ed25519"
  AGENT_ID="$AGENT_ID" node mcp/keygen.js "$AGENT_ID" >/dev/null || fail "keygen.js не отработал"
fi
chmod 600 "$KEYDIR/agent.key"

# Секреты держим вне репозитория, режим 600: удобно для bus-send.js/bus-selftest.js из шелла.
OLD_UMASK="$(umask)"; umask 077
cat > "$KEYDIR/env.sh" <<EOF
# Окружение узла шины. ЛОКАЛЬНО, chmod 600, НЕ коммитить и НЕ слать по шине.
export REDIS_URL='$REDIS_URL'
export AGENT_ID='$AGENT_ID'
export LLM_FLEET_DIR='$DIR'
EOF
chmod 600 "$KEYDIR/env.sh"
umask "$OLD_UMASK"

# ── 4. MCP-блок в конфиге Claude — СЛИЯНИЕМ (в ~/.claude.json живут личные данные владельца) ────
say "вписываю MCP-блок agent-bus в конфиг Claude"
node mcp/claude-config.js --id "$AGENT_ID" --label "$AGENT_LABEL" \
  --server "$DIR/mcp/agent-bus.js" --redis-url "$REDIS_URL" || exit 1

# ── 5. Durable-приём под pm2 (переживает рестарт сессии; пишет ~/.agent-bus/<id>.log для вотчера) ─
if [ "$BUS_PERSIST" != "0" ] && command -v pm2 >/dev/null; then
  say "поднимаю персистер под pm2 (agent-bus-$AGENT_ID)"
  if pm2 describe "agent-bus-$AGENT_ID" >/dev/null 2>&1; then
    REDIS_URL="$REDIS_URL" AGENT_ID="$AGENT_ID" pm2 restart "agent-bus-$AGENT_ID" --update-env >/dev/null
  else
    REDIS_URL="$REDIS_URL" AGENT_ID="$AGENT_ID" pm2 start mcp/agent-bus.persist.js --name "agent-bus-$AGENT_ID" --time >/dev/null
  fi
  pm2 save >/dev/null 2>&1 || true
elif [ "$BUS_PERSIST" = "1" ]; then
  fail "BUS_PERSIST=1, но pm2 не найден — поставь: npm i -g pm2"
else
  echo "⚠ pm2 не найден → durable-приём НЕ поднят: входящие будут видны только живой MCP-сессии,"
  echo "  сообщения за время простоя останутся лежать в ящике непрочитанными. Включить: npm i -g pm2 и повторить."
fi

# ── 6. Приёмка: проверяем результат, а не факт запуска ──────────────────────────────────────────
echo ""
say "приёмка узла"
node mcp/bus-doctor.js --hub-dir "$HUB_DIR"
