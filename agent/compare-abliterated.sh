#!/bin/bash
# Полное сравнение обычной gpt-oss против аблитерированной (heretic) — на ОДНОМ железе и коде.
# Обе модели в ОДНОЙ квантизации MXFP4 — иначе разница шла бы от формата, а не от аблитерации.
#
# Что меряем:
#   1. отказы на финансовых вопросах  — ради этого всё и затевалось (база: 20%)
#   2. 12 задач бенча                 — не просела ли общая способность (цена аблитерации)
#   3. задача про мойку               — гипотеза: аблитерация НЕ поможет (это дыра в модели мира)
#
# Запуск: bash agent/compare-abliterated.sh
set -u
cd "$(dirname "$0")/.."

BASE_MODEL="$HOME/.lmstudio/models/ggml-org/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf"
ABL_MODEL="$HOME/.lmstudio/models/mradermacher/gpt-oss-20b-heretic-GGUF/gpt-oss-20b-heretic.MXFP4_MOE.gguf"
LLAMA="$HOME/tools/llama.cpp-b10046/llama-server.exe"

start_model() {   # $1=путь $2=алиас
  powershell -NoProfile -Command "Stop-Process -Name llama-server -Force -ErrorAction SilentlyContinue" 2>/dev/null
  sleep 4
  "$LLAMA" -m "$1" -ngl 99 --n-cpu-moe 2 -c 16384 --host 127.0.0.1 --port 8081 -a "$2" --jinja >/dev/null 2>&1 &
  for i in $(seq 1 40); do
    sleep 3
    curl -sf --max-time 5 -o /dev/null -X POST http://127.0.0.1:8081/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" 2>/dev/null && { echo "  ✅ $2 поднялась (~$((i*3))с)"; return 0; }
    tasklist //FI "IMAGENAME eq llama-server.exe" //NH 2>/dev/null | grep -q llama-server || { echo "  ❌ $2 умерла при загрузке"; return 1; }
  done
  echo "  ❌ $2 не поднялась за 120с"; return 1
}

echo "════ АБЛИТЕРИРОВАННАЯ (heretic) ════"
[ -f "$ABL_MODEL" ] || { echo "  нет файла: $ABL_MODEL"; exit 1; }
start_model "$ABL_MODEL" "gpt-oss-abl" || exit 1
nvidia-smi --query-gpu=memory.used --format=csv,noheader | xargs echo "  VRAM:"
echo ""
echo "── отказы (база была 4/20 = 20%) ──"
BENCH_MODEL=gpt-oss-abl BENCH_NO_ENSURE=1 LLAMA_AUTOSTART=0 node agent/bench-refusal.js abliterated 2>&1 | grep -vE "^\[модель\]"
echo ""
echo "── 12 задач бенча (база: 9/12, 107 t/s) ──"
BENCH_MODEL=gpt-oss-abl BENCH_NO_ENSURE=1 LLAMA_AUTOSTART=0 node agent/bench-compare.js gptoss-abl 2>&1 | grep -vE "^\[модель\]"

echo ""
echo "════ ВОЗВРАТ НА БОЕВУЮ (обычная gpt-oss) ════"
start_model "$BASE_MODEL" "gpt-oss"
echo "  готово — нода снова на штатной модели"
