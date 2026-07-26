#!/usr/bin/env node
// Передача СЕКРЕТОВ по agent-bus в зашифрованном виде («запечатанный конверт»).
//
// ЗАЧЕМ. Канон запрещал слать креды по шине, и по делу: персистер пишет ВСЕ входящие в
// ~/.agent-bus/<id>.log ОТКРЫТЫМ ТЕКСТОМ навсегда, плюс они лежат в Redis 7 дней. Голый токен
// в шине = токен в плейнтекст-логах на всех нодах. Здесь это чинится по существу: по шине летит
// ШИФРОТЕКСТ, расшифровать может ТОЛЬКО приватный ключ адресата, который машину не покидает.
// Шифротекст в логе безвреден — он бесполезен без ключа.
//
// КРИПТА (только встроенный node:crypto, без зависимостей) — аналог libsodium sealed box:
//   эфемерная X25519-пара → ECDH с enc-ключом адресата → HKDF-SHA256 → AES-256-GCM.
//   Эфемерность даёт forward secrecy: скомпрометировали ключ позже — старые конверты не читаются.
//   GCM даёт целостность: подмена шифротекста в логе не пройдёт (провалится authTag).
//
// ПОЧЕМУ ОТДЕЛЬНЫЕ КЛЮЧИ, а не существующие Ed25519: Ed25519 — подписной алгоритм (доказать КТО
// отправил), для шифрования не годится. X25519 — обмен ключами (скрыть ЧТО отправлено). Разные
// задачи — разные ключи. Ed25519-подпись остаётся сверху: она подтверждает отправителя конверта.
//
// ИСПОЛЬЗОВАНИЕ:
//   node mcp/seal.js keygen                  — создать свою enc-пару (приватный ключ локально, 1 раз)
//   node mcp/seal.js pub                     — показать СВОЙ публичный enc-ключ (его можно слать по шине)
//   node mcp/seal.js seal <pubkey-b64>       — прочитать секрет из stdin → выдать конверт (base64)
//   node mcp/seal.js open                    — прочитать конверт из stdin → выдать секрет в stdout
//   node mcp/seal.js open --to <файл>        — расшифровать СРАЗУ В ФАЙЛ (секрет не появится в консоли/логе)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = (process.env.AGENT_ID || process.env.FLEET_NODE_ID || 'desktop-tt4i69c').trim();
const DIR = path.join(os.homedir(), '.agent-bus');
const ENC_PRIV = process.env.AGENT_ENC_KEY_FILE || path.join(DIR, `${ID}.enc.key`);
const INFO = Buffer.from('llm-fleet/secret-envelope/v1');   // домен HKDF: ключ не переиспользуется в другом контексте

function loadPriv() {
  try { return crypto.createPrivateKey(fs.readFileSync(ENC_PRIV)); } catch (_) { return null; }
}

// Закрыть файл от посторонних. На Windows chmod(600) НЕ работает (git-bash показывает 644,
// реально правами рулят ACL) — поэтому на win дополнительно снимаем наследование и оставляем
// доступ только текущему пользователю. На unix достаточно chmod.
function restrict(file) {
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(
        `icacls "${file}" /inheritance:r /grant:r "%USERNAME%:(R,W)"`,
        { stdio: 'ignore', windowsHide: true, shell: 'cmd.exe' });
    } catch (_) {}
  }
}

// Своя enc-пара. Приватный — только локально; публичный отдаём кому угодно (он на то и публичный).
function keygen({ force = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(ENC_PRIV) && !force) return { created: false, pub: myPub() };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  fs.writeFileSync(ENC_PRIV, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  restrict(ENC_PRIV);
  return { created: true, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

function myPub() {
  const k = loadPriv(); if (!k) return null;
  return crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).toString('base64');
}

// Запечатать секрет в адрес публичного enc-ключа. Результат безопасно кидать в durable-лог.
function seal(recipientPubB64, plaintext) {
  const recipient = crypto.createPublicKey({
    key: Buffer.from(recipientPubB64, 'base64'), format: 'der', type: 'spki',
  });
  const eph = crypto.generateKeyPairSync('x25519');                       // эфемерная пара на ОДИН конверт
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephPubDer = eph.publicKey.export({ format: 'der', type: 'spki' });
  // соль привязывает ключ к конкретному эфемерному ключу; INFO разделяет домены применения
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, ephPubDer, INFO, 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return JSON.stringify({
    v: 1, epk: ephPubDer.toString('base64'), iv: iv.toString('base64'),
    ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'),
  });
}

// Распечатать своим приватным ключом. Бросает, если конверт не наш или подменён (GCM authTag).
function open(envelopeJson) {
  const priv = loadPriv();
  if (!priv) throw new Error(`нет enc-ключа (${ENC_PRIV}) — сделай: node mcp/seal.js keygen`);
  const e = typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
  if (e.v !== 1) throw new Error(`неизвестная версия конверта: ${e.v}`);
  const epk = crypto.createPublicKey({ key: Buffer.from(e.epk, 'base64'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: epk });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(e.epk, 'base64'), INFO, 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
}

module.exports = { keygen, myPub, seal, open, ENC_PRIV };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const readStdin = () => new Promise((res) => {
    let b = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { b += d; }).on('end', () => res(b.trim()));
  });

  (async () => {
    if (cmd === 'keygen') {
      const r = keygen({ force: rest.includes('--force') });
      console.log(r.created ? '✅ enc-пара создана' : 'ℹ️  enc-ключ уже есть (--force чтобы пересоздать)');
      console.log(`   приватный: ${ENC_PRIV} (локально, НЕ слать никуда)`);
      console.log(`   публичный (его можно слать по шине):\n${r.pub}`);
    } else if (cmd === 'pub') {
      const p = myPub();
      if (!p) { console.error('нет ключа — сделай: node mcp/seal.js keygen'); process.exit(1); }
      console.log(p);
    } else if (cmd === 'seal') {
      const pub = rest[0];
      if (!pub) { console.error('нужен публичный enc-ключ адресата: node mcp/seal.js seal <pubkey-b64>'); process.exit(1); }
      const secret = await readStdin();
      if (!secret) { console.error('пустой stdin — нечего запечатывать'); process.exit(1); }
      console.log(seal(pub, secret));
    } else if (cmd === 'open') {
      const env = await readStdin();
      const out = open(env);
      const i = rest.indexOf('--to');
      if (i >= 0 && rest[i + 1]) {
        const dest = rest[i + 1].replace(/^~/, os.homedir());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out.endsWith('\n') ? out : out + '\n', { mode: 0o600 });
        restrict(dest);   // на Windows chmod не работает — закрываем ACL'ом
        console.log(`✅ секрет записан в ${dest} (в консоль/лог не попал)`);
      } else {
        process.stdout.write(out + '\n');
      }
    } else {
      console.log(`Передача секретов по шине в зашифрованном виде.

  node mcp/seal.js keygen              создать свою enc-пару (один раз)
  node mcp/seal.js pub                 показать свой публичный enc-ключ
  echo "СЕКРЕТ" | node mcp/seal.js seal <pubkey-b64>    запечатать
  node mcp/seal.js open --to ~/.tg/tg.env               распечатать сразу в файл

Приватный ключ (${ENC_PRIV}) машину НЕ покидает. По шине летит только шифротекст.`);
    }
  })().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
}
