# agent — автономный локальный агент (desktop-local)

Tool-use агент поверх локальной GPU-модели (ollama). Цель: вырастить локальную модель из «сырого
inference-эндпоинта» в полноценного (пусть менее продуктивного) участника флота, выполняющего задачи
самостоятельно — **под надзором**, пока не подтверждена его безопасность и адекватность.

## Модули
- `tools.js` — реестр тулзов. **Безопасные** (read-only, заперты в `AGENT_ROOT`): `list_dir`, `read_file`, `http_get` (только localhost/tailnet). **Рисковые** (`write_file`, `shell`) — только при `AGENT_ALLOW_RISKY=1` И через надзор.
- `supervisor.js` — гейт рисковых действий: (1) статические hard-deny паттерны (rm -rf, format, shutdown, реестр, schtasks, `|sh`, …) — безусловно; (2) аппрув ревьюера. Режимы `AGENT_SUPERVISOR`: `deny` (по умолч.) · `allow` · `file` (заявка → decision-файл) · `bus` (заявка мне, Claude/`desktop-tt4i69c`, через шину → одобряю/отклоняю). Аудит всего → `~/.agent-bus/desktop-local.audit.log`.
- `loop.js` — ReAct-петля: ollama `/api/chat` c tools → выполняем tool_calls → результат в диалог → итерируем (maxSteps) → финальный ответ. `trace` для аудита.
- `run.js` — локальный запуск для теста (без шины).
- `approve.js` — решение надзора в bus-режиме: `REDIS_URL=… node agent/approve.js <reqId> allow|deny`.

## Запуск (локальный тест)
```bash
AGENT_ROOT="$HOME/llm-fleet" node agent/run.js "Сколько .md-файлов в корне? Используй инструменты."
# рисковые тулзы под надзором:
AGENT_ROOT=… AGENT_ALLOW_RISKY=1 AGENT_SUPERVISOR=bus REDIS_URL=… node agent/run.js "<задача>"
```

## Модель надзора (почему)
Локальная 8B-модель пока НЕ доверенный исполнитель. Каждое рисковое действие проходит гейт **до** выполнения,
результат логируется **после** — надзор (Claude/`desktop-tt4i69c`, при желании владелец над ним) проверяет
и действия, и результаты. Аудит-лог = детектор проблем, ничего молча (принцип честности).

## Статус
v0 — петля и надзор проверены end-to-end на `gemma4:latest` (корректные tool_calls; allow выполняет,
deny/hard-deny блокируют, агент адаптируется). **НЕ подключён к шине автономно** — вывод `desktop-local`
отдельной bus-идентичностью + постоянный приём задач ждут: регистрации pubkey (trust-anchor владельца)
и обкатки надзора. См. `../PRINCIPLES.md`, `../ARCHITECTURE.md`.
