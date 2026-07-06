# fleet-rag — кросс-машинный личный/рабочий RAG-архив

Семантический поиск по своему архиву (сессии, доки, заметки, трейдинг). **Store живёт на одной
всегда-онлайн машине** (home-server, у нас `linux-prestige`); mac/win спрашивают её по Tailscale.
Эмбеддинги — **локально** (ollama `nomic-embed-text`), приватно: наружу ничего не уходит.

```
mac/win Claude ──(MCP archive_search/ingest)──▶ HTTP RAG-сервис (linux) ──▶ sqlite-vec + ollama embed
                       по Tailscale, Bearer token                          (данные только на linux)
```

## Компоненты
- `lib.js` — ядро: sqlite-vec store, ollama-эмбеддинги, чанкер, **фильтр приватного** (секреты/токены/ключи/сид-фразы НЕ индексируются).
- `server.js` — HTTP-сервис (на linux): `GET /health`, `POST /search`, `POST /ingest`. Авторизация `Bearer RAG_TOKEN`.
- `mcp.js` — тонкий MCP-клиент (на каждой машине): тулзы `archive_search`, `archive_ingest` → HTTP.
- `ingest-files.js` — залить папку md/txt в архив (с любой машины).
- `selftest.js` — проверка пайплайна без ollama (`RAG_FAKE_EMBED=1`).

## Деплой сервера (на linux home-server)
```bash
cd llm-fleet && git pull origin develop
cd rag && npm install                      # better-sqlite3 собирается (нужны build-tools)
ollama pull nomic-embed-text               # локальная модель эмбеддингов (768d)
TOK=$(openssl rand -hex 24)                # токен доступа; СОХРАНИ, вписывать локально на клиентах
TS=$(tailscale ip -4 | head -1)            # bind ТОЛЬКО на tailscale-IP (не 0.0.0.0!)
RAG_TOKEN="$TOK" RAG_BIND="$TS" RAG_PORT=8077 node server.js   # под pm2/tmux/systemd (always-on)
```
Хардинг: **bind по умолчанию `127.0.0.1`**; для кросс-машинного задай `RAG_BIND=<tailscale-IP>` — так роуминг-ноут
**не торчит на LAN/публичном WiFi** (в отличие от `0.0.0.0`). **`RAG_TOKEN` обязателен — fail-closed** (без него сервис
не стартует). Токен — единственная защита сетевого доступа.

## Подключение MCP (на каждой машине — mac/win/linux)
Токен **НЕ передаём по шине** — владелец вписывает локально (Keychain/env). MagicDNS-имя linux вместо IP.
```bash
claude mcp add -s user rag-archive \
  --env RAG_URL='http://artyom-prestige-14evo-b13m.tail241f5d.ts.net:8077' \
  --env RAG_TOKEN='<токен-с-сервера>' \
  -- node /ABS/PATH/llm-fleet/rag/mcp.js
# перезапустить Claude → тулзы archive_search / archive_ingest
```

## Индексация (v0)
```bash
export RAG_URL='http://artyom-prestige-14evo-b13m.tail241f5d.ts.net:8077' RAG_TOKEN='<токен>'
node ingest-files.js work     ~/WebstormProjects/control_plane --ext md --source control_plane
node ingest-files.js personal ~/notes                          --ext md,txt
# сессии Claude / трейдинг — отдельными ингестерами (следующий шаг)
```

## Скоупы
`work` (GL/доки) · `personal` (заметки/ресёрчи) · `agent` (сессии/итоги агентов) · `trading` (только на linux, не покидает сервер). Поиск можно фильтровать: `archive_search {query, scope}`.

## Приватность (важно)
Фильтр в `lib.js` пропускает чанки с секретами (telegram-токен, eth/btc privkey, `sk-*`/`ghp_`/…, redis-url с паролем, `pass=/secret=/seed=`, возможные BIP39). Режим по умолчанию — **skip** (не индексировать); `RAG_SECRET_MODE=redact` — маскировать. Всё равно: **не суём заведомо секретное в архив**.

> Реализация lean-версии control-center «vector archive» (P3), вынесенная в флот для co-location с linux (Node+ollama).
