#!/usr/bin/env bash
# Разворачивание llama.cpp + модели на арендованном GPU-поде RunPod.
# Запускается один раз по SSH сразу после создания пода:
#   ssh root@<host> -p <port> 'bash -s' < cloud/runpod-bootstrap.sh
#
# Идемпотентен: повторный запуск ничего не ломает и не качает заново.
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-unsloth/gpt-oss-120b-GGUF}"
MODEL_FILE="${MODEL_FILE:-gpt-oss-120b-Q4_K_M.gguf}"
CTX="${CTX:-131072}"
PORT="${PORT:-8081}"
WORK=/workspace

echo "=== 1/5 Системные пакеты ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential cmake git curl python3-pip nvtop >/dev/null

echo "=== 2/5 Что за железо ==="
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
echo "ОЗУ: $(free -g | awk '/^Mem:/{print $2}') ГБ | Диск: $(df -h $WORK | awk 'NR==2{print $4}') свободно"

echo "=== 3/5 llama.cpp ==="
if [ ! -x "$WORK/llama.cpp/build/bin/llama-server" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$WORK/llama.cpp" 2>/dev/null || true
  cd "$WORK/llama.cpp"
  # CUDA-сборка; архитектуру определяем по карте, чтобы не собирать всё подряд
  ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')
  cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" -DLLAMA_CURL=ON >/dev/null
  cmake --build build --config Release -j"$(nproc)" --target llama-server llama-bench >/dev/null
  echo "собран (arch $ARCH)"
else
  echo "уже собран, пропускаю"
fi

echo "=== 4/5 Модель: $MODEL_REPO / $MODEL_FILE ==="
pip install -q huggingface_hub[cli] 2>/dev/null || true
mkdir -p "$WORK/models"
if [ ! -f "$WORK/models/$MODEL_FILE" ]; then
  hf download "$MODEL_REPO" "$MODEL_FILE" --local-dir "$WORK/models" >/dev/null
fi
ls -lh "$WORK/models/$MODEL_FILE" | awk '{print "  вес:", $5}'

echo "=== 5/5 Запуск сервера ==="
pkill -f llama-server || true
sleep 1
nohup "$WORK/llama.cpp/build/bin/llama-server" \
  -m "$WORK/models/$MODEL_FILE" \
  -c "$CTX" -ngl 999 \
  -ctk q8_0 -ctv q8_0 \
  --host 0.0.0.0 --port "$PORT" \
  --alias gpt-oss \
  > "$WORK/llama-server.log" 2>&1 &

for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "сервер поднялся за ${i}с на порту $PORT"
    curl -s "http://127.0.0.1:$PORT/props" | head -c 400; echo
    exit 0
  fi
  sleep 2
done

echo "ОШИБКА: сервер не ответил за 180с. Хвост лога:" >&2
tail -40 "$WORK/llama-server.log" >&2
exit 1
