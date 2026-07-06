#!/usr/bin/env bash
# КАНОНИЧЕСКИЙ Stop-hook для Claude Code → Telegram-пинг по завершении обработки запроса.
# Единый формат для всех машин флота (mac/linux/win). Контент — авто-суммаризация транскрипта
# через haiku (агенту НИЧЕГО писать не надо; никакого /tmp-note). Секреты НЕ в репо — впиши локально.
#
# Формат сообщения:
#   ✅ Claude · <machine>        (✅ успех / ❌ ошибка-или-не-завершено; 🤖 если суммари не вышло)
#   🗂 <тема, ≤5 слов>
#   📝 <результат, ≤6 слов>
#
# Установка на машине:
#   1) cp tools/claude-stop-notify.sh ~/.claude/hooks/notify.sh   (или свой путь)
#   2) впиши TG_TOKEN/TG_CHAT (СВОИ, локально — не коммить), задай MACHINE (или env CLAUDE_MACHINE)
#   3) в ~/.claude/settings.json повесь на Stop:  {"type":"command","command":"bash $HOME/.claude/hooks/notify.sh stop"}
#   4) убери старый механизм (напр. правило «пиши /tmp/claude-tg-note» из CLAUDE.md) — он больше не нужен
[ -n "${CC_ROUTINE:-}" ] && exit 0   # не дублируем при scheduled-ранах

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

TG_TOKEN="<ВПИШИ_СВОЙ_BOT_TOKEN>"     # локально, не коммить
TG_CHAT="<ВПИШИ_СВОЙ_CHAT_ID>"        # локально, не коммить
MACHINE="${CLAUDE_MACHINE:-$(hostname -s 2>/dev/null || echo host)}"   # метка машины: mac|linux|win
event="${1:-stop}"

case "$event" in
  stop)
    stdin_json="$(cat)"
    transcript="$(echo "$stdin_json" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin).get('transcript_path',''))
except: pass
" 2>/dev/null)"

    summary=""
    if [ -n "$transcript" ] && [ -f "$transcript" ]; then
      excerpt="$(python3 -c "
import json, sys
msgs=[]
for line in open('$transcript'):
    try:
        m=json.loads(line); role=m.get('type','')
        if role in ('user','assistant'):
            c=m.get('message',{}).get('content','')
            if isinstance(c,list):
                for x in c:
                    if isinstance(x,dict) and x.get('type')=='text':
                        msgs.append(role.upper()+': '+x['text'][:200]); break
            elif isinstance(c,str) and c.strip():
                msgs.append(role.upper()+': '+c.strip()[:200])
    except: pass
for m in msgs[-20:]: print(m)
" 2>/dev/null)"

      if [ -n "$excerpt" ]; then
        summary="$(CC_ROUTINE=1 claude -p \
          "Ты анализируешь лог диалога с ИИ-ассистентом. Ответь РОВНО ДВУМЯ строками — не копируй слова из диалога, сформулируй сам.
Строка 1: абстрактная ТЕМА (категория работы, напр.: «Настройка Telegram-уведомлений», «Рефакторинг хука»). До 5 слов.
Строка 2: ДОЛЖНА НАЧИНАТЬСЯ с ✅ (задача выполнена) или ❌ (ошибка/не завершена). Потом РЕЗУЛЬТАТ — что сделано. До 6 слов.
Без кавычек, без нумерации, без пояснений.
---
$excerpt" \
          --model claude-haiku-4-5-20251001 \
          --dangerously-skip-permissions \
          2>/dev/null)"
      fi
    fi

    if [ -n "$summary" ]; then
      topic="$(echo "$summary" | sed -n '1p' | cut -c1-80)"
      result="$(echo "$summary" | sed -n '2p' | cut -c1-80)"
      if echo "$result" | grep -q "^✅"; then header="✅"; else header="❌"; fi
      result_clean="$(echo "$result" | sed 's/^[✅❌] *//')"
      text="${header} Claude · ${MACHINE}"
      [ -n "$topic" ] && text="${text}"$'\n'"🗂 ${topic}"
      [ -n "$result_clean" ] && text="${text}"$'\n'"📝 ${result_clean}"
    else
      text="🤖 Claude · ${MACHINE}"
    fi
    ;;
  *)
    text="🤖 Claude · ${MACHINE}: $event"
    ;;
esac

curl -s -m 8 \
  -d "chat_id=$TG_CHAT" \
  --data-urlencode "text=$text" \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage" >/dev/null 2>&1 || true
