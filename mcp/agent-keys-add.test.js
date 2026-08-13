// Регресс-тесты выдачи прав на шине (mcp/agent-keys-add.js). Уровень A — без Redis.
//
// Реестр публичных ключей — единственный trust-anchor шины: правило владельца «подписанное сообщение =
// полноценная авторизация» означает, что строка в этом файле выдаёт мандат командовать флотом.
// Отсюда три свойства, которые обязаны держаться кодом, а не аккуратностью руки:
//   — ничего существующего не удаляется и не переписывается (занятый id → отказ, а не «обновление»);
//   — в реестр не попадает то, что ключом не является (иначе провал вылезет у ПОЛУЧАТЕЛЯ как «BAD»);
//   — повтор той же команды безвреден (агент может выполнить её дважды).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, runScript } = require('./test/fixtures');

const SCRIPT = path.join(__dirname, 'agent-keys-add.js');
const pubOf = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function registry(entries) {
  const dir = tmpDir('keys-add');
  const file = path.join(dir, 'agent-keys.json');
  fs.writeFileSync(file, JSON.stringify({ '//': 'реестр', ...entries }, null, 2));
  return file;
}
const add = (file, id, pub) => runScript(SCRIPT, [id, pub], { env: { AGENT_KEYS_FILE: file } });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('новый агент дописывается, существующие записи не тронуты', async () => {
  const old = pubOf(), fresh = pubOf();
  const file = registry({ 'mac-artyom': old });
  const r = await add(file, 'desktop-new', fresh);
  assert.equal(r.code, 0, r.err);
  const reg = read(file);
  assert.equal(reg['desktop-new'], fresh);
  assert.equal(reg['mac-artyom'], old, 'чужая запись обязана уцелеть');
  assert.equal(reg['//'], 'реестр', 'комментарий-заголовок реестра не теряется');
});

test('занятый id с ДРУГИМ ключом → отказ, файл не изменён (подмена агента невозможна)', async () => {
  const old = pubOf();
  const file = registry({ 'mac-artyom': old });
  const before = fs.readFileSync(file, 'utf8');
  const r = await add(file, 'mac-artyom', pubOf());
  assert.equal(r.code, 2);
  assert.match(r.err, /ЗАНЯТ другим ключом/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'файл обязан остаться байт в байт');
});

test('повтор той же пары id+ключ безвреден и не дублирует', async () => {
  const pub = pubOf();
  const file = registry({});
  assert.equal((await add(file, 'node-a', pub)).code, 0);
  const r = await add(file, 'node-a', pub);
  assert.equal(r.code, 0);
  assert.match(r.out, /уже в реестре/);
  assert.equal(Object.keys(read(file)).filter((k) => k !== '//').length, 1);
});

test('не Ed25519-ключ в реестр не попадает', async () => {
  const file = registry({});
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  for (const junk of ['не-base64!!', Buffer.from('привет').toString('base64'), rsa]) {
    const r = await add(file, 'node-junk', junk);
    assert.equal(r.code, 1, `мусор «${junk.slice(0, 12)}…» не должен приниматься`);
  }
  assert.equal(Object.keys(read(file)).filter((k) => k !== '//').length, 0);
});

test('служебный ключ «//» и мусорный id отбиваются (иначе затрём комментарий реестра)', async () => {
  const file = registry({});
  assert.equal((await add(file, '//', pubOf())).code, 1);
  assert.equal((await add(file, 'плохой id с пробелом', pubOf())).code, 1);
  assert.equal(read(file)['//'], 'реестр');
});
