// RAG-ядро: sqlite-vec store + эмбеддинги + чанкер + фильтр приватного. Общий для server/ingest.
// Приватность: НИЧЕГО секретного (токены/ключи/сид-фразы/пароли) не индексируем — фильтр ниже.
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EMBED_DIM = parseInt(process.env.RAG_EMBED_DIM || '768', 10);          // nomic-embed-text = 768
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'nomic-embed-text';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DB_PATH = process.env.RAG_DB || path.join(os.homedir(), '.rag', 'archive.db');

// ---------- приватность: секреты НЕ индексируем ----------
// Если чанк содержит секрет — по умолчанию ПРОПУСКАЕМ (skip). Настройка RAG_SECRET_MODE=redact → маскируем.
const SECRET_PATTERNS = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,                 // telegram bot token
  /0x[0-9a-fA-F]{64}\b/,                            // eth privkey / 32-byte hex
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,           // btc WIF privkey
  /\bsk-[A-Za-z0-9]{20,}\b/,                        // openai-style key
  /\b(sk-ant|AIza|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_\-]{16,}\b/, // anthropic/google/github/slack
  /redis:\/\/[^@\s]*:[^@\s]+@/,                     // redis url with password
  /\b(?:[a-z]+\s){11,23}[a-z]+\b/i,                 // возможная BIP39 сид-фраза (12-24 слова) — груб, но лучше пропустить
  /\b(pass(word)?|secret|token|api[_-]?key|private[_-]?key|seed|mnemonic)\s*[:=]\s*\S+/i,
];
function scanSecret(text) { return SECRET_PATTERNS.some((re) => re.test(text)); }
function sanitize(text, mode = process.env.RAG_SECRET_MODE || 'skip') {
  if (!scanSecret(text)) return text;
  if (mode === 'redact') {
    let t = text;
    for (const re of SECRET_PATTERNS) t = t.replace(new RegExp(re, 'g' + (re.flags.includes('i') ? 'i' : '')), '⟨REDACTED⟩');
    return t;
  }
  return null; // skip
}

// ---------- чанкер ----------
function chunk(text, { size = 1200, overlap = 200 } = {}) {
  const clean = String(text).replace(/\r/g, '').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/);
  const out = []; let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > size) {
      flush();
      if (p.length > size) { // абзац сам длинный — режем с нахлёстом
        for (let i = 0; i < p.length; i += size - overlap) out.push(p.slice(i, i + size));
      } else buf = p;
    } else buf = buf ? buf + '\n\n' + p : p;
  }
  flush();
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------- эмбеддинги (ollama, локально) ----------
// pluggable: RAG_FAKE_EMBED=1 → детерминированный хеш-эмбеддинг (для тестов без ollama).
async function embed(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (process.env.RAG_FAKE_EMBED === '1') {
    return arr.map((t) => {
      const v = new Array(EMBED_DIM).fill(0);
      const h = crypto.createHash('sha256').update(t).digest();
      for (let i = 0; i < EMBED_DIM; i++) v[i] = ((h[i % h.length] / 255) * 2 - 1);
      const n = Math.hypot(...v) || 1; return v.map((x) => x / n);
    });
  }
  const out = [];
  for (const t of arr) {
    const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: t }),
    });
    if (!r.ok) throw new Error(`ollama embed ${r.status}: ${await r.text().catch(() => '')}`);
    const j = await r.json();
    if (!j.embedding) throw new Error('ollama: no embedding (модель ' + EMBED_MODEL + ' стянута?)');
    out.push(j.embedding);
  }
  return out;
}

// ---------- store (sqlite-vec) ----------
function openDb() {
  const fs = require('fs'); fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const Database = require('better-sqlite3');
  const sqliteVec = require('sqlite-vec');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      scope TEXT, source TEXT, path TEXT, title TEXT, ord INTEGER,
      text TEXT, hash TEXT UNIQUE, ts INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${EMBED_DIM}]);
  `);
  return db;
}
function toBlob(vec) { return Buffer.from(new Float32Array(vec).buffer); }

// ingest: items = [{scope, source, path, title, text, ts}]
async function ingest(db, items) {
  let added = 0, skipped = 0, secret = 0;
  const insC = db.prepare(`INSERT OR IGNORE INTO chunks (scope,source,path,title,ord,text,hash,ts) VALUES (?,?,?,?,?,?,?,?)`);
  const insV = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);
  const exists = db.prepare(`SELECT id FROM chunks WHERE hash = ?`);
  for (const it of items) {
    const parts = chunk(it.text || '');
    for (let i = 0; i < parts.length; i++) {
      const safe = sanitize(parts[i]);
      if (safe === null) { secret++; continue; }
      const h = sha((it.source || '') + '|' + (it.path || '') + '|' + safe);
      if (exists.get(h)) { skipped++; continue; }
      const [emb] = await embed([safe]);
      const info = insC.run(it.scope || 'personal', it.source || 'unknown', it.path || '', it.title || '', i, safe, h, it.ts || Date.now());
      if (!info.changes) { skipped++; continue; }
      insV.run(BigInt(info.lastInsertRowid), toBlob(emb));
      added++;
    }
  }
  return { added, skipped, secret };
}

async function search(db, query, { scope, k = 6 } = {}) {
  const [qemb] = await embed([query]);
  const rows = db.prepare(`
    SELECT c.id, c.scope, c.source, c.path, c.title, c.text, v.distance
    FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ? ${scope ? 'AND c.scope = ?' : ''}
    ORDER BY v.distance
  `).all(toBlob(qemb), k, ...(scope ? [scope] : []));
  return rows.map((r) => ({ score: +(1 - r.distance).toFixed(3), scope: r.scope, source: r.source, path: r.path, title: r.title, text: r.text }));
}

module.exports = { EMBED_DIM, DB_PATH, openDb, ingest, search, embed, chunk, sanitize, scanSecret, sha };
