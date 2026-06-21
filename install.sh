#!/usr/bin/env bash
# Установка воркера llm-fleet ОДНОЙ командой:
#   curl -fsSL https://raw.githubusercontent.com/manmorc/llm-fleet/main/install.sh | REDIS_URL=redis://<ip>:6379 bash
# MODEL подбирается автоматически по железу (см. лестницу MODEL_LADDER ниже).
# Если задать MODEL=... явно — авто-подбор пропускается, берётся указанная модель.
set -euo pipefail

# ── Лестница моделей: подбор по бюджету памяти (GB). РЕДАКТИРУЙ ТУТ, чтобы сменить семейство. ──
# Формат строки: "<минимум_GB> <модель>". Сортировка по убыванию — берётся первая подходящая.
# Бюджет Q4 ≈ params×0.65 GB.
MODEL_LADDER=(
  "22 qwen3:32b"   # strong
  "11 qwen3:14b"   # fast
  "6  qwen3:8b"
  "0  qwen3:4b"    # light (всё, что меньше 6GB)
)
EMBED_MODEL="nomic-embed-text"   # эмбеддинги тянет КАЖДЫЙ узел

REPO="${LLM_FLEET_REPO:-https://github.com/manmorc/llm-fleet.git}"
DIR="${LLM_FLEET_DIR:-$HOME/llm-fleet}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
CONCURRENCY="${CONCURRENCY:-2}"

# ── Определение бюджета памяти (GB) + выбор модели ──────────────────────────────
# budget = NVIDIA dGPU → VRAM · Apple Silicon → unified RAM×0.7 · CPU-only → RAM×0.6 (но не выше light/embed).
# Эхо: detected budget + выбранная модель. Печатает выбранную модель в stdout (последняя строка).
detect_budget() {
  local gpu_kind="cpu" budget=0 cpu_only=1

  # NVIDIA dGPU? VRAM в MiB → GB.
  if command -v nvidia-smi >/dev/null 2>&1; then
    local vram_mib
    vram_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ' || true)"
    if [ -n "${vram_mib:-}" ] && [ "$vram_mib" -gt 0 ] 2>/dev/null; then
      gpu_kind="nvidia"; cpu_only=0
      budget=$(( vram_mib / 1024 ))
    fi
  fi

  # Apple Silicon: unified RAM × 0.7.
  if [ "$gpu_kind" = "cpu" ] && [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    gpu_kind="apple"; cpu_only=0
    local ram_bytes ram_gb
    ram_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    ram_gb=$(( ram_bytes / 1024 / 1024 / 1024 ))
    budget=$(awk -v r="$ram_gb" 'BEGIN{printf "%d", r*0.7}')
  fi

  # CPU-only (нет dGPU, не Apple Silicon): RAM × 0.6.
  if [ "$gpu_kind" = "cpu" ]; then
    local ram_gb=0
    if [ "$(uname -s)" = "Darwin" ]; then
      ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
    elif [ -r /proc/meminfo ]; then
      local kb; kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
      ram_gb=$(( kb / 1024 / 1024 ))
    fi
    budget=$(awk -v r="$ram_gb" 'BEGIN{printf "%d", r*0.6}')
  fi

  echo "$gpu_kind $budget $cpu_only"
}

pick_model() {
  local budget="$1" cpu_only="$2" chosen="" floor min model
  for rung in "${MODEL_LADDER[@]}"; do
    min="${rung%% *}"; model="${rung##* }"
    if [ "$budget" -ge "$min" ]; then chosen="$model"; break; fi
  done
  [ -z "$chosen" ] && chosen="${MODEL_LADDER[-1]##* }"

  # CPU-only: не запускаем тяжёлую генерацию — ограничиваем потолок light/embed.
  if [ "$cpu_only" = "1" ]; then
    floor="${MODEL_LADDER[-1]##* }"   # самый лёгкий рунг = light
    chosen="$floor"
  fi
  echo "$chosen"
}

if [ -n "${MODEL:-}" ]; then
  echo "▶ MODEL задан явно: $MODEL (авто-подбор пропущен)"
else
  read -r GPU_KIND BUDGET_GB CPU_ONLY <<<"$(detect_budget)"
  MODEL="$(pick_model "$BUDGET_GB" "$CPU_ONLY")"
  echo "▶ железо: $GPU_KIND · бюджет ≈ ${BUDGET_GB}GB$([ "$CPU_ONLY" = "1" ] && echo ' (CPU-only → потолок light/embed)') → MODEL=$MODEL"
fi

echo "▶ llm-fleet → $DIR  (redis=$REDIS_URL  model=$MODEL  embed=$EMBED_MODEL)"

command -v node  >/dev/null || { echo "✗ нужен Node.js 18+ (поставь и повтори)"; exit 1; }
command -v git   >/dev/null || { echo "✗ нужен git"; exit 1; }
command -v ollama>/dev/null || { echo "▶ ставлю Ollama"; curl -fsSL https://ollama.com/install.sh | sh; }
command -v pm2   >/dev/null || { echo "▶ ставлю pm2"; npm install -g pm2; }

if [ -d "$DIR/.git" ]; then echo "▶ обновляю репо"; git -C "$DIR" pull --ff-only; else echo "▶ клонирую"; git clone "$REPO" "$DIR"; fi
cd "$DIR"
echo "▶ npm install"; npm install --omit=dev

cat > .env <<EOF
REDIS_URL=$REDIS_URL
MODEL=$MODEL
OLLAMA_URL=$OLLAMA_URL
CONCURRENCY=$CONCURRENCY
EOF

echo "▶ тяну модель $MODEL"; ollama pull "$MODEL" || echo "⚠ не удалось ollama pull $MODEL — подтяни вручную позже"
echo "▶ тяну эмбеддинги $EMBED_MODEL"; ollama pull "$EMBED_MODEL" || echo "⚠ не удалось ollama pull $EMBED_MODEL — подтяни вручную позже"

pm2 start ecosystem.config.js
pm2 save
pm2 startup >/dev/null 2>&1 || true   # автозапуск после ребута (может попросить sudo-команду — выполни её)

echo "✅ Воркер запущен. Проверка:  node $DIR/bin/fleet.js status   |   pm2 logs llm-fleet"
