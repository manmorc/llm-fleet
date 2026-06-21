# llm-fleet

Распределённый пул LLM-воркеров: очередь задач (**BullMQ/Redis**) + локальные модели (**Ollama**) на нескольких машинах, с **удалённым управлением** и **self-update** — без захода на каждую машину.

Балансировка — самой очередью (воркеры тянут задачи, когда свободны → ровно и автоматически). Добавил машину → она сама начинает разгребать. Тип распараллеливания — **data-parallel** (много одинаковых воркеров на независимых задачах), не дробление одной модели.

```
backend кладёт задачи ─▶ Redis + BullMQ (очередь) ─▶ N воркеров (Ollama) на GPU-машинах
                              └ fleet:control (pub/sub) ──┘  ◀─ heartbeat в Redis
```

## Что нужно один раз
- **Redis** на всегда-онлайн машине (или в облаке). Доступен остальным по сети (удобно через Tailscale).
- На каждой воркер-машине: Node 18+, Ollama (ставится автоматически).

## Присоединить машину из VPN — ОДНОЙ ссылкой (рекомендуется)
Если машина уже в Tailscale/VPN — на всегда-онлайн хосте раздаём bootstrap (с встроенным Redis-URL, секрет берётся из env хоста, НЕ из репо):
```bash
# на хосте (там же, где Redis):
JOIN_REDIS_URL='redis://:PASS@<tailscale-ip>:6379' JOIN_HOST=<tailscale-ip> node tools/join-server.js
```
Тогда на ЛЮБОЙ машине в сети — одна команда, без ввода env:
```bash
# mac / linux:
curl -fsSL http://<tailscale-ip>:8088 | bash
# windows (PowerShell as admin):
irm http://<tailscale-ip>:8088/ps1 | iex
```
Привязка к Tailscale-IP → раздаётся только пирам сети, наружу не торчит.

## Установка воркера — вручную (с явным Redis-URL)
```bash
# mac / linux — MODEL подберётся по железу автоматически:
curl -fsSL https://raw.githubusercontent.com/manmorc/llm-fleet/main/install.sh \
  | REDIS_URL=redis://:PASS@<tailscale-ip>:6379 bash
# windows:
$env:REDIS_URL='redis://:PASS@<tailscale-ip>:6379'; irm https://raw.githubusercontent.com/manmorc/llm-fleet/main/install.ps1 | iex
```
Скрипт: поставит Ollama/pm2 → склонирует репо → `npm i` → запишет `.env` → `ollama pull` модели → запустит воркер под **pm2** (живёт после ребута).

**Авто-подбор модели по железу** (если `MODEL` не задан явно): бюджет памяти = NVIDIA dGPU → VRAM · Apple Silicon → RAM×0.7 · CPU-only → RAM×0.6 (потолок light/embed). Лестница (Q4 ≈ params×0.65 GB): ≥22GB→`qwen3:32b` · ≥11GB→`qwen3:14b` · ≥6GB→`qwen3:8b` · <6GB→`qwen3:4b`; плюс `nomic-embed-text` на всех. Лестница редактируется массивом в начале `install.sh` / `install.ps1`. Явный `MODEL=...` всё так же переопределяет авто-подбор.

## Управление флотом (с любой машины, видящей Redis)
```bash
node bin/fleet.js status                                  # кто онлайн, версия/модель/занятость
node bin/fleet.js submit parseSignal '{"text":"BTC long entry 65000 sl 63000 tp 70000"}'
node bin/fleet.js broadcast update                        # все: git pull + npm i + restart
node bin/fleet.js broadcast set-model '{"model":"qwen2.5:14b"}'  # все переходят на модель (ollama pull)
node bin/fleet.js broadcast reload                        # горячая перечитка скилов (без рестарта)
node bin/fleet.js broadcast drain                         # доделать текущее, новые не брать
node bin/fleet.js broadcast rollback '{"ref":"<tag|hash>"}'      # откат на версию
```

## Generic: принимает ЛЮБЫЕ задачи из ЛЮБЫХ проектов
Флот не привязан к какому-либо приложению. Воркер просто исполняет скил по `job.name`. Два способа использовать из стороннего проекта **без доработок флота**:

1. **Универсальный скил `chat`** — произвольный промпт, ничего ставить не надо:
   ```js
   const { Queue, QueueEvents } = require('bullmq'); const IORedis = require('ioredis');
   const conn = new IORedis(process.env.REDIS_URL);
   const q = new Queue('llm-tasks', { connection: conn });
   const ev = new QueueEvents('llm-tasks', { connection: conn });
   const job = await q.add('chat', { prompt: 'Суммаризируй: ...', model: 'qwen2.5:7b', format: 'json' });
   const { content } = await job.waitUntilFinished(ev);   // ← результат
   ```
2. **Свой скил** (если задача частая/со своей логикой) — добавить файл в `src/skills/` и `broadcast update`. Тогда проект кладёт `q.add('<имя-скила>', payload)`.

Любое число проектов кладут задачи в **одну общую очередь** — воркеры разгребают их вперемешку, балансировка автоматическая. Изоляция/приоритеты при желании — отдельными очередями (воркер слушает `QUEUE`), но для «принимай что приходит» хватает общей.

## Скилы
Каждый скил — файл в `src/skills/*.js`: `{ name, async run(payload, ctx) }`, где `ctx.chat(messages, opts)` — унифицированный доступ к модели (скил не зависит от транспорта). Добавить умение всему флоту = файл + `broadcast update` (или `reload`). Из коробки:
- **chat** — универсальный: произвольный промпт → ответ (любой проект, любая задача).
- **echo** — без LLM, для проверки механики.
- **parseSignal** — пример доменного скила: сообщение крипто-канала → структурный сигнал (JSON).

Отладка скила локально (без Redis/очереди):
```bash
node src/run-skill.js echo '{"text":"hi"}'
node src/run-skill.js parseSignal '{"text":"..."}'      # нужен запущенный Ollama
```

## Удалённые апдейты — два уровня
- **Скилы/промпты** — горячо (`reload`), без рестарта.
- **Код воркера** — `update` (git pull + npm i + pm2 restart, отвязанным процессом → переживает рестарт).
- **Безопасность:** control-канал держи только в приватной сети (Tailscale) + Redis с паролем. Плохой коммит может положить флот — катай код через **одну canary-машину** (адресная команда `target`), проверяй `status`, потом `broadcast`. Откат — `rollback`.

## Интеграция (следующий шаг)
Любой бэкенд кладёт задачу в ту же очередь:
```js
const { Queue } = require('bullmq'); const IORedis = require('ioredis');
const q = new Queue('llm-tasks', { connection: new IORedis(process.env.REDIS_URL) });
const job = await q.add('parseSignal', { text }); // результат: job.waitUntilFinished(queueEvents)
```
