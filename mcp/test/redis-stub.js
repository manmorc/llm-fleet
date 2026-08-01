// Заглушка ioredis для регресс-тестов шины: уровень A обязан проходить на машине БЕЗ Redis
// (в т.ч. на ноутбуке в самолёте и в CI). Подменяем модуль в require.cache/Module._load —
// тот же приём, что в trading_portal/backend/test (stub(rel, exports)).
//
// Используется двумя способами:
//   1) как preload дочернего процесса:  node -r mcp/test/redis-stub.js mcp/agent-bus.js
//      (сид состояния — env REDIS_STUB_SEED, дамп после выхода — env REDIS_STUB_DUMP);
//   2) как обычный модуль в тесте:      require('./test/redis-stub').install() → доступ к store.
//
// Реализовано РОВНО то, что шина реально зовёт: set/get/keys/del/rpush/lrange/ltrim/expire/lrem/
// blpop/quit/disconnect. Ничего лишнего: заглушка, которая умеет больше боевого кода, врёт о покрытии.
const Module = require('module');
const fs = require('fs');

const store = { str: new Map(), list: new Map() };   // str: key→{v,exp} · list: key→[строки]
const calls = [];                                    // журнал вызовов (тесты проверяют, ЧТО звали)

const now = () => Date.now();
function alive(k) {
  const e = store.str.get(k);
  if (!e) return null;
  if (e.exp && e.exp <= now()) { store.str.delete(k); return null; }
  return e;
}
const toRe = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

class RedisStub {
  constructor(url, opts) { this.url = url; this.opts = opts || {}; this.status = 'ready'; calls.push(['new', url]); }
  on() { return this; }
  once() { return this; }
  removeAllListeners() { return this; }
  async set(k, v, ...rest) {
    calls.push(['set', k]);
    const ix = rest.findIndex((x) => String(x).toUpperCase() === 'EX');
    store.str.set(k, { v: String(v), exp: ix >= 0 ? now() + Number(rest[ix + 1]) * 1000 : 0 });
    return 'OK';
  }
  async get(k) { const e = alive(k); calls.push(['get', k]); return e ? e.v : null; }
  async ttl(k) { const e = alive(k); if (!e) return -2; return e.exp ? Math.ceil((e.exp - now()) / 1000) : -1; }
  async keys(pat) { calls.push(['keys', pat]); const re = toRe(pat); return [...store.str.keys()].filter((k) => alive(k) && re.test(k)); }
  async del(k) { calls.push(['del', k]); const had = store.str.delete(k) || store.list.delete(k); return had ? 1 : 0; }
  async rpush(k, ...vals) { calls.push(['rpush', k, vals[0]]); const l = store.list.get(k) || []; l.push(...vals.map(String)); store.list.set(k, l); return l.length; }
  async lrange(k, a, b) {
    const l = store.list.get(k) || [];
    const n = l.length;
    const i = a < 0 ? Math.max(0, n + a) : a;
    const j = b < 0 ? n + b : Math.min(b, n - 1);
    return l.slice(i, j + 1);
  }
  async ltrim(k, a, b) { store.list.set(k, await this.lrange(k, a, b)); return 'OK'; }
  async lrem(k, count, val) {
    const l = store.list.get(k) || [];
    const keep = []; let removed = 0;
    for (const x of l) { if (x === String(val) && (count === 0 || removed < Math.abs(count))) { removed++; continue; } keep.push(x); }
    store.list.set(k, keep);
    return removed;
  }
  async expire(k, sec) { calls.push(['expire', k, sec]); const e = store.str.get(k); if (e) e.exp = now() + sec * 1000; return 1; }
  async blpop(k, _timeout) { const l = store.list.get(k) || []; if (!l.length) return null; return [k, l.shift()]; }
  async quit() { this.status = 'end'; return 'OK'; }
  disconnect() { this.status = 'end'; }
}
RedisStub.default = RedisStub;
RedisStub.Redis = RedisStub;

// Подменяем 'ioredis' до того, как его затребует тестируемый модуль.
function install() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'ioredis') return RedisStub;
    return origLoad.call(this, request, parent, isMain);
  };
  return { store, calls, RedisStub };
}
install();

// ── режим preload: сид состояния из env + дамп в файл при выходе ──
// Дамп нужен, чтобы тест увидел ПОБОЧНЫЙ ЭФФЕКТ (кому реально сделали rpush), а не только текст ответа:
// «broadcast отрапортовал успех» уже один раз оказалось неправдой — проверяем ящики, а не отчёт.
if (process.env.REDIS_STUB_SEED) {
  const seed = JSON.parse(process.env.REDIS_STUB_SEED);
  for (const [k, v] of Object.entries(seed.str || {})) store.str.set(k, { v: typeof v === 'string' ? v : JSON.stringify(v), exp: 0 });
  for (const [k, v] of Object.entries(seed.list || {})) store.list.set(k, v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
}
if (process.env.REDIS_STUB_DUMP) {
  process.on('exit', () => {
    try {
      fs.writeFileSync(process.env.REDIS_STUB_DUMP, JSON.stringify({
        str: Object.fromEntries(store.str), list: Object.fromEntries(store.list), calls,
      }));
    } catch (_) {}
  });
}

module.exports = { install, store, calls, RedisStub };
