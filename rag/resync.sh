#!/usr/bin/env bash
# Ре-синк снапшота в RAG: снести source → залить заново (чтобы удалённое/изменённое не тухло).
#   resync.sh <scope> <dir> <source> [--ext md,txt]
# ENV: RAG_URL (или дефолт), RAG_TOKEN (или Keychain rag-token / ~/.rag/rag.env)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
scope="$1"; dir="$2"; source="$3"; ext="${5:-md,txt}"
[ -z "$scope" ] || [ -z "$dir" ] || [ -z "$source" ] && { echo "usage: resync.sh <scope> <dir> <source> [--ext md,txt]"; exit 1; }

export RAG_URL="${RAG_URL:-http://artyom-prestige-14evo-b13m.tail241f5d.ts.net:8077}"
if [ -z "${RAG_TOKEN:-}" ]; then
  RAG_TOKEN="$(security find-generic-password -s rag-token -w 2>/dev/null)"
  [ -z "$RAG_TOKEN" ] && [ -f "$HOME/.rag/rag.env" ] && RAG_TOKEN="$(grep -m1 '^RAG_TOKEN=' "$HOME/.rag/rag.env" | cut -d= -f2-)"
  export RAG_TOKEN
fi
[ -z "$RAG_TOKEN" ] && { echo "нет RAG_TOKEN"; exit 1; }

echo "[$(date '+%F %T')] resync source=$source scope=$scope dir=$dir"
curl -s -m 15 -X POST "$RAG_URL/delete" -H "authorization: Bearer $RAG_TOKEN" -H 'content-type: application/json' -d "{\"source\":\"$source\"}"; echo
node "$(cd "$(dirname "$0")" && pwd)/ingest-files.js" "$scope" "$dir" --ext "$ext" --source "$source"
