#!/usr/bin/env bash
# Официальный чекпоинт DeepSeek-V4-Flash-0731 для Colibri: 48 шардов safetensors, ~161.6 ГБ.
#
# ЗАЧЕМ ОТДЕЛЬНО ОТ GGUF. Colibri не читает GGUF — у него свой движок на C под каждое семейство,
# со своими правилами раскладки тензоров. Для DeepSeek V4 Flash конвертация НЕ нужна: он стримит
# официальный чекпоинт как есть, эксперты остаются в родном fp4. Так что качаем оригинал.
#
# ПУЛ НА 10 ПОТОКОВ. HuggingFace режет одно соединение до ~7.6 МБ/с при канале ~77 МБ/с —
# последовательно эти 162 ГБ качались бы шесть часов вместо сорока минут.
#
# --fail ОБЯЗАТЕЛЕН: без него curl считает успехом ответ «Entry not found» и кладёт 15 байт
# в файл шарда, а скрипт рапортует «ошибок 0». Уже поймано на этом сегодня.
# Плюс сверка размера каждой части с объявленным на стороне HF — успех по факту, а не по коду.
set -u

REPO="deepseek-ai/DeepSeek-V4-Flash-0731"
DEST="/d/models/DeepSeek-V4-Flash"
JOBS="${JOBS:-10}"
mkdir -p "$DEST"

base="https://huggingface.co/${REPO}/resolve/main"

get() {                       # get <имя файла>
  local f="$1" out="$DEST/$1"
  # Ожидаемый размер спрашиваем у сервера — сравнивать надо с истиной, а не с догадкой.
  local want
  want=$(curl -sIL --fail "$base/$f" | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
  if [ -f "$out" ] && [ -n "$want" ] && [ "$(stat -c%s "$out")" = "$want" ]; then
    echo "  = $f (уже целый)"; return 0
  fi
  curl -L --fail -C - --retry 10 --retry-delay 5 --retry-all-errors -o "$out" "$base/$f" --silent --show-error || {
    echo "  ! $f — ОШИБКА ЗАКАЧКИ"; return 1; }
  local got; got=$(stat -c%s "$out")
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "  ! $f — РАЗМЕР НЕ СОШЁЛСЯ: $got вместо $want"; return 1; fi
  echo "  + $f ($((got/1024/1024)) МБ)"
}

echo "=== служебные файлы ==="
for f in config.json generation_config.json tokenizer.json tokenizer_config.json model.safetensors.index.json; do
  get "$f" || exit 1
done

echo "=== 48 шардов, по $JOBS одновременно ==="
fail=0
running=0
for i in $(seq -w 1 48); do
  get "model-000${i}-of-00048.safetensors" &
  running=$((running+1))
  if [ "$running" -ge "$JOBS" ]; then wait -n || fail=$((fail+1)); running=$((running-1)); fi
done
while [ "$running" -gt 0 ]; do wait -n || fail=$((fail+1)); running=$((running-1)); done

echo ""
total=$(du -sb "$DEST" | cut -f1)
echo "итого на диске: $((total/1024/1024/1024)) ГБ (ожидалось ~161)"
echo "шардов на месте: $(ls "$DEST"/model-*.safetensors 2>/dev/null | wc -l) из 48"
if [ "$fail" -gt 0 ]; then echo "ЧАСТЕЙ С ОШИБКОЙ: $fail — перезапусти, докачает"; exit 1; fi
echo "ЧЕКПОИНТ СКАЧАН ЦЕЛИКОМ"
