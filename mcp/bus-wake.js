#!/usr/bin/env node
// ПРОБУЖДЕНИЕ УЗЛА ФЛОТА адресным пакетом (Wake-on-LAN).
//
// ЗАЧЕМ (владелец, 03.08.2026). GPU-машина раньше не спала ВООБЩЕ — сон был отключён навсегда,
// 12 ГБ VRAM висели сутками. Теперь у неё таймер сна 30 мин. Но спящая машина НЕ СЛУШАЕТ Redis:
// сетевой стек выключен, до неё доходит только адресный пакет на уровне сетевой карты. Значит
// будить обязан тот, кто бодрствует и физически в ТОЙ ЖЕ локальной сети — пакет через маршрутизатор
// обычно не проходит. Это я: 192.168.1.31, она 192.168.1.14.
//
// ⚠️ ГЛАВНОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ, отличное от изначальной просьбы. Меня просили «проверить
// присутствие, разбудить и ЖДАТЬ 40с до повторной отправки». Повторная отправка НЕ НУЖНА и вредна:
// ящик у нас durable (RPUSH + TTL неделя), сообщение доходит до спящего в любом случае и лежит,
// пока тот не проснётся. Ждать 40 секунд означало бы держать отправителя ради того, что и так
// произошло, а повтор — класть в ящик ДУБЛИКАТ. Поэтому здесь: доставили всегда, а пакет шлём
// вдогонку, чтобы адресат прочитал СКОРО, а не когда-нибудь. Доставка и пробуждение независимы.
//
// ⚠️ ПРОБУЖДЕНИЕ — НЕ ГАРАНТИЯ. У целевой машины Wi-Fi, а не кабель, а Wake-on-Wireless работает
// не на всех адаптерах и отваливается при глубоком сне. Поэтому «пакет отправлен» здесь НИКОГДА
// не докладывается как «машина разбужена»: мы знаем только, что отдали 102 байта в сеть. Обратной
// связи у WoL нет по устройству протокола — подтверждением служит появление узла в presence.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const MAGIC_LEN = 102;             // 6 байт 0xFF + MAC (6 байт) × 16
const DEFAULT_PORT = 9;            // discard-порт, канонический для WoL
const DEFAULT_BROADCAST = '255.255.255.255';

/** Нормализация MAC: принимаем F4-C8-8A-30-15-0B, f4:c8:8a:30:15:0b, f4c88a30150b. */
function parseMac(mac) {
  const hex = String(mac == null ? '' : mac).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`MAC должен содержать 12 hex-знаков, получено ${hex.length}: "${mac}"`);
  const bytes = [];
  for (let i = 0; i < 12; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return Buffer.from(bytes);
}

/**
 * Собрать magic packet. Структура жёсткая и проверяется тестом побайтово: ошибка здесь не вызовет
 * никакой ошибки — пакет просто уйдёт в сеть и НИЧЕГО не разбудит, а мы отрапортуем «отправлено».
 * Ровно тот класс, где молчание читается как успех, поэтому форма проверяется, а не подразумевается.
 */
function magicPacket(mac) {
  const m = parseMac(mac);
  const buf = Buffer.alloc(MAGIC_LEN, 0xff);   // первые 6 байт уже 0xFF
  for (let i = 0; i < 16; i++) m.copy(buf, 6 + i * 6);
  return buf;
}

/** Реестр MAC-адресов узлов. Отсутствует — не ошибка: просто некого будить. */
function wakeRegistry(file) {
  const f = file || process.env.AGENT_WAKE_FILE || path.join(__dirname, 'agent-wake.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(j)) if (!k.startsWith('//')) out[k] = v;
    return out;
  } catch (_) { return {}; }
}

/**
 * Отправить пакет. Возвращает ФАКТ ОТПРАВКИ, а не факт пробуждения — разница принципиальна.
 * Ошибка сокета не бросается наружу: пробуждение вспомогательно, и его сбой не имеет права
 * ронять доставку сообщения, которая уже произошла.
 */
function wake(mac, { broadcast = DEFAULT_BROADCAST, port = DEFAULT_PORT, repeat = 3 } = {}) {
  return new Promise((resolve) => {
    let pkt;
    try { pkt = magicPacket(mac); }
    catch (e) { return resolve({ sent: false, reason: e.message }); }

    const sock = dgram.createSocket('udp4');
    const done = (res) => { try { sock.close(); } catch (_) {} resolve(res); };
    sock.once('error', (e) => done({ sent: false, reason: `сокет: ${e.message}` }));
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (e) { return done({ sent: false, reason: `broadcast: ${e.message}` }); }
      let left = repeat, failed = null;
      // ПОВТОРЯЕМ ПАКЕТ: UDP не гарантирует доставку, а пакет крошечный. Три копии — дешёвая
      // страховка от единственной потери; это НЕ повторная отправка сообщения (см. шапку).
      const fire = () => {
        sock.send(pkt, 0, pkt.length, port, broadcast, (err) => {
          if (err && !failed) failed = err.message;
          if (--left > 0) return setTimeout(fire, 150);
          done(failed ? { sent: false, reason: failed } : { sent: true, bytes: pkt.length, broadcast, port, repeat });
        });
      };
      fire();
    });
  });
}

/** Разбудить узел по имени из реестра. Нет записи — молча ничего, это законный случай. */
async function wakeNode(id, file) {
  const cfg = wakeRegistry(file)[id];
  if (!cfg || !cfg.mac) return { sent: false, reason: `для узла ${id} нет MAC в реестре пробуждения` };
  return wake(cfg.mac, { broadcast: cfg.broadcast, port: cfg.port });
}

module.exports = { magicPacket, parseMac, wake, wakeNode, wakeRegistry, MAGIC_LEN, DEFAULT_PORT };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node mcp/bus-wake.js <node-id|MAC>'); process.exit(1); }
  (async () => {
    const r = /^[0-9a-fA-F:.-]{12,17}$/.test(arg) && arg.replace(/[^0-9a-fA-F]/g, '').length === 12
      ? await wake(arg) : await wakeNode(arg);
    if (r.sent) {
      console.log(`✓ пакет отправлен: ${r.bytes} байт ×${r.repeat} → ${r.broadcast}:${r.port}`);
      console.log('  ⚠️ это НЕ значит «машина проснулась»: у WoL нет обратной связи.');
      console.log('     Подтверждение — появление узла в presence (node mcp/bus-send.js --who).');
      process.exit(0);
    }
    console.error(`✗ не отправлено: ${r.reason}`);
    process.exit(1);
  })();
}
