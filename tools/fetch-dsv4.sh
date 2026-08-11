#!/usr/bin/env bash
# Закачка DeepSeek-V4-Flash (UD-Q4_K_XL, 155 ГБ, 5 частей).
#
# ПАРАЛЛЕЛЬНО, И ЭТО НЕ ПРИХОТЬ: HuggingFace режет ОДНО соединение до ~7.6 МБ/с, а суммарно канал
# держит ~54 МБ/с (замерено четырьмя потоками). Последовательная закачка заняла бы 5.8 часа против
# примерно часа. Части качаются каждая своим curl — по одному соединению на файл.
#
# -C - : докачка с места обрыва. На 155 ГБ обрыв почти неизбежен, а начинать заново нельзя.
# -L   : HuggingFace отдаёт 302 на CDN.
# --retry: сеть за NAT и Wi-Fi, разовые сбои не должны ронять всю закачку.
#
# Квант выбран UD-Q4_K_XL сознательно: маршрутизируемые эксперты (96% модели) в оригинале лежат
# в MXFP4, и GGUF перепаковывает их бит-в-бит. То есть это НЕ огрубление, а родная точность —
# мерить качество 3-битной версией значило бы мерить порчу от кванта, а не саму модель.
set -u

REPO="unsloth/DeepSeek-V4-Flash-GGUF"
QUANT="UD-Q4_K_XL"
DEST="/d/models/deepseek-v4-flash"
mkdir -p "$DEST"

echo "цель: $DEST"
df -h /d | tail -1

pids=()
for i in 1 2 3 4 5; do
  n=$(printf "%05d" "$i")
  f="DeepSeek-V4-Flash-${QUANT}-${n}-of-00005.gguf"
  url="https://huggingface.co/${REPO}/resolve/main/${QUANT}/${f}"
  curl -L -C - --retry 10 --retry-delay 5 --retry-all-errors \
       -o "$DEST/$f" "$url" --silent --show-error &
  pids+=($!)
  echo "запущена часть $i/5"
done

fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail+1)); done

echo ""
echo "=== итог ==="
ls -la "$DEST"
total=$(du -sb "$DEST" | cut -f1)
echo "скачано: $((total/1024/1024/1024)) ГБ из 155 ГБ"
if [ "$fail" -gt 0 ]; then
  echo "ЧАСТЕЙ С ОШИБКОЙ: $fail — перезапусти скрипт, докачает с места обрыва"
  exit 1
fi
echo "ВСЕ ЧАСТИ СКАЧАНЫ"
