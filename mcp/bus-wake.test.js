// ТЕСТЫ ПРОБУЖДЕНИЯ. Проверяем ФОРМУ пакета побайтово и разделение «отправлено» / «разбужено».
//
// ПОЧЕМУ ФОРМА КРИТИЧНА: неверно собранный magic packet не вызывает НИКАКОЙ ошибки — он просто
// уходит в сеть и ничего не будит, а отправитель рапортует «отправлено». Обратной связи у WoL нет
// по устройству протокола, поэтому единственное место, где ошибку вообще можно поймать, — здесь.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { magicPacket, parseMac, wake, wakeNode, wakeRegistry, MAGIC_LEN } = require('./bus-wake');

const MAC = 'F4-C8-8A-30-15-0B';
const BYTES = [0xf4, 0xc8, 0x8a, 0x30, 0x15, 0x0b];

// ── ФОРМА ПАКЕТА ──
test('пакет ровно 102 байта: 6×0xFF + MAC×16', () => {
  const p = magicPacket(MAC);
  assert.equal(p.length, MAGIC_LEN);
  assert.equal(p.length, 102, 'структура WoL фиксирована стандартом');
});

test('первые шесть байт — 0xFF, и ни одним больше', () => {
  const p = magicPacket(MAC);
  for (let i = 0; i < 6; i++) assert.equal(p[i], 0xff, `байт ${i} обязан быть 0xFF`);
  assert.notEqual(p[6], 0xff, 'седьмой байт — уже первый байт MAC (иначе MAC собран неверно)');
});

test('MAC повторён РОВНО 16 раз, побайтово', () => {
  const p = magicPacket(MAC);
  for (let rep = 0; rep < 16; rep++) {
    for (let b = 0; b < 6; b++) {
      assert.equal(p[6 + rep * 6 + b], BYTES[b], `повтор ${rep}, байт ${b}`);
    }
  }
});

test('разделители MAC не важны — важны байты', () => {
  const a = magicPacket('F4-C8-8A-30-15-0B');
  const b = magicPacket('f4:c8:8a:30:15:0b');
  const c = magicPacket('f4c88a30150b');
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

// ── ОТКАЗЫ ГРОМКИЕ, А НЕ ТИХИЕ ──
test('кривой MAC — ОТКАЗ, а не пакет из мусора', () => {
  for (const bad of ['', null, undefined, 'не-мак', 'F4-C8-8A-30-15', 'F4-C8-8A-30-15-0B-99', 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ']) {
    assert.throws(() => magicPacket(bad), /12 hex/, `должно бросать на "${bad}"`);
  }
});

test('wake с кривым MAC возвращает sent:false с причиной, но НЕ бросает', () => {
  // Пробуждение вспомогательно: его сбой не имеет права ронять доставку, которая уже произошла.
  return wake('мусор').then((r) => {
    assert.equal(r.sent, false);
    assert.match(r.reason, /12 hex/);
  });
});

test('узла нет в реестре → честная причина, а не тихое «ок»', async () => {
  const r = await wakeNode('нет-такого-узла');
  assert.equal(r.sent, false);
  assert.match(r.reason, /нет MAC в реестре/);
});

// ── РЕЕСТР ──
test('реестр читается, служебные ключи с // отброшены', () => {
  const reg = wakeRegistry();
  assert.ok(reg['desktop-tt4i69c'], 'узел на месте');
  assert.equal(reg['desktop-tt4i69c'].mac, MAC);
  assert.ok(!Object.keys(reg).some((k) => k.startsWith('//')), 'комментарии не должны выглядеть узлами');
});

test('реестра нет → пусто, а не падение (законный случай)', () => {
  assert.deepEqual(wakeRegistry(path.join(os.tmpdir(), 'нет-такого-файла-' + Date.now() + '.json')), {});
});

test('битый JSON реестра → пусто, а не падение всей отправки', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-')), 'bad.json');
  fs.writeFileSync(f, '{ это не json');
  assert.deepEqual(wakeRegistry(f), {});
});

// ── ГЛАВНОЕ СМЫСЛОВОЕ РАЗДЕЛЕНИЕ ──
test('успех означает «пакет отправлен», а НЕ «машина разбужена»', async () => {
  // WoL не имеет обратной связи. Поле называется sent, и никакого woken быть не должно —
  // иначе отчёт станет утверждением о состоянии чужой машины, которого мы не знаем.
  const r = await wake(MAC, { broadcast: '127.0.0.1', port: 9, repeat: 1 });
  assert.equal(r.sent, true);
  assert.equal(r.bytes, 102);
  assert.equal(r.woken, undefined, 'мы не знаем и не имеем права утверждать, что узел проснулся');
});
