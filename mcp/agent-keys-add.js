#!/usr/bin/env node
// Признание нового агента: добавляет ОДИН публичный ключ в mcp/agent-keys.json.
//
// Это единственная точка выдачи прав на шине. Правило владельца: подписанное сообщение = полноценная
// авторизация ⇒ запись сюда — не «настройка связи», а вручение мандата. Поэтому шаг остаётся ЯВНЫМ
// действием владельца на хабе, а бутстрап новой машины лишь ГОТОВИТ эту команду. Если бы бутстрап
// вписывал себя сам, любая машина, дотянувшаяся до раздатчика, выписала бы себе право командовать
// остальными — «внутри VPN» этого не отменяет.
//
//   node mcp/agent-keys-add.js <agent-id> <base64-pubkey>
//
// Гарантии: ничего не удаляет и не переписывает; занятый id с ДРУГИМ ключом → отказ (это либо опечатка
// в id, либо попытка подменить существующего агента); тот же ключ повторно → «уже есть», код 0.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.AGENT_KEYS_FILE || path.join(__dirname, 'agent-keys.json');
const [id, pub] = process.argv.slice(2);

if (!id || !pub) {
  console.error('usage: node mcp/agent-keys-add.js <agent-id> <base64-pubkey>');
  process.exit(1);
}
if (id === '//') { console.error('✗ "//" — это поле-комментарий реестра, не id агента'); process.exit(1); }
if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
  console.error(`✗ подозрительный agent-id «${id}»: ожидаются буквы/цифры/.-_ (1–64 символа)`);
  process.exit(1);
}

// Ключ обязан быть настоящим Ed25519 SPKI — иначе мы запишем мусор, а провал вылезет
// потом и в чужом месте («BAD» у получателя вместо «ключ не тот» здесь).
try {
  const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`тип ${key.asymmetricKeyType}, а нужен ed25519`);
} catch (e) {
  console.error(`✗ это не публичный Ed25519-ключ в base64 SPKI DER: ${e.message}`);
  process.exit(1);
}

let reg;
try {
  reg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`✗ не читается реестр ${FILE}: ${e.message}`);
  process.exit(1);
}

if (reg[id] === pub) {
  console.log(`ℹ «${id}» уже в реестре с этим же ключом — ничего не меняю.`);
  process.exit(0);
}
if (reg[id]) {
  console.error(`✗ id «${id}» ЗАНЯТ другим ключом (${reg[id].slice(0, 16)}…).`);
  console.error('  Ничего не переписываю: это либо опечатка в id, либо подмена существующего агента.');
  console.error('  Если машина переустановлена и ключ действительно новый — удали строку вручную,');
  console.error('  осознав, что старая подпись перестанет проверяться.');
  process.exit(2);
}

// Дописываем в конец, сохраняя порядок и комментарий-заголовок. Ничего не сортируем и не удаляем.
reg[id] = pub;
fs.writeFileSync(FILE, JSON.stringify(reg, null, 2) + '\n');
console.log(`✅ «${id}» добавлен в ${FILE}`);
console.log(`   агентов в реестре: ${Object.keys(reg).filter((k) => k !== '//').length}`);
console.log('\nДальше (иначе новичок останется невидим для остальных — рассылка идёт ПО РЕЕСТРУ, не по онлайну):');
console.log(`   git -C ${path.dirname(path.dirname(FILE))} add mcp/agent-keys.json && git commit -m "bus: признан ${id}" && git push`);
console.log(`   node mcp/bus-send.js all "[FLEET-SYNC] в реестр добавлен ${id}. git pull."`);
