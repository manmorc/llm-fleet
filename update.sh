#!/usr/bin/env bash
# Самообновление воркера (вызывается control-командой `update`, отвязанным процессом).
set -euo pipefail
cd "$(dirname "$0")"
echo "[update] $(date -Is) git pull"
git pull --ff-only
npm install --omit=dev
pm2 restart "${PM2_NAME:-llm-fleet}" --update-env
echo "[update] done"
