#!/usr/bin/env node
// Генерация Ed25519-ключа агента. Приватный → ~/.agent-bus/agent.key (chmod600, локально, не коммитить).
// Публичный печатается — добавить в mcp/agent-keys.json (владелец ревьюит). Использование:
//   AGENT_ID=mac-artyom node mcp/keygen.js         (или node mcp/keygen.js <id>)
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ID = (process.argv[2] || process.env.AGENT_ID || os.hostname()).trim();
const dir = path.join(os.homedir(), '.agent-bus'); fs.mkdirSync(dir, { recursive: true });
const priv = process.env.AGENT_PRIVKEY_FILE || path.join(dir, 'agent.key');
if (fs.existsSync(priv) && process.argv[3] !== '--force') { console.error(`уже есть ${priv} (--force чтобы перегенерить — сломает старую подпись!)`); process.exit(1); }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(priv, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
console.log(`✅ privkey → ${priv} (chmod 600, локально)`);
console.log(`\nДобавь в mcp/agent-keys.json (публичный ключ, безопасно коммитить):`);
console.log(`  "${ID}": "${pub}"`);
