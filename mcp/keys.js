// Подпись/проверка сообщений agent-bus (Ed25519, нативный node crypto, без зависимостей).
// Аутентификация ОТПРАВИТЕЛЯ: from в JSON — self-asserted; пароль Redis общий → любой форжит from.
// Фикс: отправитель подписывает своим приватным ключом; получатель проверяет против known pubkey из реестра.
// Приватный ключ — ЛОКАЛЬНО (файл ~/.agent-bus/agent.key, chmod600, per-machine). Публичные — в agent-keys.json
// (в репо; публичные ключи не секрет). Trust-anchor = реестр pubkey'ев (владелец ревьюит добавления).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const KEYDIR = path.join(os.homedir(), '.agent-bus');
const PRIV_FILE = process.env.AGENT_PRIVKEY_FILE || path.join(KEYDIR, 'agent.key');
// Реестр: репо + локальный override. AGENT_KEYS_FILE — ЯВНАЯ замена обоих (изолированный узел, тесты):
// без неё регресс-тесты на broadcast/подпись зависели бы от того, что лежит в $HOME у прогоняющего.
const REGS = process.env.AGENT_KEYS_FILE
  ? [process.env.AGENT_KEYS_FILE]
  : [path.join(__dirname, 'agent-keys.json'), path.join(KEYDIR, 'agent-keys.json')];

function loadPriv() { try { return crypto.createPrivateKey(fs.readFileSync(PRIV_FILE)); } catch (_) { return null; } }
function registry() {
  const r = {};
  for (const f of REGS) { try { Object.assign(r, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) {} }
  return r;
}
// Каноничная строка под подпись — то, что аутентифицируем: кто, когда, что. (to не подписываем → broadcast-совместимо.)
function canon(m) { return `${m.from}\n${m.ts}\n${m.text}`; }

function sign(m) { const k = loadPriv(); if (!k) return null; try { return crypto.sign(null, Buffer.from(canon(m)), k).toString('base64'); } catch (_) { return null; } }

// → 'ok' | 'unsigned' | 'unknown-key' | 'BAD'
function verify(m) {
  if (!m || !m.sig) return 'unsigned';
  const pub = registry()[m.from];
  if (!pub) return 'unknown-key';
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canon(m)), key, Buffer.from(m.sig, 'base64')) ? 'ok' : 'BAD';
  } catch (_) { return 'BAD'; }
}
function myPub() { const k = loadPriv(); if (!k) return null; try { return crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).toString('base64'); } catch (_) { return null; } }

module.exports = { sign, verify, myPub, canon, registry, PRIV_FILE };
