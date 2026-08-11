#!/usr/bin/env bash
# Параллельная закачка ОДНОГО большого файла кусками по диапазону байт.
#
# Зачем: HuggingFace режет ОДНО соединение до ~7.6 МБ/с, а суммарно канал держит ~77 МБ/с.
# Файл на 63 ГБ одним потоком качался бы 2.3 часа, восемью — около двадцати минут.
# Модель разбитая на части качается проще (по файлу на поток), но эта лежит одним куском.
#
# --fail ОБЯЗАТЕЛЕН. Без него curl считает успехом ЛЮБОЙ ответ сервера: на неверном имени файла
# HuggingFace вернул «Entry not found» с кодом 404, curl сохранил эти 15 байт в .gguf и вышел с
# нулём. Скрипт отрапортовал «ошибок: 0», и только размер файла выдал правду. Ровно тот же класс,
# что «команда отправлена» вместо «эффект наступил».
#
# Использование: fetch-parallel.sh <url> <файл-назначения> <размер-в-байтах> [потоков]
set -u
URL="$1"; OUT="$2"; SIZE="$3"; N="${4:-8}"
DIR="$(dirname "$OUT")"; mkdir -p "$DIR"
CHUNK=$(( (SIZE + N - 1) / N ))

echo "файл   : $(basename "$OUT")"
echo "размер : $((SIZE/1024/1024/1024)) ГБ, потоков $N по $((CHUNK/1024/1024)) МБ"

pids=()
for i in $(seq 0 $((N-1))); do
  start=$(( i * CHUNK ))
  end=$(( start + CHUNK - 1 )); [ "$end" -ge "$SIZE" ] && end=$(( SIZE - 1 ))
  part="$OUT.part$i"
  # -C - вместе с -r несовместимы, поэтому докачка куска — через проверку уже скачанного размера.
  have=0; [ -f "$part" ] && have=$(stat -c%s "$part")
  want=$(( end - start + 1 ))
  if [ "$have" -ge "$want" ]; then echo "  кусок $i уже целый"; continue; fi
  curl -L --fail --retry 10 --retry-delay 5 --retry-all-errors \
       -r "$(( start + have ))-$end" -o "$part" $( [ "$have" -gt 0 ] && echo "--append" ) \
       "$URL" --silent --show-error &
  pids+=($!)
done

fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail+1)); done
if [ "$fail" -gt 0 ]; then echo "ОШИБОК ЗАКАЧКИ: $fail — перезапусти, докачает"; exit 1; fi

echo "склеиваю куски…"
cat "$OUT".part* > "$OUT" && rm -f "$OUT".part*

# ПРОВЕРКА ПО ФАКТУ, а не по коду возврата: размер обязан совпасть до байта.
got=$(stat -c%s "$OUT")
if [ "$got" -ne "$SIZE" ]; then
  echo "РАЗМЕР НЕ СОШЁЛСЯ: получено $got, ожидалось $SIZE"
  exit 1
fi
head -c 4 "$OUT" | grep -q GGUF || { echo "ФАЙЛ НЕ GGUF — первые байты не те"; exit 1; }
echo "ГОТОВО: $((got/1024/1024/1024)) ГБ, магия GGUF на месте"
