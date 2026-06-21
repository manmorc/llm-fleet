#!/usr/bin/env bash
# Установка воркера llm-fleet ОДНОЙ командой:
#   curl -fsSL https://raw.githubusercontent.com/manmorc/llm-fleet/main/install.sh | REDIS_URL=redis://<ip>:6379 MODEL=qwen2.5:7b bash
set -euo pipefail

REPO="${LLM_FLEET_REPO:-https://github.com/manmorc/llm-fleet.git}"
DIR="${LLM_FLEET_DIR:-$HOME/llm-fleet}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
MODEL="${MODEL:-qwen2.5:7b}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
CONCURRENCY="${CONCURRENCY:-2}"

echo "▶ llm-fleet → $DIR  (redis=$REDIS_URL  model=$MODEL)"

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

echo "▶ тяну модель $MODEL"; ollama pull "$MODEL" || echo "⚠ не удалось ollama pull — подтяни вручную позже"

pm2 start ecosystem.config.js
pm2 save
pm2 startup >/dev/null 2>&1 || true   # автозапуск после ребута (может попросить sudo-команду — выполни её)

echo "✅ Воркер запущен. Проверка:  node $DIR/bin/fleet.js status   |   pm2 logs llm-fleet"
