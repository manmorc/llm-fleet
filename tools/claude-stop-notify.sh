#!/usr/bin/env bash
# КАНОНИЧЕСКИЙ Stop-hook для Claude Code → Telegram completion-пинг. Единый формат флота (mac/linux/win).
# Контент — авто-суммаризация транскрипта через haiku (агенту ничего писать не надо). Секреты НЕ в репо.
#
# Формат сообщения (как у isolated-laptop):
#   🤖 АГЕНТ · Claude · <machine> · 🟢 готово     (или · 🔴 ошибка)
#   🗂 <тема, ≤6 слов>
#   📝 <результат, ≤6 слов>
#   (completion-пинг)
#
# Установка: cp сюда → ~/.claude/hooks/notify.sh; впиши СВОИ TG_TOKEN/TG_CHAT локально (не коммить);
# задай MACHINE (или env CLAUDE_MACHINE); повесь на Stop в ~/.claude/settings.json:
#   {"type":"command","command":"bash $HOME/.claude/hooks/notify.sh stop"}
# Каждая машина держит СВОЙ хук/креды локально — по шине секреты не передаём (см. README §Безопасность).
[ -n "${CC_ROUTINE:-}" ] && exit 0

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

TG_TOKEN="<ВПИШИ_СВОЙ_BOT_TOKEN>"     # локально, не коммить
TG_CHAT="<ВПИШИ_СВОЙ_CHAT_ID>"        # локально, не коммить
MACHINE="${CLAUDE_MACHINE:-$(hostname -s 2>/dev/null || echo host)}"
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
          "Ты анализируешь лог диалога с ИИ-ассистентом. Ответь РОВНО ДВУМЯ строками — сформулируй САМ, не копируй фразы из лога.
Строка 1 — ТЕМА (категория работы, напр.: «Настройка Telegram-уведомлений», «Рефакторинг хука»). До 6 слов.
Строка 2 — начни с ✅ (задача выполнена) или ❌ (ошибка/не завершена), затем РЕЗУЛЬТАТ (что сделано). До 6 слов.
ЗАПРЕЩЕНО: эмодзи в тексте (кроме ✅/❌ в начале строки 2), символы 🗂/📝, строки вида «Claude · …», кавычки, нумерация, пояснения.
---
$excerpt" \
          --model claude-haiku-4-5-20251001 \
          --dangerously-skip-permissions \
          2>/dev/null)"
      fi
    fi

    if [ -n "$summary" ]; then
      parsed="$(printf '%s' "$summary" | python3 -c "
import sys, re
raw=sys.stdin.read()
def lead(l): return re.sub(r'^[\s‍🗂📝✅❌🟢🔴🤖📌•*_-]+','',l).strip()
lines=[lead(l) for l in raw.splitlines()]
cand=[l for l in lines if l and not re.match(r'(?i)^claude\b',l) and not re.match(r'(?i)^(строка|line)\s*\d',l)]
topic=' '.join((cand[0] if cand else '').split()[:6])
result=' '.join((cand[1] if len(cand)>1 else '').split()[:6])
status='❌' if '❌' in raw else '✅'
print(status); print(topic); print(result)
" 2>/dev/null)"
      st="$(printf '%s' "$parsed" | sed -n '1p')"
      topic="$(printf '%s' "$parsed" | sed -n '2p')"
      result_clean="$(printf '%s' "$parsed" | sed -n '3p')"
      if [ "$st" = "❌" ]; then status="🔴 ошибка"; else status="🟢 готово"; fi
      text="🤖 АГЕНТ · Claude · ${MACHINE} · ${status}"
      [ -n "$topic" ] && text="${text}"$'\n'"🗂 ${topic}"
      [ -n "$result_clean" ] && text="${text}"$'\n'"📝 ${result_clean}"
      text="${text}"$'\n'"(completion-пинг)"
    else
      text="🤖 АГЕНТ · Claude · ${MACHINE} · 🟢 готово"$'\n'"(completion-пинг)"
    fi
    ;;
  *)
    text="🤖 АГЕНТ · Claude · ${MACHINE}: $event"
    ;;
esac

curl -s -m 8 \
  -d "chat_id=$TG_CHAT" \
  --data-urlencode "text=$text" \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage" >/dev/null 2>&1 || true
