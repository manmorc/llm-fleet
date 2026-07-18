#!/usr/bin/env node
// Idle-watchdog: гасит gemma-26b (llama-server), когда она простаивает, освобождая VRAM.
// Решение владельца 2026-07-18: модель не должна крутиться бесцельно и жрать ресурсы — использование
// редкое (bus-запросы / чат-приложение / трейдинг раз в час). Загрузка по требованию уже есть
// (server.ensure), тут — вторая половина: выгрузка на простое.
//
// ВАЖНО (§9): это data-cron ВНУТРИ сервиса — Claude НЕ зовёт, недельные лимиты не тратит. Разрешён.
//
// Логика: server.ensure() штампует ~/.agent-bus/llama.active перед каждым запросом. Раз в POLL_MS
// смотрим: (1) прошло ли > IDLE_MS с последней активности И (2) не занят ли слот прямо сейчас
// (/slots is_processing — чтобы не убить генерацию на лету). Оба да + сервер жив → stop().
// Следующий запрос поднимет модель сам (~12 с холодный старт; владелец/флот это терпят).
const server = require('./server');

const IDLE_MS = parseInt(process.env.LLAMA_IDLE_MS || String(10 * 60 * 1000), 10); // дефолт 10 мин
const POLL_MS = parseInt(process.env.LLAMA_WATCHDOG_POLL_MS || '60000', 10);        // раз в минуту
const log = (m) => console.log(`${new Date().toISOString()} [llama-watchdog] ${m}`);

log(`старт · idle-таймаут ${Math.round(IDLE_MS / 60000)} мин · опрос каждые ${Math.round(POLL_MS / 1000)} с`);

let downSince = null; // чтобы не спамить логом, когда модель уже выгружена

async function tick() {
  try {
    const up = await server.probe(4000);
    if (!up) { if (!downSince) { downSince = Date.now(); log('модель выгружена (VRAM свободна), жду запросов'); } return; }
    downSince = null;
    if (Date.now() - server.lastActivity() < IDLE_MS) return;   // ещё недавно был запрос
    if (server.loadingInProgress()) return;                      // потребитель СЕЙЧАС грузит модель — не убить спавн
    if (await server.slotsBusy()) return;                        // прямо сейчас генерирует — не трогаем
    // Двойная проверка активности ПОСЛЕ slotsBusy: ensure() штампует активность ПЕРЕД запросом, так что
    // запрос, влетевший за время проверки слотов, уже обновил файл → не гасим (закрываем гонку stop-vs-request).
    const idleFor = Date.now() - server.lastActivity();
    if (idleFor < IDLE_MS) return;
    log(`простой ${Math.round(idleFor / 60000)} мин ≥ ${Math.round(IDLE_MS / 60000)} — гашу llama-server, освобождаю VRAM`);
    server.stop();
  } catch (e) { log(`tick err: ${e.message}`); }
}

const timer = setInterval(tick, POLL_MS);
tick();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearInterval(timer); process.exit(0); });
